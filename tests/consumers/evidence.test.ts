import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStore } from '../../src/store/index.ts';
import { createPublisher, acquireWikiLock } from '../../src/publish/index.ts';
import { createEvidenceConsumer, evidencePath } from '../../src/consumers/evidence/index.ts';
import { createConsumers } from '../../src/consumers/index.ts';
import { config as base } from '../../test/fixtures/basic.ts';
import type { FactRevision } from '../../src/contracts/types.ts';
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'bookkeeping-evidence-test-'));
  const config = { ...base, wiki_root: join(root, 'wiki'), data_dir: join(root, 'data') };
  await mkdir(config.wiki_root);
  const store = await createStore(config);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const add = async (identity: string) => {
    const fact: FactRevision = { schema_version: 1, fact_id: 'fact:' + identity, revision: 1, content: 'Accepted synthetic fact ' + identity,
      event_refs: [], subject: 'synthetic', occurred_at: { schema_version: 1, value: null, reason: 'Date only' },
      journal_date: { schema_version: 1, value: '2026-09-30', reason: null }, kind: 'fact', action: 'assert', target_refs: [],
      analytics_projection: { schema_version: 1, value: null, reason: 'No professional projection' }, scope: ['personal'], attribution: {}, recorded_at: '2026-09-30T12:00:00Z' };
    await store.importLegacy({ schema_version: 1, migration_key: identity, facts: [fact], mappings: [], work: [] });
  };
  return { root, config, store, add, mirror: (id: string) => join(config.wiki_root, evidencePath(id)) };
}
test('new evidence consumer backfills already acknowledged old batches in bounded rounds without raw source fragments', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 5; index++) await f.add('historical:' + index);
  await createPublisher(f.store, f.config).exportFacts();
  const ready = await f.store.listReadyBatches('analytics');
  for (const batch of ready) await f.store.acknowledgeConsumer({ schema_version: 1, consumer: 'analytics', batch_id: batch.batch_id, acknowledged_at: '2026-09-30T12:00:00Z' });
  assert.equal((await f.store.listReadyBatches('analytics')).length, 0);
  const requests: number[] = [], original = f.store.listReadyBatches.bind(f.store);
  f.store.listReadyBatches = async (consumer, limit, after) => { if (consumer === 'evidence') requests.push(limit!); return original(consumer, limit, after); };
  const consumer = createEvidenceConsumer(f.store, f.config, { max_batches: 2 });
  assert.equal((await consumer.consume()).status, 'partial'); assert.equal((await original('evidence')).length, 3);
  assert.equal((await consumer.consume()).status, 'partial'); assert.equal((await consumer.consume()).status, 'complete');
  assert.ok(requests.every(limit => limit === 1 || limit === 3));
  for (const batch of ready) { const mirrored = JSON.parse(await readFile(f.mirror(batch.batch_id), 'utf8')); assert.deepEqual(mirrored, batch); assert.equal('fragments' in mirrored, false); }
  assert.equal((await consumer.consume()).status, 'complete');
  assert.equal((await f.store.listFileIntents()).length, 5);
  assert.ok((await createConsumers(f.store, f.config, ['evidence']))[0].target === 'evidence');
});
test('live Wiki lock and mirror failure leave local immutable export and independent Analytics delivery ready', async t => {
  const f = await fixture(t); await f.add('busy');
  const lock = await acquireWikiLock(f.config.wiki_root); assert.ok(lock);
  try {
    assert.equal((await createPublisher(f.store, f.config).exportFacts()).pending.length, 0);
    assert.equal((await createEvidenceConsumer(f.store, f.config).consume()).status, 'pending');
    assert.equal((await f.store.listReadyBatches('analytics')).length, 1);
    assert.equal((await f.store.readEffectiveFacts({ range: { schema_version: 1, from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z' } })).length, 1);
  } finally { await lock.release(); }
  assert.equal((await createEvidenceConsumer(f.store, f.config).consume()).status, 'complete');
  assert.equal((await f.store.listReadyBatches('analytics')).length, 1);
  assert.equal((await f.store.listWork('evidence', 'pending')).length, 0);
});
test('mirror rename-before-registration and registration-before-ack recover without another write; manual edit is preserved', async t => {
  for (const stage of ['after_target', 'after_file_registered'] as const) {
    const f = await fixture(t); await f.add(stage); await createPublisher(f.store, f.config).exportFacts();
    const batch = (await f.store.listReadyBatches('evidence'))[0];
    const faulty = createEvidenceConsumer(f.store, f.config, { fault(at) { if (at === stage) throw new Error('Synthetic evidence interruption'); } });
    assert.equal((await faulty.consume()).status, 'pending'); assert.equal((await f.store.listReadyBatches('evidence')).length, 1);
    const before = await readFile(f.mirror(batch.batch_id));
    assert.equal((await createEvidenceConsumer(f.store, f.config).consume()).status, 'complete');
    assert.deepEqual(await readFile(f.mirror(batch.batch_id)), before);
  }
  const f = await fixture(t); await f.add('manual'); await createPublisher(f.store, f.config).exportFacts();
  const batch = (await f.store.listReadyBatches('evidence'))[0];
  await createEvidenceConsumer(f.store, f.config, { fault(at) { if (at === 'after_file_registered') throw new Error('Crash before mirror ack'); } }).consume();
  await writeFile(f.mirror(batch.batch_id), 'human edited mirror');
  assert.equal((await createEvidenceConsumer(f.store, f.config).consume()).status, 'pending');
  assert.equal(await readFile(f.mirror(batch.batch_id), 'utf8'), 'human edited mirror');
  assert.equal((await f.store.listReadyBatches('evidence')).length, 1);
  assert.ok((await f.store.getFileIntent('evidence:' + batch.batch_id))!.desired_bytes_base64);
});
test('bounded cursor moves beyond conflicted old batches, retries them after wrap and tolerates lost cursor', async t => {
  const f = await fixture(t); for (const id of ['old-conflict', 'later']) await f.add(id);
  await createPublisher(f.store, f.config).exportFacts();
  const [old, later] = await f.store.listReadyBatches('evidence');
  const consumer = createEvidenceConsumer(f.store, f.config, { max_batches: 1, fault(at, operation) {
    if (at === 'after_intent' && operation === 'evidence:' + old.batch_id) throw new Error('Old failure');
  } });
  assert.equal((await consumer.consume()).status, 'pending');
  await mkdir(join(f.config.wiki_root, 'wiki/personal/_evidence/bookkeeping/batches'), { recursive: true });
  await writeFile(f.mirror(old.batch_id), 'manual conflicting bytes');
  assert.equal((await consumer.consume()).status, 'partial');
  assert.ok(await readFile(f.mirror(later.batch_id)));
  assert.deepEqual((await f.store.listReadyBatches('evidence')).map(batch => batch.batch_id), [old.batch_id]);
  assert.equal((await consumer.consume()).status, 'pending');
  await rm(join(f.config.data_dir, 'consumers/evidence/cursor.json'));
  assert.equal((await createEvidenceConsumer(f.store, f.config).consume()).status, 'pending');
  assert.equal(await readFile(f.mirror(old.batch_id), 'utf8'), 'manual conflicting bytes');
});
