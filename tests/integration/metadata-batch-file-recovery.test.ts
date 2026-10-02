import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { config as fixtureConfig, bundle } from '../store/fixtures.ts';
import { createStore } from '../../src/store/index.ts';
import { createPublisher } from '../../src/publish/index.ts';
import { SafeWikiWriter, digestBytes } from '../../src/publish/files.ts';
import { previewMetadataFileRecovery, applyMetadataFileRecovery, planMetadataFileRecovery } from '../../src/metadata-batch-file-recovery.ts';

const fArtifact = (row: any) => JSON.parse(row.json);
const now = () => new Date('2026-10-02T16:00:00Z');
async function fixture(t: test.TestContext) {
  const config = await fixtureConfig(); t.after(() => rm(dirname(config.wiki_root), { recursive: true, force: true }));
  const store = await createStore(config); t.after(() => store.close());
  const paths = ['2026_01', '2026_02'].map(month => `wiki/personal/journals/reviews/回顾_${month}.md`);
  const originals = paths.map((_, index) => Buffer.from(`---\ntype: monthly-review\n---\n# Synthetic month ${index}\n\nManual prose stays exact 🧪\n`));
  for (let i = 0; i < paths.length; i++) { await mkdir(dirname(join(config.wiki_root, paths[i])), { recursive: true }); await writeFile(join(config.wiki_root, paths[i]), originals[i]); }
  await writeFile(join(config.wiki_root, 'VERSION.md'), 'Synthetic version before\n');
  const writer = new SafeWikiWriter(store, config, { now });
  await writer.write({ operation_id: 'prior:synthetic-metadata', path: 'VERSION.md', baseline_digest: digestBytes(Buffer.from('Synthetic version before\n')), desired_bytes: Buffer.from('Synthetic version baseline\n') });
  const before = await store.backup(join(dirname(config.wiki_root), 'before'));
  const saved = bundle([], 'bundle:synthetic-bad-metadata');
  saved.coverage[0].query_range = { schema_version: 1, from: '2026-01-01T00:00:00Z', to: '2026-03-01T00:00:00Z' };
  saved.cutoff = now().toISOString(); saved.baselines = [{ schema_version: 1, path: 'VERSION.md', digest: digestBytes(Buffer.from('Synthetic version baseline\n')), content: 'Synthetic version baseline\n' }];
  await store.saveBundle(saved);
  const result = { schema_version: 1 as const, result_id: 'result:synthetic-bad-metadata', bundle_id: saved.bundle_id, chunks: [], candidates: [], pages: [{ schema_version: 1 as const, suggestion_id: 'suggestion:synthetic-version', date: '2026-10-02', path: 'VERSION.md', baseline_digest: saved.baselines[0].digest, mode: 'append' as const, old_text: null, new_text: 'Authorized metadata patch\n', candidate_ids: [] }], created_at: now().toISOString() };
  // Model an already-persisted pre-fix artifact; the corrected semantic commit must not reproduce this fanout.
  const accepted = await store.commitReview(result);
  const historic = fArtifact(store.db.prepare('SELECT json FROM outbox WHERE id=?').get(accepted.batch_id));
  historic.affected_dates = ['2026-01-01', '2026-02-01']; historic.affected_months = ['2026-01', '2026-02'];
  store.db.prepare('UPDATE outbox SET json=? WHERE id=?').run(JSON.stringify(historic), accepted.batch_id);
  const publisher = createPublisher(store, config, { now }); const published = await publisher.publish(result);
  assert.equal(published.export_status, 'ready'); assert.ok(published.batch_id);
  for (const path of paths) assert.match(await readFile(join(config.wiki_root, path), 'utf8'), /当前没有待展示的有效补记/);
  return { config, store, paths, originals, before: before.path, batchId: published.batch_id!, publisher };
}

