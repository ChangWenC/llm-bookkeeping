import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, open, rm, utimes, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FileAdapter } from "../../src/adapters/files.ts";
import { hash } from "../../src/adapters/common.ts";
import { config as defaults } from "../../test/fixtures/basic.ts";
import type { BookkeepingConfig, CollectRequest, SourceCheckpoint } from "../../src/contracts/types.ts";

const MiB = 1024 * 1024;
const cutoff = "2026-10-06T21:30:00Z";
const header = (id: string, extra = {}) => JSON.stringify({ type: "session_meta", payload: { id, cwd: "/synthetic/project", source: "vscode", ...extra } }) + "\n";
const user = (id: string, body = id) => JSON.stringify({ type: "event_msg", timestamp: "2026-10-06T12:00:00Z", payload: { type: "user_message", id, message: body } }) + "\n";
const paddingLine = JSON.stringify({ type: "noop", padding: "x".repeat(16 * 1024 - 29) }) + "\n";
const padding = Buffer.from(paddingLine.repeat(Math.ceil(MiB / Buffer.byteLength(paddingLine))));
async function appendPadding(file: string, blocks: number) {
  const handle = await open(file, "a");
  try { for (let block = 0; block < blocks; block++) await handle.write(padding); }
  finally { await handle.close(); }
}
async function fixture(t: test.TestContext, provider = "codex") {
  const root = await mkdtemp(join(tmpdir(), "bookkeeping-capture-repair-"));
  const sources = join(root, "sources");
  await mkdir(sources);
  t.after(() => rm(root, { recursive: true, force: true }));
  const config: BookkeepingConfig = { ...defaults, wiki_root: join(root, "wiki"), data_dir: join(root, "data"), providers: [{ schema_version: 1, provider, enabled: true, account_id: "synthetic", roots: [sources], options: { discovery_manifest_budget: { max_bytes: 16 * MiB, max_duration_ms: 10000 } } }] };
  const request: CollectRequest = { lane: "live", cutoff, range: { schema_version: 1, from: "2026-10-04T21:30:00Z", to: cutoff }, budget: { max_bytes: 512 * MiB, max_duration_ms: 300000, max_directory_entries: 8000 } };
  let checkpoints: SourceCheckpoint[] = [];
  async function round(generation_checkpoints?: SourceCheckpoint[]) {
    const events = [], coverage = [], advances = [], fragments = [];
    const saved = new Map(checkpoints.map(item => [item.checkpoint_id, item]));
    for await (const batch of new FileAdapter(config.providers[0], config).collect(request, { config, checkpoints, generation_checkpoints })) {
      events.push(...batch.events); coverage.push(...batch.coverage);
      fragments.push(...batch.fragments.map(fragment => ({ bytes: Buffer.from(fragment.bytes_base64, "base64").length, sha: fragment.sha256 })));
      for (const item of batch.checkpoints) { saved.set(item.checkpoint_id, item); if (item.locator !== "@discovery") advances.push(item); }
    }
    checkpoints = [...saved.values()];
    return { events, coverage, advances, fragments };
  }
  return { root, sources, config, request, round, checkpoint: (file: string) => checkpoints.find(item => item.locator === file && item.lane === request.lane)!, checkpoints: () => checkpoints, replace: (values: SourceCheckpoint[]) => { checkpoints = values; } };
}

