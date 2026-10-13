import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FileAdapter } from "../../src/adapters/files.ts";
import { coalesceNativeUpdates } from "../../src/adapters/native-updates.ts";
import { createStore } from "../../src/store/index.ts";
import { config as defaults } from "../../test/fixtures/basic.ts";
import type { BookkeepingConfig, CollectRequest, CollectionBatch } from "../../src/contracts/types.ts";

const request: CollectRequest = { lane: "live", cutoff: "2026-10-07T12:00:00Z",
  range: { schema_version: 1, from: "2026-10-07T00:00:00Z", to: "2026-10-07T12:00:00Z" },
  budget: { max_duration_ms: 10000, max_bytes: 64 * 1024 * 1024, max_directory_entries: 20 } };
const row = (stop: string | null, id = "synthetic-message", body = "Synthetic stable completion", timestamp = "2026-10-07T09:00:00Z") =>
  JSON.stringify({ type: "assistant", sessionId: "synthetic-session", uuid: "synthetic-record", timestamp,
    message: { id, role: "assistant", content: [{ type: "text", text: body }], stop_reason: stop } }) + "\n";
const header = JSON.stringify({ type: "progress", sessionId: "synthetic-session" }) + "\n";
async function fixture(t: test.TestContext, text: string) {
  const root = await mkdtemp(join(tmpdir(), "bookkeeping-claude-completion-"));
  const sources = join(root, "sources");
  await mkdir(sources);
  const path = join(sources, "session.jsonl");
  await writeFile(path, header + text);
  const config: BookkeepingConfig = { ...defaults, data_dir: join(root, "data"), wiki_root: join(root, "wiki"),
    providers: [{ schema_version: 1, provider: "claude", account_id: "synthetic-owner", enabled: true, roots: [sources], options: {} }] };
  const store = await createStore(config);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  async function collect(lane: "live" | "history" = "live") {
    const checkpoints = [...await store.getCheckpoints("claude", "live"), ...await store.getCheckpoints("claude", "history")];
    const adapter = new FileAdapter(config.providers[0], config);
    const batches: CollectionBatch[] = [];
    try {
      for await (const batch of adapter.collect({ ...request, lane }, { config, checkpoints })) {
        batches.push(batch);
        await store.saveCollection(batch);
      }
    } finally { await adapter.close(); }
    return batches;
  }
  const visible = () => store.listEvents({ range: request.range, source: "claude" });
  const reviewable = () => store.getReviewableEvents({ range: request.range, source: "claude" }, "daily");
  return { root, path, config, store, collect, visible, reviewable };
}

test("same-batch Claude native completion wins without changing event identity or discarding raw records", async t => {
  const f = await fixture(t, row(null) + row("end_turn"));
  const batches = await f.collect();
  const events = batches.flatMap(batch => batch.events);
  assert.equal(events.length, 1);
  assert.equal(events[0].context.turn_complete, true);
  assert.equal(events[0].context.stop_reason, "end_turn");
  assert.equal((await f.visible()).length, 1);
  assert.equal((await f.reviewable()).length, 1);
  const fragments = batches.flatMap(batch => batch.fragments).map(fragment => Buffer.from(fragment.bytes_base64, "base64").toString());
  assert.ok(fragments.some(fragment => fragment.includes('"stop_reason":null')));
  assert.ok(fragments.some(fragment => fragment.includes('"stop_reason":"end_turn"')));
  const retained = batches.flatMap(batch => batch.fragments).find(fragment => fragment.fragment_id === events[0].fragment_ref)!;
  assert.ok(Buffer.from(retained.bytes_base64, "base64").toString().includes('"stop_reason":null'));
  const incomplete = { ...events[0], context: { stop_reason: null, cwd: events[0].context.cwd, turn_complete: false } };
  const complete = { ...events[0], context: { turn_complete: true, stop_reason: "end_turn", cwd: events[0].context.cwd } };
  const reordered = coalesceNativeUpdates([incomplete, complete]);
  assert.equal(reordered.gaps.length, 0);
  assert.equal(reordered.events[0].context.turn_complete, true);
});

