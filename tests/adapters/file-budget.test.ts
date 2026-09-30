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
  return { file, request, collect, captured, checkpoint: (lane: string) => checkpoints.find(checkpoint => checkpoint.locator === file && checkpoint.lane === lane)! };
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
