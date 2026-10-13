import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileAdapter } from '../../src/adapters/files.ts';
import { createStore } from '../../src/store/index.ts';
import { config as defaults } from '../../test/fixtures/basic.ts';
import type { BookkeepingConfig, CollectRequest, CollectionBatch } from '../../src/contracts/types.ts';

const request: CollectRequest = { lane: 'history', cutoff: '2026-10-02T16:00:00Z', range: { schema_version: 1, from: '2026-08-31T22:00:00Z', to: '2026-10-02T16:00:00Z' }, budget: { max_duration_ms: 10000, max_bytes: 1024 * 1024, max_directory_entries: 1 } };
const timestamp = '2026-09-30T12:00:00Z';
for (const provider of ['codex', 'claude']) {
  test(`${provider} frozen history retries keep immutable batches distinct across metadata-only EOF and preserve native identities`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'bookkeeping-file-batch-identity-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const sources = join(root, 'sources'); await mkdir(sources); await mkdir(join(root, 'wiki'));
    const config: BookkeepingConfig = { ...defaults, wiki_root: join(root, 'wiki'), data_dir: join(root, 'data'), providers: [{ schema_version: 1, provider, account_id: 'synthetic-account', enabled: true, roots: [sources], options: {} }] };
    const source = config.providers[0], metadataPath = join(sources, 'metadata.jsonl');
    const header = (id: string) => ({ type: 'session_meta', timestamp, payload: { id, source: 'vscode', originator: 'Codex Desktop' } });
    const metadata = provider === 'codex' ? header('synthetic-metadata') : { type: 'progress', sessionId: 'synthetic-metadata', timestamp };
    const peer = provider === 'codex' ? [header('synthetic-peer'), { type: 'event_msg', timestamp, payload: { type: 'user_message', id: 'synthetic-native-message', message: 'Synthetic peer message' } }] : [{ type: 'user', sessionId: 'synthetic-peer', uuid: 'synthetic-native-message', timestamp, message: { role: 'user', content: 'Synthetic peer message' } }];
    await writeFile(metadataPath, JSON.stringify(metadata) + '\n');
    await writeFile(join(sources, 'peer.jsonl'), peer.map(row => JSON.stringify(row) + '\n').join(''));
    const store = await createStore(config); t.after(() => store.close());
    const saved = new Map<string, string>(), metadataBatches: CollectionBatch[] = [];
    let originalNativeIds: string[] | undefined;
    for (let round = 0; round < 8; round++) {
      const checkpoints = await store.getCheckpoints(provider, 'history');
      for await (const batch of new FileAdapter(source, config).collect(request, { config, checkpoints })) {
        const content = JSON.stringify(batch), previous = saved.get(batch.batch_id);
        if (previous) assert.equal(content, previous, 'same batch ID must describe exact immutable content');
        saved.set(batch.batch_id, content);
        if (batch.checkpoints.some(checkpoint => checkpoint.locator === metadataPath)) metadataBatches.push(batch);
        await store.saveCollection(batch);
      }
      const ids = (await store.listEvents({ range: request.range })).map(event => event.event_id);
      if (ids.length && !originalNativeIds) originalNativeIds = ids;
      if (originalNativeIds) assert.deepEqual(ids, originalNativeIds, 'retries preserve native event IDs and add no duplicate events');
    }
    const read = metadataBatches.find(batch => batch.fragments.length === 1)!;
    const eof = metadataBatches.find(batch => batch.fragments.length === 0)!;
    assert.ok(read && eof, 'exercise both captured metadata bytes and later EOF');
    assert.deepEqual(read.events, []); assert.deepEqual(eof.events, []);
    const physicalProgress = (batch: CollectionBatch) => {
      const checkpoint = batch.checkpoints.find(item => item.locator === metadataPath)!;
      const { last_read_at, ...cursor } = checkpoint.cursor;
      assert.match(String(last_read_at), /^\d{4}-\d{2}-\d{2}T.*Z$/);
      return JSON.parse(JSON.stringify({ ...checkpoint, cursor }));
    };
    assert.deepEqual(physicalProgress(read), physicalProgress(eof), 'same persisted EOF progress does not imply same captured bytes; actual read time and discovery scheduling are independent');
    assert.notEqual(read.batch_id, eof.batch_id);
    assert.equal((await store.listEvents({ range: request.range })).length, 1);
  });
}

test('empty file adapter batches include coverage range and outcome in immutable identity', async () => {
  const source = { schema_version: 1 as const, provider: 'codex', account_id: 'synthetic-account', enabled: false, roots: [], options: {} };
  const config = { ...defaults, providers: [source] };
  const batches: CollectionBatch[] = [];
  for (const range of [request.range, { ...request.range, from: '2026-09-15T00:00:00Z' }]) {
    for await (const batch of new FileAdapter(source, config).collect({ ...request, range }, { config, checkpoints: [] })) batches.push(batch);
  }
  assert.deepEqual(batches[0].events, batches[1].events); assert.deepEqual(batches[0].checkpoints, batches[1].checkpoints);
  assert.notEqual(batches[0].batch_id, batches[1].batch_id, 'different coverage must not reuse a collection ID');
});
