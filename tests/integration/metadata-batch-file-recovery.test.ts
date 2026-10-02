import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { metadataRecoveryFixture as fixture } from './metadata-recovery-fixtures.ts';
import { previewMetadataFileRecovery, applyMetadataFileRecovery, planMetadataFileRecovery } from '../../src/metadata-batch-file-recovery.ts';

const now = () => new Date('2026-10-02T16:00:00Z');

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