test("configured live budget reads a known 100MiB append in fair ≤4MiB visits and ≤1MiB I/O beyond the old byte/time caps", async t => {
  const f = await fixture(t), file = join(f.sources, "known.jsonl");
  await writeFile(file, header("known") + user("initial")); await f.round();
  const offset = Number(f.checkpoint(file).cursor.offset);
  await appendFile(file, user("append-start"));
  await appendPadding(file, 100);
  await appendFile(file, user("append-tail"));
  const probe = await open(file, "r");
  const prototype = Object.getPrototypeOf(probe), originalRead = prototype.read, originalNow = Date.now;
  await probe.close();
  let actualBytes = 0, elapsed = 0;
  prototype.read = async function (...args: any[]) {
    assert.ok(args[2] <= MiB, `I/O request ${args[2]}`);
    const result = await originalRead.apply(this, args);
    actualBytes += result.bytesRead;
    if (actualBytes > 70 * MiB) elapsed = 100000;
    return result;
  };
  const started = originalNow(); Date.now = () => started + elapsed;
  let captured;
  try { captured = await f.round(); }
  finally { prototype.read = originalRead; Date.now = originalNow; }
  assert.ok(actualBytes > 100 * MiB, "finite configured budget exceeds the old 64MiB clamp");
  assert.deepEqual(captured.events.map(event => event.source.message_id), ["append-start", "append-tail"]);
  let previous = offset;
  for (const checkpoint of captured.advances) {
    assert.ok(Number(checkpoint.cursor.offset) - previous <= 4 * MiB);
    previous = Number(checkpoint.cursor.offset);
    assert.equal(checkpoint.generation, "0");
  }
  assert.equal(f.checkpoint(file).cursor.history_end, 0, "known append cannot tail-jump and create a prefix hole");
  assert.equal(f.checkpoint(file).cursor.unread_bytes, 0);
  assert.equal(f.checkpoint(file).cursor.account_id, "synthetic");
  assert.match(String(f.checkpoint(file).cursor.last_read_at), /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.equal(captured.coverage.at(-1)!.capture_status, "complete", "resolved same-call append gaps do not masquerade as remaining debt");
  const again = await f.round(); assert.equal(again.events.length, 0);
});

test("history respects configured 256MiB/180s rather than old 32MiB/30s limits", async t => {
  const f = await fixture(t), file = join(f.sources, "history.jsonl");
  await writeFile(file, header("history")); await appendPadding(file, 48); await appendFile(file, user("history-tail"));
  f.request.lane = "history"; f.request.budget = { max_bytes: 256 * MiB, max_duration_ms: 180000, max_directory_entries: 8000 };
  const probe = await open(file, "r"), prototype = Object.getPrototypeOf(probe), originalRead = prototype.read;
  await probe.close();
  const original = Date.now, started = original(); let readBytes = 0;
  prototype.read = async function (...args: any[]) {
    const result = await originalRead.apply(this, args); readBytes += result.bytesRead; return result;
  };
  Date.now = () => started + (readBytes > 16 * MiB ? 40000 : 0);
  let result; try { result = await f.round(); } finally { Date.now = original; prototype.read = originalRead; }
  assert.ok(readBytes > 32 * MiB);
  assert.ok(result.events.some(event => event.source.message_id === "history-tail"));
  assert.ok(Number(f.checkpoint(file).cursor.offset) > 48 * MiB);
});

test("cold known files retain their fair position across fresh processes despite a repeatedly hot mtime", async t => {
  const f = await fixture(t), hot = join(f.sources, "hot.jsonl"), cold = join(f.sources, "cold.jsonl");
  await writeFile(hot, header("hot")); await writeFile(cold, header("cold")); await f.round();
  await appendPadding(hot, 16); await appendFile(hot, user("hot-tail"));
  await appendPadding(cold, 8); await appendFile(cold, user("cold-tail"));
  f.request.budget.max_bytes = 2 * MiB;
  const execute = promisify(execFile), seen = new Set<string>(); let checkpoints = f.checkpoints();
  const positions = new Map<string, number>();
  for (let round = 0; round < 12; round++) {
    await appendFile(hot, user(`hot-${round}`)); await utimes(hot, new Date(), new Date());
    const input = join(f.root, "input.json"); await writeFile(input, JSON.stringify({ config: f.config, request: f.request, checkpoints }));
    const output = await execute(process.execPath, [fileURLToPath(new URL("./discovery-process.ts", import.meta.url)), input], { maxBuffer: 4 * MiB });
    const result = JSON.parse(output.stdout); checkpoints = result.checkpoints;
    for (const event of result.events) seen.add(event.message_id);
    positions.set(`cold-${round}`, Number(checkpoints.find((item: SourceCheckpoint) => item.locator === cold)?.cursor.offset));
  }
  assert.ok(Number(positions.get("cold-1")) > MiB, "longest-unserved cold candidate gets a chance before hot is served twice");
  assert.ok(seen.has("cold-tail"), "cold tail is eventually captured across process restarts");
});

test("complete oversized first-line identity and later Claude cwd evidence progress in ≤4MiB probes under allowed roots", async t => {
  for (const provider of ["codex", "claude"]) {
    const f = await fixture(t, provider), file = join(f.sources, "not-an-identity.jsonl");
    f.config.providers[0].options.allowed_project_roots = ["/synthetic/project"];
    const first = provider === "codex" ? header("oversized", { padding: "x".repeat(6 * MiB) }) : JSON.stringify({ type: "metadata", padding: "x".repeat(6 * MiB) }) + "\n";
    const later = provider === "codex" ? user("oversized-user", "valid") : JSON.stringify({ type: "user", sessionId: "oversized", cwd: "/synthetic/project", timestamp: "2026-10-06T12:00:00Z", uuid: "oversized-user", message: { role: "user", content: "valid" } }) + "\n";
    await writeFile(file, first + later);
    const pending = await f.round();
    assert.equal(pending.events.length, 0);
    assert.equal(f.checkpoint(file).cursor.excluded, false);
    assert.equal(f.checkpoint(file).cursor.offset, 0);
    assert.ok(Number(f.checkpoint(file).cursor.unread_bytes) >= 6 * MiB);
    assert.ok(f.checkpoint(file).cursor.last_read_at);
    assert.ok(Number((f.checkpoint(file).cursor.identity_probe as any).offset) <= 4 * MiB);
    assert.ok(pending.fragments.length > 0);
    assert.ok(pending.coverage.every(item => item.capture_status === "partial"));
    const restored = await f.round();
    assert.ok(restored.events.some(event => event.body === "valid"));
    assert.equal(f.checkpoint(file).generation, "0");
    assert.equal(f.checkpoint(file).cursor.identity, "oversized");
    assert.equal((await f.round()).events.length, 0);
  }
});

test("unknown cwd is partial without exclusion; a later complete Claude record supplies scope while a half record does not", async t => {
  const f = await fixture(t, "claude"), file = join(f.sources, "session-filename-must-not-count.jsonl");
  f.config.providers[0].options.allowed_project_roots = ["/synthetic/project"];
  const row = (id: string, cwd?: string) => JSON.stringify({ type: "user", sessionId: "proven-session", cwd, timestamp: "2026-10-06T12:00:00Z", uuid: id, message: { role: "user", content: id } });
  await writeFile(file, row("first") + "\n" + row("later", "/synthetic/project").slice(0, -1));
  const pending = await f.round(); assert.equal(pending.events.length, 0); assert.equal(f.checkpoint(file).cursor.excluded, false);
  assert.ok(pending.coverage.some(item => item.gaps.some(gap => gap.reason === "session_cwd_unknown")));
  await appendFile(file, "}\n");
  const restored = await f.round(); assert.deepEqual(restored.events.map(event => event.body), ["first", "later"]);
  assert.equal(f.checkpoint(file).generation, "0");
});

test("identity probing preserves a nonzero ordinary generation witness without borrowing its scoped read progress", async t => {
  const f = await fixture(t), file = join(f.sources, "long-witness.jsonl");
  const sourceHeader = header("long-witness", { padding: "x".repeat(6 * MiB) });
  await writeFile(file, sourceHeader + user("stable-witness-message", "initial-long-body"));
  await f.round(); await f.round();
  await writeFile(file, sourceHeader + user("stable-witness-message", "revised-body"));
  const normal = await f.round();
  const generation = f.checkpoint(file).generation;
  assert.notEqual(generation, "0");
  assert.equal(normal.events.length, 1);
  const witnesses = f.checkpoints(); f.replace([]); f.request.lane = "history";
  const probe = await f.round(witnesses); assert.equal(probe.events.length, 0);
  const scoped = await f.round(witnesses);
  assert.equal(scoped.events.length, 1);
  assert.equal(scoped.events[0].event_id, normal.events[0].event_id);
  assert.equal(f.checkpoint(file).generation, generation);
  assert.equal((await f.round(witnesses)).events.length, 0);
});

test("UTF-8 half-line and legacy empty header restoration preserve generation and emit the completed native event once", async t => {
  const f = await fixture(t), file = join(f.sources, "half.jsonl");
  await writeFile(file, header("half") + user("seed")); await f.round();
  const complete = Buffer.from(user("utf8-native", "你好🙂"));
  const split = complete.indexOf(Buffer.from("🙂")) + 2;
  await appendFile(file, complete.subarray(0, split));
  const partial = await f.round(); assert.equal(partial.events.length, 0);
  assert.ok(f.checkpoint(file).cursor.pending_line_base64);
  f.replace(f.checkpoints().map(item => item.locator === file ? { ...item, cursor: { ...item.cursor, header_hash: hash(Buffer.alloc(0)) } } : item));
  await appendFile(file, complete.subarray(split));
  const finished = await f.round(); assert.equal(finished.events.length, 1); assert.equal(finished.events[0].body, "你好🙂");
  assert.equal(f.checkpoint(file).generation, "0");
  assert.equal((await f.round()).events.length, 0);
});

test("recent three-day Codex directories refresh each round while the all-tree manifest cursor continues", async t => {
  const f = await fixture(t), today = join(f.sources, "2026", "10", "06");
  await mkdir(today, { recursive: true });
  for (let index = 0; index < 30; index++) await writeFile(join(f.sources, `old-${index}.jsonl`), header(`old-${index}`));
  f.request.budget.max_directory_entries = 8;
  await f.round();
  const before = f.checkpoints().find(item => item.locator === "@discovery")!.cursor.directories as any[];
  const offset = before.find(item => item.path === f.sources)?.manifest.offset;
  await writeFile(join(today, "new-today.jsonl"), header("today") + user("new-today"));
  const result = await f.round(); assert.ok(result.events.some(event => event.source.message_id === "new-today"));
  const after = f.checkpoints().find(item => item.locator === "@discovery")!.cursor.directories as any[];
  assert.ok(after.find(item => item.path === f.sources)?.manifest.offset > offset);
});

test("known-file ring wraps from a nonzero or stale cursor and omitted known ranges remain partial", async t => {
  for (const savedSkip of [1, 101]) {
    const f = await fixture(t), first = join(f.sources, "first-known.jsonl"), second = join(f.sources, "second-known.jsonl");
    await writeFile(first, header("first-known")); await writeFile(second, header("second-known")); await f.round();
    const known = f.checkpoints().filter(item => item.locator !== "@discovery").sort((a, b) => a.checkpoint_id.localeCompare(b.checkpoint_id));
    const earliest = known[0].locator;
    await appendFile(earliest, user("omitted-known-tail"));
    const discovery = f.checkpoints().find(item => item.locator === "@discovery")!;
    const seed = (skip: number) => ({ ...discovery, cursor: { ...discovery.cursor, files: [], directories: [], known_skip: skip } });
    f.replace([...known, seed(savedSkip)]);
    const wrapped = await f.round();
    assert.ok(wrapped.events.some(event => event.source.message_id === "omitted-known-tail"), `saved_skip=${savedSkip}`);
    assert.ok(wrapped.advances.some(item => item.locator === earliest));
    assert.equal(wrapped.coverage.at(-1)!.capture_status, "complete");
    // A one-entry allocation cannot prove the unadmitted peer's current EOF.
    f.request.budget.max_directory_entries = 1;
    f.replace([...f.checkpoints().filter(item => item.locator !== "@discovery"), seed(1)]);
    const partial = await f.round();
    assert.equal(partial.coverage.at(-1)!.capture_status, "partial");
    assert.ok(partial.coverage.at(-1)!.gaps.some(gap => gap.reason === "known_file_rotation_remaining"));
  }
});
