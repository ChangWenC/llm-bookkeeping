import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm, unlink, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { config as defaults } from "../../test/fixtures/basic.ts";
import type { BookkeepingConfig, CollectRequest, SourceCheckpoint } from "../../src/contracts/types.ts";
import { manifestDirectory } from "../../src/adapters/discovery-manifest.ts";
import { hash } from "../../src/adapters/common.ts";

const execute = promisify(execFile);
async function fixture(t: test.TestContext, count = 5) {
  const root = await mkdtemp(join(tmpdir(), "bookkeeping-discovery-"));
  const sourceRoot = join(root, "source");
  await mkdir(sourceRoot);
  const config: BookkeepingConfig = { ...defaults, wiki_root: join(root, "wiki"), data_dir: join(root, "data"), providers: [{ schema_version: 1, provider: "claude", enabled: true, account_id: "synthetic", roots: [sourceRoot], options: {} }] };
  const request: CollectRequest = {
    lane: "live", cutoff: "2026-09-30T12:00:00Z",
    range: { schema_version: 1, from: "2026-09-30T00:00:00Z", to: "2026-09-30T12:00:00Z" },
    budget: { max_bytes: 1024 * 1024, max_directory_entries: 2, max_duration_ms: 10000 },
  };
  let checkpoints: SourceCheckpoint[] = [];
  const observed = new Set<string>();
  async function add(index: number) {
    await writeFile(join(sourceRoot, `session-${index}.jsonl`), JSON.stringify({ type: "user", sessionId: `synthetic-${index}`, timestamp: "2026-09-30T10:00:00Z", uuid: `user-${index}`, message: { role: "user", content: `synthetic input ${index}` } }) + "\n");
  }
  for (let index = 0; index < count; index++) await add(index);
  t.after(() => rm(root, { recursive: true, force: true }));
  async function round() {
    const input = join(root, "input.json");
    await writeFile(input, JSON.stringify({ config, request, checkpoints }));
    const result = await execute(process.execPath, [fileURLToPath(new URL("./discovery-process.ts", import.meta.url)), input], { maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(result.stdout);
    checkpoints = parsed.checkpoints;
    for (const event of parsed.events) observed.add(event.conversation);
    return parsed;
  }
  const scope = () => hash(JSON.stringify([config.providers[0].roots, null, null]));
  return { root, sourceRoot, config, request, round, add, observed,
    discovery: () => checkpoints.find(checkpoint => checkpoint.locator === "@discovery")!,
    storage: () => manifestDirectory(config, config.providers[0], scope()),
  };
}

test("fresh process budget two consumes the persisted directory manifest to completion and discovers next-epoch arrivals", async t => {
  const source = await fixture(t);
  const first = await source.round();
  assert.equal(source.observed.size, 2);
  const cursor = source.discovery().cursor.directories as any[];
  assert.equal(cursor[0].skip, 2);
  assert.ok(cursor[0].manifest.offset > 0);
  assert.equal(cursor[0].manifest.complete, true);
  assert.ok(first.coverage.some((coverage: any) => coverage.capture_status === "partial"));
  await source.round();
  const complete = await source.round();
  assert.equal(source.observed.size, 5);
  assert.ok(complete.coverage.some((coverage: any) => coverage.capture_status === "complete"));
  await source.add(5);
  for (let round = 0; round < 4; round++) await source.round();
  assert.equal(source.observed.size, 6);
  assert.equal(source.request.budget.max_directory_entries, 2);
});

test("a missing manifest restarts local enumeration without reusing the old offset", async t => {
  const source = await fixture(t);
  await source.round();
  const cursor = (source.discovery().cursor.directories as any[])[0];
  await unlink(join(await source.storage(), cursor.manifest.id + ".jsonl"));
  const missing = await source.round();
  assert.ok(missing.coverage.some((coverage: any) => coverage.capture_status !== "complete"));
  for (let round = 0; round < 5; round++) await source.round();
  assert.equal(source.observed.size, 5);
});

test("partial metadata snapshot keeps discovered prefix and remains pending until an explicit finite budget increase", async t => {
  const source = await fixture(t, 8);
  source.config.providers[0].options.discovery_manifest_budget = { max_bytes: 190, max_duration_ms: 1000 };
  for (let round = 0; round < 5; round++) {
    const result = await source.round();
    assert.ok(result.coverage.filter((coverage: any) => coverage.conversation_id === null).every((coverage: any) => coverage.capture_status !== "complete"));
    assert.ok(result.coverage.some((coverage: any) => coverage.gaps.some((gap: any) => gap.reason.includes("raise_discovery_manifest_budget_or_narrow_root"))));
  }
  assert.ok(source.observed.size > 0 && source.observed.size < 8);
  source.config.providers[0].options.discovery_manifest_budget = { max_bytes: 4096, max_duration_ms: 1000 };
  for (let round = 0; round < 8; round++) await source.round();
  assert.equal(source.observed.size, 8);
});

test("one unavailable root does not block healthy roots in a persisted discovery round", async t => {
  const source = await fixture(t, 4);
  source.config.providers[0].roots.unshift(join(source.root, "missing"));
  for (let round = 0; round < 5; round++) await source.round();
  assert.equal(source.observed.size, 4);
});

test("metadata exhaustion does not consume the known live-file source budget", async t => {
  const source = await fixture(t, 2);
  await source.round();
  await appendFile(join(source.sourceRoot, "session-0.jsonl"), JSON.stringify({ type: "user", sessionId: "synthetic-0", timestamp: "2026-09-30T11:00:00Z", uuid: "native-live-append", message: { role: "user", content: "synthetic append during partial discovery" } }) + "\n");
  source.config.providers[0].options.discovery_manifest_budget = { max_bytes: 1, max_duration_ms: 1000 };
  const result = await source.round();
  assert.ok(result.events.some((event: any) => event.message_id === "native-live-append"));
  assert.ok(result.coverage.filter((coverage: any) => coverage.conversation_id === null).every((coverage: any) => coverage.capture_status === "partial"));
});

test("manifest state rejects source/Wiki/cloud overlap and a replaced metadata directory symlink", async t => {
  const source = await fixture(t, 1);
  const originalData = source.config.data_dir;
  for (const data of [source.sourceRoot, source.config.wiki_root, "/Users/synthetic/Library/Mobile Documents/state"]) {
    source.config.data_dir = data;
    await assert.rejects(source.storage(), /overlaps_wiki_source_or_cloud/);
  }
  source.config.data_dir = originalData;
  const storage = await source.storage();
  await rm(storage, { recursive: true });
  await symlink(source.sourceRoot, storage);
  await assert.rejects(source.storage(), /unsafe_manifest_directory/);
  const original = await readFile(join(source.sourceRoot, "session-0.jsonl"), "utf8");
  assert.ok(original.includes("synthetic input 0"));
});
