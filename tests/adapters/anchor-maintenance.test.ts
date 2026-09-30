import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FileAdapter } from "../../src/adapters/files.ts";
import { reportAnchors, applyAnchors, anchorPlanSha256 } from "../../src/adapters/anchor-maintenance.ts";
import { createStore } from "../../src/store/index.ts";
import { config as defaults } from "../../test/fixtures/basic.ts";
import type { BookkeepingConfig, SourceCheckpoint } from "../../src/contracts/types.ts";

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
async function fixture(t: test.TestContext, saveEvidence = true) {
  const directory = await mkdtemp(join(tmpdir(), "bookkeeping-anchor-maintenance-"));
  const root = join(directory, "sources"), source = join(root, "session.jsonl");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(root);
  const text = JSON.stringify({ type: "session_meta", payload: { id: "synthetic-session", source: "vscode" } }) + "\n" +
    JSON.stringify({ timestamp: "2026-09-30T12:00:00Z", type: "event_msg",
      payload: { type: "user_message", id: "synthetic-native", message: "synthetic ".repeat(40) } }) + "\n";
  await writeFile(source, text);
  const config: BookkeepingConfig = { ...defaults, data_dir: join(directory, "data"), wiki_root: join(directory, "wiki"),
    providers: [{ schema_version: 1, provider: "codex", enabled: true, account_id: "synthetic", roots: [root], options: {} }] };
  const store = await createStore(config);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const adapter = new FileAdapter(config.providers[0], config);
  for await (const batch of adapter.collect({ lane: "live", cutoff: "2026-09-30T13:00:00Z",
    range: { schema_version: 1, from: "2026-09-30T00:00:00Z", to: "2026-09-30T13:00:00Z" },
    budget: { max_duration_ms: 10000, max_bytes: 1048576, max_directory_entries: 20 } }, { config, checkpoints: [] }))
    await store.saveCollection(saveEvidence ? batch : { ...batch, batch_id: batch.batch_id + ":no-evidence", events: [], fragments: [] });
  await adapter.close();
  const initial = (await store.getCheckpoints("codex", "live")).find(checkpoint => checkpoint.locator === source)!;
  const legacy: SourceCheckpoint = { ...initial, cursor: { ...initial.cursor, anchor: hash(Buffer.alloc(0)) } };
  delete legacy.cursor.anchor_length;
  const history: SourceCheckpoint = { ...legacy, checkpoint_id: "synthetic-history", lane: "history",
    cursor: { ...legacy.cursor, anchor_uncertainty: { from: (legacy.cursor.offset as number) - 128,
      to: legacy.cursor.offset, generation: legacy.generation, reason: "legacy_anchor_unproven" } } };
  await store.saveCollection({ schema_version: 1, batch_id: "synthetic-legacy-cursors", events: [], fragments: [], coverage: [], checkpoints: [legacy, history] });
  return { source, text, config, store, legacy, history, ids: [legacy.checkpoint_id, history.checkpoint_id],
    witnessIds: (store.db.prepare("SELECT id FROM fragments ORDER BY id").all() as any[]).map(row => row.id) };
}

test("anchor report is read-only and saved canonical evidence atomically reconciles only two explicit legacy checkpoints", async t => {
  const f = await fixture(t);
  const before = f.store.db.prepare("SELECT count(*) AS total FROM collections").get();
  const plan = await reportAnchors(f.config, f.ids, f.witnessIds);
  assert.deepEqual(f.store.db.prepare("SELECT count(*) AS total FROM collections").get(), before);
  assert.ok(plan.entries.every(entry => entry.status === "verified" && entry.witnesses.every(witness => witness.saved_sha256 === witness.current_sha256)));
  assert.ok(!JSON.stringify(plan).includes("synthetic "));
  assert.deepEqual(await applyAnchors(f.config, plan, anchorPlanSha256(plan), true), { updated: 2, pending: 0 });
  for (const lane of ["live", "history"] as const) {
    const checkpoint = (await f.store.getCheckpoints("codex", lane)).find(checkpoint => checkpoint.locator === f.source)!;
    const original = lane === "live" ? f.legacy : f.history;
    const expected = structuredClone(original);
    expected.cursor.anchor = hash(Buffer.from(f.text).subarray(-128));
    expected.cursor.anchor_length = 128;
    delete expected.cursor.anchor_uncertainty;
    assert.deepEqual(checkpoint, expected);
  }
  assert.equal((f.store.db.prepare("SELECT count(*) AS total FROM events").get() as any).total, 1);
});

