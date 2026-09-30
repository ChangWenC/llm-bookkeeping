import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileAdapter } from "../../src/adapters/files.ts";
import { config as defaults } from "../../test/fixtures/basic.ts";
import type { BookkeepingConfig, CollectRequest, SourceCheckpoint } from "../../src/contracts/types.ts";

const MiB = 1024 * 1024;
const row = (id: string) => JSON.stringify({
  timestamp: "2026-09-30T12:00:00Z", type: "event_msg",
  payload: { type: "user_message", id, message: `synthetic ${id}` },
}) + "\n";
async function fixture(t: test.TestContext, splitLine = false) {
  const root = await mkdtemp(join(tmpdir(), "bookkeeping-file-budget-"));
  const file = join(root, "a.jsonl");
  const handle = await open(file, "w");
  await handle.write(Buffer.alloc(10 * MiB, 10));
  await handle.write(JSON.stringify({ type: "session_meta", payload: { id: "synthetic-session", source: "vscode" } }) + "\n", 0, "utf8");
  // Every reverse block contains a distinct event. A line crossing one block
  // boundary is owned by history until its terminating newline is captured.
  for (let block = 1; block < 10; block++)
    await handle.write(row(`block-${block}`), block * MiB + 100, "utf8");
  if (splitLine) await handle.write(row("split-boundary"), 9 * MiB - 40, "utf8");
  await handle.close();
  t.after(() => rm(root, { recursive: true, force: true }));
  const config: BookkeepingConfig = { ...defaults, providers: [{ schema_version: 1, provider: "codex", enabled: true, account_id: "synthetic", roots: [root], options: {} }] };
  const request: CollectRequest = {
    lane: "live", cutoff: "2026-09-30T21:30:00Z",
    range: { schema_version: 1, from: "2026-09-30T00:00:00Z", to: "2026-09-30T21:30:00Z" },
    budget: { max_duration_ms: 10000, max_bytes: 64 * MiB, max_directory_entries: 2000 },
  };
  let checkpoints: SourceCheckpoint[] = [];
  const captured = new Map<string, string>();
  async function collect(lane: "live" | "history" = "live") {
    const adapter = new FileAdapter(config.providers[0], config);
    const batches = [];
    try { for await (const batch of adapter.collect({ ...request, lane }, { config, checkpoints })) batches.push(batch); }
    finally { await adapter.close(); }
    const updated = new Map(checkpoints.map(checkpoint => [checkpoint.checkpoint_id, checkpoint]));
    for (const batch of batches) {
      for (const checkpoint of batch.checkpoints) updated.set(checkpoint.checkpoint_id, checkpoint);
      for (const event of batch.events) captured.set(event.event_id, event.body!);
    }
    checkpoints = [...updated.values()];
    return batches;
  }
  return { file, root, request, collect, captured,
    replaceCheckpoints: (update: (values: SourceCheckpoint[]) => SourceCheckpoint[]) => { checkpoints = update(checkpoints); },
    checkpoint: (lane: string) => checkpoints.find(checkpoint => checkpoint.locator === file && checkpoint.lane === lane)!,
  };
}

async function deadlineAfterBlocks<T>(blocks: number, action: () => Promise<T>) {
  const original = Date.now;
  const start = original();
  let checks = 0;
  let elapsed = 0;
  Date.now = () => {
    if (new Error().stack?.includes("readTail") && ++checks === blocks + 1) elapsed = 20000;
    return start + elapsed;
  };
  try { return await action(); }
  finally { Date.now = original; }
}

test("tail deadline at every reverse block retains the entire unread prefix until history captures it", async t => {
  for (const blocks of [0, 1, 2, 4, 7, 8]) {
    const source = await fixture(t);
    await deadlineAfterBlocks(blocks, () => source.collect());
    assert.equal(source.checkpoint("live").cursor.history_end, (10 - blocks) * MiB, `blocks=${blocks}`);
    for (let round = 0; round < 12; round++) await source.collect("history");
    const final = await source.collect();
    assert.deepEqual([...source.captured.values()].sort(), Array.from({ length: 9 }, (_, index) => `synthetic block-${index + 1}`).sort());
    assert.equal(source.checkpoint("live").cursor.history_end, 0);
    assert.ok(final.flatMap(batch => batch.coverage).every(coverage => coverage.capture_status === "complete"));
  }
});

test("tail deadline inside a JSONL record assigns the full boundary line to history without a byte hole", async t => {
  const source = await fixture(t, true);
  await deadlineAfterBlocks(1, () => source.collect());
  assert.ok(Number(source.checkpoint("live").cursor.history_end) > 9 * MiB);
  for (let round = 0; round < 12; round++) await source.collect("history");
  await source.collect();
  assert.ok([...source.captured.values()].includes("synthetic split-boundary"));
  assert.equal(source.checkpoint("live").cursor.history_end, 0);
});

