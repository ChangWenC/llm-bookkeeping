import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileAdapter } from "../../src/adapters/files.ts";
import { createStore } from "../../src/store/index.ts";
import { storageFailureCode } from "../../src/storage-errors.ts";
import { config as defaults } from "../../test/fixtures/basic.ts";
import type { BookkeepingConfig, CollectRequest } from "../../src/contracts/types.ts";

const request: CollectRequest = { lane: "live", cutoff: "2026-10-07T12:00:00Z",
  range: { schema_version: 1, from: "2026-10-07T00:00:00Z", to: "2026-10-07T12:00:00Z" },
  budget: { max_duration_ms: 10000, max_bytes: 1048576, max_directory_entries: 20 } };
async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(join(tmpdir(), "bookkeeping-discovery-storage-"));
  const sources = join(root, "sources");
  await fs.mkdir(sources);
  await fs.writeFile(join(sources, "session.jsonl"), JSON.stringify({ type: "user", sessionId: "synthetic", uuid: "synthetic-native",
    timestamp: "2026-10-07T09:00:00Z", message: { role: "user", content: "Synthetic saved source" } }) + "\n");
  const config: BookkeepingConfig = { ...defaults, wiki_root: join(root, "wiki"), data_dir: join(root, "data"), providers: [{
    schema_version: 1, provider: "claude", account_id: "synthetic", enabled: true, roots: [sources], options: {},
  }] };
  const store = await createStore(config);
  const adapter = new FileAdapter(config.providers[0], config);
  for await (const batch of adapter.collect(request, { config, checkpoints: [] })) await store.saveCollection(batch);
  t.after(async () => { store.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, sources, config, store };
}

for (const stage of ["mkdir", "writeFile", "sync", "rename"])
  for (const code of ["ENOSPC", "EDQUOT", "EIO", "EROFS"]) {
    test(`local discovery ${stage} ${code} propagates globally without writing checkpoints or swallowing its code`, async t => {
      const f = await fixture(t);
      const before = f.store.db.prepare("SELECT id,json FROM checkpoints ORDER BY id").all();
      const failure = Object.assign(new Error("Synthetic local storage write failure"), { code });
      const data = await fs.realpath(f.config.data_dir);
      let injected = 0;
      let probe: Awaited<ReturnType<typeof fs.open>> | undefined;
      if (stage === "mkdir") {
        const original = fs.mkdir;
        t.mock.method(fs, "mkdir", async (path: any, options: any) => {
          if (String(path).startsWith(data)) { injected++; throw failure; }
          return original(path, options);
        });
      } else if (stage === "rename") {
        t.mock.method(fs, "rename", async () => { injected++; throw failure; });
      } else {
        probe = await fs.open(join(f.root, "synthetic-probe"), "w");
        t.mock.method(Object.getPrototypeOf(probe), stage, async () => { injected++; throw failure; });
      }
      syncBuiltinESMExports();
      let caught: any;
      let yielded = 0;
      try {
        const checkpoints = await f.store.getCheckpoints("claude", "live");
        const adapter = new FileAdapter(f.config.providers[0], f.config);
        try { for await (const batch of adapter.collect(request, { config: f.config, checkpoints })) { yielded++; await f.store.saveCollection(batch); } }
        catch (error) { caught = error; }
        finally { await adapter.close(); }
      } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await probe?.close(); }
      assert.equal(injected, 1, "the failed local write is not retried or followed by another storage write");
      assert.equal(caught?.code, code);
      assert.equal(caught?.cause, failure);
      assert.equal(storageFailureCode(caught), code);
      assert.equal(yielded, 0);
      assert.deepEqual(f.store.db.prepare("SELECT id,json FROM checkpoints ORDER BY id").all(), before);
      assert.equal((await f.store.listEvents({ range: request.range })).length, 1);
    });
  }

for (const code of ["EIO", "EROFS", "EACCES"]) {
  test(`source directory ${code} remains local and a healthy root still captures`, async t => {
    const f = await fixture(t);
    const badRoot = join(f.root, "bad-source");
    await fs.mkdir(badRoot);
    f.config.providers[0].roots.unshift(badRoot);
    const original = fs.opendir;
    t.mock.method(fs, "opendir", async (path: any, options: any) => {
      if (String(path) === badRoot) throw Object.assign(new Error("Synthetic source read failure"), { code });
      return original(path, options);
    });
    syncBuiltinESMExports();
    const batches = [];
    try {
      const adapter = new FileAdapter(f.config.providers[0], f.config);
      try { for await (const batch of adapter.collect(request, { config: f.config, checkpoints: [] })) batches.push(batch); }
      finally { await adapter.close(); }
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    assert.equal(batches.flatMap(batch => batch.events).length, 1);
    assert.ok(batches.flatMap(batch => batch.coverage).some(coverage => coverage.gaps.some(gap => gap.reason.includes(code))));
  });
}