test("anchor apply rejects a changed checkpoint preview and writes neither target", async t => {
  const f = await fixture(t);
  const plan = await reportAnchors(f.config, f.ids, f.witnessIds);
  const changed = { ...f.legacy, updated_at: "2026-09-30T14:00:00Z" };
  await f.store.saveCollection({ schema_version: 1, batch_id: "synthetic-concurrent-change", events: [], fragments: [], coverage: [], checkpoints: [changed] });
  await assert.rejects(applyAnchors(f.config, plan, anchorPlanSha256(plan), true), /Fresh verification differs/);
  assert.deepEqual((await f.store.getCheckpoints("codex", "history"))[0], f.history);
  assert.deepEqual((await f.store.getCheckpoints("codex", "live")).find(cp => cp.locator === f.source), changed);
});

test("anchor apply freshly detects source mismatch after a verified report without exposing body or advancing state", async t => {
  const f = await fixture(t);
  const plan = await reportAnchors(f.config, f.ids, f.witnessIds);
  const handle = await open(f.source, "r+");
  await handle.write("different synthetic", Buffer.byteLength(f.text) - 100, "utf8");
  await handle.close();
  const fresh = await reportAnchors(f.config, f.ids, f.witnessIds);
  assert.ok(fresh.entries.every(entry => entry.status === "pending" && entry.reason === "saved_current_anchor_mismatch"));
  await assert.rejects(applyAnchors(f.config, plan, anchorPlanSha256(plan), true), /Fresh verification differs/);
  assert.deepEqual((await f.store.getCheckpoints("codex", "history"))[0], f.history);
});

test("missing complete saved evidence and an uncertain earlier generation remain locally pending", async t => {
  const f = await fixture(t, false);
  let plan = await reportAnchors(f.config, f.ids, f.witnessIds);
  assert.ok(plan.entries.every(entry => entry.reason === "complete_saved_fragment_witness_missing"));
  assert.deepEqual(await applyAnchors(f.config, plan, anchorPlanSha256(plan), true), { updated: 0, pending: 2 });
  const changed = structuredClone(f.history);
  (changed.cursor.anchor_uncertainty as any).generation = "different-generation";
  await f.store.saveCollection({ schema_version: 1, batch_id: "synthetic-unproved-generation", events: [], fragments: [], coverage: [], checkpoints: [changed] });
  plan = await reportAnchors(f.config, [changed.checkpoint_id], f.witnessIds);
  assert.equal(plan.entries[0].reason, "uncertainty_range_not_proven");
});

test("anchor maintenance requires explicit single writer and exact preview SHA, and validates full saved fragment digest", async t => {
  const f = await fixture(t);
  const plan = await reportAnchors(f.config, f.ids, f.witnessIds);
  await assert.rejects(applyAnchors(f.config, plan, anchorPlanSha256(plan), false), /Single writer/);
  await assert.rejects(applyAnchors(f.config, plan, "0".repeat(64), true), /SHA mismatch/);
  // Deliberate corruption is confined to this synthetic database; the helper
  // itself has no SQL write path, and cannot trust a matching 128B subsection.
  for (const row of f.store.db.prepare("SELECT id,json FROM fragments").all() as any[]) {
    const fragment = JSON.parse(row.json);
    fragment.sha256 = "0".repeat(64);
    f.store.db.prepare("UPDATE fragments SET json=? WHERE id=?").run(JSON.stringify(fragment), row.id);
  }
  const fresh = await reportAnchors(f.config, f.ids, f.witnessIds);
  assert.ok(fresh.entries.every(entry => entry.reason === "complete_saved_fragment_witness_missing"));
  assert.deepEqual(await readFile(f.source, "utf8"), f.text);
});

test("coordinator CLI report and apply use a local preview and print counts only", async t => {
  const f = await fixture(t);
  const configPath = join(f.config.data_dir, "synthetic-config.json");
  const planPath = join(f.config.data_dir, "synthetic-plan.json");
  await writeFile(configPath, JSON.stringify(f.config));
  const tool = fileURLToPath(new URL("../../tools/reconcile-anchors.ts", import.meta.url));
  const report = spawnSync(process.execPath, [tool, "--config", configPath, "--report", "--checkpoint", f.ids[0],
    "--checkpoint", f.ids[1], ...f.witnessIds.flatMap(id => ["--witness-fragment", id]), "--output", planPath], { encoding: "utf8" });
  assert.equal(report.status, 0, report.stderr);
  const summary = JSON.parse(report.stdout);
  assert.deepEqual(Object.keys(summary).sort(), ["pending", "plan_sha256", "verified"]);
  assert.equal(summary.verified, 2);
  assert.equal(summary.pending, 0);
  const apply = spawnSync(process.execPath, [tool, "--config", configPath, "--apply", "--plan", planPath,
    "--expected-plan-sha", summary.plan_sha256, "--single-writer-confirmed"], { encoding: "utf8" });
  assert.equal(apply.status, 0, apply.stderr);
  assert.deepEqual(JSON.parse(apply.stdout), { updated: 2, pending: 0 });
});
