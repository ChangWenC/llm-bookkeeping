import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, stat, mkdir, symlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { metadataRecoveryFixture } from './metadata-recovery-fixtures.ts';
import { previewMetadataFileRecovery, applyMetadataFileRecovery } from '../../src/metadata-batch-file-recovery.ts';
import { runMetadataBatchWorkRecovery } from '../../tools/recover-metadata-batch-work.ts';
import { digestBytes } from '../../src/publish/files.ts';

const tool = fileURLToPath(new URL('../../tools/recover-metadata-batch-work.ts', import.meta.url));
async function inputs(t: test.TestContext) {
  const f = await metadataRecoveryFixture(t), root = dirname(f.config.wiki_root), configPath = join(root, 'config.json');
  f.config.journal_timezone_timeline = [{ schema_version: 1, effective_from: '1970-01-01T00:00:00Z', timezone: 'Europe/Amsterdam', basis: 'Synthetic CLI fixture' }];
  await writeFile(configPath, JSON.stringify(f.config));
  return { ...f, root, configPath, prefix: ['--config', configPath, '--bad-batch', f.batchId, '--before-db', f.before] };
}

test('actual work CLI saves private proof without printing bodies, then accepts verified file receipts and preserves noops through publisher retry', async t => {
  const f = await inputs(t);
  const historic = (await f.store.listOutbox())[0].artifact; historic.affected_months!.push('2026-03');
  f.store.db.prepare('UPDATE outbox SET json=? WHERE id=?').run(JSON.stringify(historic), f.batchId);
  const original = (await f.store.listFileIntents()).find(item => item.operation_id.startsWith('monthly-supplement:'))!;
  const noop = { ...original, operation_id: 'monthly-supplement:2026-03:synthetic-noop', path: 'wiki/personal/journals/reviews/回顾_2026_03.md', baseline_digest: original.desired_digest, backup_bytes_base64: original.desired_bytes_base64 };
  await f.store.saveFileIntent(noop); await writeFile(join(f.config.wiki_root, noop.path), Buffer.from(noop.desired_bytes_base64!, 'base64'));
  await f.store.enqueueWork({ schema_version: 1, work_id: 'monthly_display:' + f.batchId + ':2026-03', kind: 'monthly_display', lane: 'live', state: 'complete', payload: { month: '2026-03', batch_id: f.batchId }, reason: null, migration_key: null, updated_at: historic.created_at });
  const preview = await previewMetadataFileRecovery(f.config, f.batchId, f.before), files = await applyMetadataFileRecovery(f.config, f.batchId, f.before, preview.plan_sha);
  assert.equal(files.restored_operations!.length, 2);
  const receiptPath = join(f.root, 'private-work', 'file-receipt.json'), planPath = join(f.root, 'private-work', 'plan.json');
  await mkdir(dirname(receiptPath), { mode: 0o700 }); await writeFile(receiptPath, JSON.stringify(files), { mode: 0o600 });
  const beforeWork = await f.store.listWork();
  const inspected = spawnSync(process.execPath, [tool, ...f.prefix, '--preview', '--output', planPath], { encoding: 'utf8' });
  assert.equal(inspected.status, 0, inspected.stderr); const consoleReceipt = JSON.parse(inspected.stdout);
  assert.equal(consoleReceipt.counts.original_files, 2); assert.equal(consoleReceipt.counts.unchanged_files, 1);
  assert.equal(inspected.stdout.includes('desired_bytes_base64'), false); assert.equal(inspected.stdout.includes('Manual prose'), false);
  const saved = JSON.parse(await readFile(planPath, 'utf8')); assert.equal(saved.original_intents.length, 2); assert.equal(saved.noop_intents.length, 1);
  assert.equal((await stat(planPath)).mode & 0o777, 0o600); assert.equal((await stat(dirname(planPath))).mode & 0o777, 0o700);
  assert.deepEqual(await f.store.listWork(), beforeWork);
  const applied = await runMetadataBatchWorkRecovery([...f.prefix, '--apply', '--plan', planPath, '--file-receipt', receiptPath]);
  assert.equal(applied.counts.restored_files, 2); assert.ok(applied.counts.closed_work! > 0);
  assert.equal((await f.store.listReadyBatches('monthly-display')).length, 0); assert.equal((await f.store.listWork('metadata_recovery_audit')).length, 1);
  await f.publisher.resume();
  for (let i = 0; i < f.paths.length; i++) assert.deepEqual(await readFile(join(f.config.wiki_root, f.paths[i])), f.originals[i]);
  assert.equal(digestBytes(await readFile(join(f.config.wiki_root, noop.path))), noop.desired_digest); assert.deepEqual(await f.store.getFileIntent(noop.operation_id), noop);
});

test('work wrapper rejects batch mismatch, stale output and unsafe/symlink material without acknowledgements', async t => {
  const f = await inputs(t), privateDir = join(f.root, 'private-work'), planPath = join(privateDir, 'plan.json'), receiptPath = join(privateDir, 'receipt.json');
  await runMetadataBatchWorkRecovery([...f.prefix, '--preview', '--output', planPath]);
  const bytes = await readFile(planPath, 'utf8'); const plan = JSON.parse(bytes);
  const acknowledgements = f.store.db.prepare('SELECT * FROM acks ORDER BY consumer,batch_id').all();
  await writeFile(receiptPath, JSON.stringify({ schema_version: 1, mode: 'apply', batch_id: 'batch:wrong', restored_operations: [] }));
  await assert.rejects(runMetadataBatchWorkRecovery([...f.prefix, '--apply', '--plan', planPath, '--file-receipt', receiptPath]), /batch/);
  plan.batch_id = 'batch:wrong'; await writeFile(planPath, JSON.stringify(plan));
  await assert.rejects(runMetadataBatchWorkRecovery([...f.prefix, '--preview', '--output', planPath]), /differs/); assert.equal(JSON.parse(await readFile(planPath, 'utf8')).batch_id, 'batch:wrong');
  await assert.rejects(runMetadataBatchWorkRecovery([...f.prefix, '--preview', '--output', join(f.config.wiki_root, 'unsafe-plan.json')]), /Wiki/);
  const linked = join(privateDir, 'linked-plan.json'); await symlink(planPath, linked);
  await assert.rejects(runMetadataBatchWorkRecovery([...f.prefix, '--apply', '--plan', linked, '--file-receipt', receiptPath]));
  await writeFile(planPath, 'null'); await assert.rejects(runMetadataBatchWorkRecovery([...f.prefix, '--apply', '--plan', planPath, '--file-receipt', receiptPath]), /plan schema/);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM acks ORDER BY consumer,batch_id').all(), acknowledgements); assert.equal((await f.store.listWork('metadata_recovery_audit')).length, 0);
  const shared = join(f.root, 'shared-output'); await mkdir(shared, { mode: 0o755 });
  await assert.rejects(runMetadataBatchWorkRecovery([...f.prefix, '--preview', '--output', join(shared, 'plan.json')]), /private parent/); assert.equal((await stat(shared)).mode & 0o777, 0o755);
});