test('zero-business broad coverage counterexample restores only derived additions with new audited intents; generic retries never recreate old output', async t => {
  const f = await fixture(t);
  const originalIntentBytes = f.store.db.prepare("SELECT id,json FROM intents WHERE id LIKE 'monthly-supplement:%' ORDER BY id").all();
  const beforeBytes = await readFile(f.before);
  const preview = await previewMetadataFileRecovery(f.config, f.batchId, f.before);
  assert.equal(preview.files.length, 2); assert.ok(preview.files.every(file => file.current_matches_generated));
  assert.deepEqual(await readFile(f.before), beforeBytes);
  const applied = await applyMetadataFileRecovery(f.config, f.batchId, f.before, preview.plan_sha, { now });
  assert.equal(applied.restored_operations!.length, 2); assert.ok(applied.outcomes.every(item => item.status === 'applied'));
  for (let i = 0; i < f.paths.length; i++) assert.deepEqual(await readFile(join(f.config.wiki_root, f.paths[i])), f.originals[i]);
  assert.deepEqual(f.store.db.prepare("SELECT id,json FROM intents WHERE id LIKE 'monthly-supplement:%' ORDER BY id").all(), originalIntentBytes);
  assert.equal((await f.store.listWork('metadata_batch_file_recovery', 'complete')).length, 2);
  assert.match(await readFile(join(f.config.wiki_root, 'VERSION.md'), 'utf8'), /Authorized metadata patch/);
  const repeated = await applyMetadataFileRecovery(f.config, f.batchId, f.before, preview.plan_sha, { now });
  assert.ok(repeated.outcomes.every(item => item.status === 'noop')); assert.equal((await f.store.listFileIntents()).filter(item => item.operation_id.startsWith('metadata-recovery:')).length, 2);
  // B's separate work-recovery retires the bad batch's monthly display; simulate only its existing public ack port here.
  await f.store.acknowledgeConsumer({ schema_version: 1, consumer: 'monthly-display', batch_id: f.batchId, acknowledged_at: now().toISOString() });
  await f.publisher.resume();
  for (let i = 0; i < f.paths.length; i++) assert.deepEqual(await readFile(join(f.config.wiki_root, f.paths[i])), f.originals[i]);
});

test('manual edits conflict locally while siblings restore, and nonapplied originals are excluded', async t => {
  const f = await fixture(t); const preview = await previewMetadataFileRecovery(f.config, f.batchId, f.before);
  const manual = Buffer.from('Later synthetic manual edit\n'); await writeFile(join(f.config.wiki_root, f.paths[0]), manual);
  const result = await applyMetadataFileRecovery(f.config, f.batchId, f.before, preview.plan_sha, { now });
  assert.equal(result.outcomes.filter(item => item.status === 'conflict').length, 1); assert.equal(result.restored_operations!.length, 1);
  assert.deepEqual(await readFile(join(f.config.wiki_root, f.paths[0])), manual); assert.deepEqual(await readFile(join(f.config.wiki_root, f.paths[1])), f.originals[1]);
  const original = (await f.store.listFileIntents()).find(item => item.path === f.paths[0])!;
  await f.store.updateFileIntent(original.operation_id, 'pending');
  const plan = await planMetadataFileRecovery(f.config, f.batchId, f.before);
  assert.ok(plan.skipped.some(item => item.operation_id === original.operation_id && /not applied/.test(item.reason)));
});

test('rename interruption resumes own new restoration intent without borrowing source progress or deleting original audit', async t => {
  const f = await fixture(t); const preview = await previewMetadataFileRecovery(f.config, f.batchId, f.before);
  let failed = false;
  const first = await applyMetadataFileRecovery(f.config, f.batchId, f.before, preview.plan_sha, { now, fault(stage) { if (stage === 'after_target' && !failed) { failed = true; throw new Error('Synthetic rename-registration interruption'); } } });
  assert.equal(first.outcomes.filter(item => item.status === 'pending').length, 1);
  const repeated = await applyMetadataFileRecovery(f.config, f.batchId, f.before, preview.plan_sha, { now });
  assert.equal(repeated.restored_operations!.length, 2);
  assert.equal((await f.store.listWork('metadata_batch_file_recovery', 'complete')).length, 2);
  for (let i = 0; i < f.paths.length; i++) assert.deepEqual(await readFile(join(f.config.wiki_root, f.paths[i])), f.originals[i]);
});

test('bad proof, business result and prior-intent mutation fail without any restoration writes', async t => {
  const f = await fixture(t); const preview = await previewMetadataFileRecovery(f.config, f.batchId, f.before);
  await assert.rejects(applyMetadataFileRecovery(f.config, f.batchId, f.before, 'wrong-sha'), /proof/);
  const row = f.store.db.prepare('SELECT json FROM results WHERE id=?').get('result:synthetic-bad-metadata') as any;
  const business = JSON.parse(row.json); business.chunks = [{ reviewed_event_ids: ['event:synthetic'] }];
  f.store.db.prepare('UPDATE results SET json=? WHERE id=?').run(JSON.stringify(business), business.result_id);
  await assert.rejects(planMetadataFileRecovery(f.config, f.batchId, f.before), /business review/);
  f.store.db.prepare('UPDATE results SET json=? WHERE id=?').run(row.json, business.result_id);
  const previous = await f.store.getFileIntent('prior:synthetic-metadata'); const changed = { ...previous, path: 'OTHER.md' };
  f.store.db.prepare('UPDATE intents SET json=? WHERE id=?').run(JSON.stringify(changed), changed.operation_id!);
  await assert.rejects(planMetadataFileRecovery(f.config, f.batchId, f.before), /Prior immutable intent/);
  assert.equal((await f.store.listFileIntents()).filter(item => item.operation_id.startsWith('metadata-recovery:')).length, 0);
});