test("exhausted first-tail byte budget derives a complete anchor without changing native event identity next round", async t => {
  const source = await fixture(t);
  const handle = await open(source.file, "r+");
  await handle.write(row("native-budget-tail"), 10 * MiB - 256, "utf8");
  await handle.close();
  source.request.budget.max_bytes = MiB;
  const first = await source.collect();
  const native = first.flatMap(batch => batch.events).find(event => event.source.message_id === "native-budget-tail")!;
  assert.ok(native);
  assert.equal(source.checkpoint("live").cursor.anchor_length, 128);
  for (let round = 0; round < 3; round++) {
    const next = await source.collect();
    assert.equal(source.checkpoint("live").generation, native.generation);
    assert.ok(next.every(batch => batch.events.every(event => event.source.message_id !== "native-budget-tail")));
    assert.ok(next.flatMap(batch => batch.coverage).every(coverage => !coverage.gaps.some(gap => gap.reason === "source_truncated_or_rewritten_new_generation")));
  }
});

test("short anchor comparison and legacy empty/short witnesses stay pending without a false generation", async t => {
  const source = await fixture(t);
  await source.collect();
  const generation = source.checkpoint("live").generation;
  const fullAnchor = source.checkpoint("live").cursor.anchor;
  source.request.budget.max_bytes = 64 * 1024 + 17;
  const short = await source.collect();
  assert.equal(source.checkpoint("live").generation, generation);
  assert.equal(source.checkpoint("live").cursor.anchor, fullAnchor);
  assert.ok(short.flatMap(batch => batch.coverage).some(coverage => coverage.gaps.some(gap => gap.reason === "anchor_verification_budget_pending")));
  source.request.budget.max_bytes = 64 * MiB;
  for (const witness of ["e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "synthetic-old-short-hash"]) {
    source.replaceCheckpoints(values => values.map(checkpoint => checkpoint.locator !== source.file ? checkpoint : {
      ...checkpoint, cursor: { ...checkpoint.cursor, anchor: witness, anchor_length: undefined },
    }));
    const repaired = await source.collect();
    assert.equal(source.checkpoint("live").generation, generation);
    assert.equal(source.checkpoint("live").cursor.anchor, fullAnchor);
    assert.equal(source.checkpoint("live").cursor.anchor_length, 128);
    assert.ok(repaired.every(batch => batch.events.length === 0));
    assert.ok(repaired.flatMap(batch => batch.coverage).some(coverage => coverage.gaps.some(gap => gap.reason.startsWith("legacy_anchor_"))));
  }
  const complete = await source.collect();
  assert.equal(source.checkpoint("live").generation, generation);
  assert.ok(complete.flatMap(batch => batch.coverage).every(coverage => !coverage.gaps.some(gap => gap.reason.includes("anchor"))));
});

test("last of multiple files at provider byte limit saves only complete anchors and does not duplicate native IDs", async t => {
  const source = await fixture(t);
  const peer = await open(join(source.root, "peer.jsonl"), "w");
  await peer.write(Buffer.alloc(10 * MiB, 10));
  await peer.write(JSON.stringify({ type: "session_meta", payload: { id: "synthetic-peer", source: "vscode" } }) + "\n", 0, "utf8");
  await peer.write(row("native-peer-tail"), 10 * MiB - 256, "utf8");
  await peer.close();
  source.request.budget.max_bytes = 9 * MiB + 2 * 64 * 1024;
  const first = await source.collect();
  const identities = new Set(first.flatMap(batch => batch.events).map(event => event.event_id));
  assert.equal(source.checkpoint("live").cursor.anchor_length, 128);
  source.request.budget.max_bytes = 64 * MiB;
  const next = await source.collect();
  assert.ok(next.flatMap(batch => batch.events).every(event => !identities.has(event.event_id)));
  assert.ok(next.flatMap(batch => batch.checkpoints).filter(checkpoint => checkpoint.locator !== "@discovery").every(checkpoint => checkpoint.generation === "0" && checkpoint.cursor.anchor_length === 128));
});

test("a complete anchor mismatch still opens a generation for a same-size source rewrite", async t => {
  const source = await fixture(t);
  await source.collect();
  assert.equal(source.checkpoint("live").cursor.anchor_length, 128);
  const handle = await open(source.file, "r+");
  await handle.write("synthetic footer changed\n", 10 * MiB - 64, "utf8");
  await handle.close();
  const next = await source.collect();
  assert.notEqual(source.checkpoint("live").generation, "0");
  assert.ok(next.flatMap(batch => batch.coverage).some(coverage => coverage.gaps.some(gap => gap.reason === "source_truncated_or_rewritten_new_generation")));
});