test("Claude completion crosses atomic source quanta and recent native ID dedup in the same collection", async t => {
  const f = await fixture(t, row(null) + "\n".repeat(5 * 1024 * 1024) + row("end_turn"));
  const batches = await f.collect("history");
  const eventBatches = batches.filter(batch => batch.events.length);
  assert.equal(eventBatches.length, 2);
  assert.equal(eventBatches[0].events[0].event_id, eventBatches[1].events[0].event_id);
  assert.equal((await f.visible()).length, 1);
  assert.equal((await f.visible())[0].context.turn_complete, true);
  assert.equal((await f.reviewable()).length, 1);
});

test("appended Claude completion survives fresh adapter and SQLite process restart with one reviewable native event", async t => {
  const f = await fixture(t, row(null));
  await f.collect();
  const original = (await f.visible())[0];
  assert.equal(original.context.turn_complete, false);
  assert.equal((await f.reviewable()).length, 0);
  await appendFile(f.path, row("end_turn"));
  const input = join(f.root, "synthetic-input.json");
  await writeFile(input, JSON.stringify({ config: f.config, request }));
  const child = spawnSync(process.execPath, [fileURLToPath(new URL("./claude-completion-process.ts", import.meta.url)), input], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const receipt = JSON.parse(child.stdout);
  assert.equal(receipt.emitted, 1);
  assert.equal(receipt.stored, 1);
  assert.equal(receipt.reviewable, 1);
  assert.equal(receipt.event_id, original.event_id);
  assert.equal((await f.visible())[0].context.turn_complete, true);
  await appendFile(f.path, row(null));
  await f.collect();
  assert.equal((await f.visible())[0].context.turn_complete, true);
});

test("Claude completion retains distinct native/body identities and leaves time conflict pending", async t => {
  const f = await fixture(t, row(null));
  await f.collect();
  const original = (await f.visible())[0];
  await appendFile(f.path, row("end_turn", "other-message") + row("end_turn", "synthetic-message", "Different synthetic body") +
    row("end_turn", "synthetic-message", "Synthetic stable completion", "2026-10-07T10:00:00Z"));
  await f.collect();
  const events = await f.visible();
  assert.equal(events.length, 3);
  assert.equal(events.find(event => event.event_id === original.event_id)!.context.turn_complete, false);
  assert.equal((await f.store.listWork("event_conflict", "pending")).length, 1);
});

test("same-batch Claude time conflict cannot promote completion and retains a local capture gap", async t => {
  const f = await fixture(t, row(null) + row("end_turn", "synthetic-message", "Synthetic stable completion", "2026-10-07T10:00:00Z"));
  const batches = await f.collect();
  assert.equal((await f.visible()).length, 1);
  assert.equal((await f.visible())[0].context.turn_complete, false);
  assert.ok(batches.flatMap(batch => batch.coverage).some(coverage => coverage.gaps.some(gap => gap.reason.startsWith("native_event_update_conflict:"))));
  const restarted = await f.collect();
  assert.ok(restarted.flatMap(batch => batch.coverage).some(coverage => coverage.gaps.some(gap => gap.reason.startsWith("native_event_update_conflict:"))));
});

test("Claude stop_reason completion does not erase an independent incomplete turn marker", async t => {
  const f = await fixture(t, row(null));
  await f.collect();
  const original = (await f.visible())[0];
  await f.store.saveCollection({ schema_version: 1, batch_id: "synthetic-independent-incomplete", events: [{ ...original,
    context: { ...original.context, incomplete_turn: true } }], fragments: [], coverage: [], checkpoints: [] });
  await appendFile(f.path, row("end_turn"));
  await f.collect();
  const stored = (await f.visible())[0];
  assert.equal(stored.context.turn_complete, true);
  assert.equal(stored.context.incomplete_turn, true);
  assert.equal((await f.reviewable()).length, 0);
});
