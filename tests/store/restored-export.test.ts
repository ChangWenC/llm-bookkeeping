import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createStore, restoreStore, canonical, digest } from '../../src/store/index.ts';
import { createPublisher } from '../../src/publish/index.ts';
import { createMonthlyConsumer } from '../../src/consumers/monthly/index.ts';
import { config, collection, bundle, result, range } from './fixtures.ts';

test('ready backup restores to new data directory, regenerates the same export, retains confirmations and resumes independent consumers', async () => {
    const c = await config(); c.goal_whitelist = ['goal:restore'];
    const store = await createStore(c); await store.saveCollection(collection());
    const prepared = bundle(); await store.saveBundle(prepared);
    const review = result(prepared); review.pages = [];
    await store.commitReview(review);
    const before = await createPublisher(store, c).resume(); assert.equal(before.export_status, 'ready');
    const outbox = (await store.listOutbox())[0], originalBytes = await readFile(outbox.export_path!);
    await store.acknowledgeConsumer({ schema_version: 1, consumer: 'analytics', batch_id: outbox.batch_id, acknowledged_at: '2026-09-30T12:00:00Z' });
    const ref = { schema_version: 1 as const, logical_id: 'goal:restore', revision: 1 };
    store.analyticsPort().applyReview({ schema_version: 1, kind: 'goal_contract', contract: { schema_version: 1, contract_ref: ref,
        subject: 'Roy', description: 'Synthetic confirmed contract retained across restore', target_version: 'v1', deadline: null, confirmed: false } }, c);
    store.analyticsPort().applyReview({ schema_version: 1, kind: 'review', events: [{ schema_version: 1, review_id: 'restore-confirm', target_ref: ref,
        action: 'confirm', correction: null, evidence_refs: [], created_at: '2026-09-30T12:00:00Z' }] }, c);
    const facts = canonical(await store.readEffectiveFacts({ range })), accepted = canonical(await store.getReviewResult(review.result_id));
    const goal = canonical(store.analyticsPort().confirmedGoals(c, '2026-09-30T13:00:00Z'));
    const backup = await store.backup(join(c.data_dir, 'backup'));
    const restoredDir = join(c.data_dir, 'restored'), restoredCopy = await restoreStore(backup.path, restoredDir);
    assert.equal(restoredCopy.sha256, digest(await readFile(restoredCopy.path)));
    assert.notEqual(restoredCopy.sha256, backup.sha256, 'Restore hashes final target bytes after resetting ready outbox paths');
    store.close();
    await rm(join(c.data_dir, 'facts'), { recursive: true }); // Original projection no longer exists.
    const restoredConfig = { ...c, data_dir: restoredDir }, restored = await createStore(restoredConfig);
    const resumed = await createPublisher(restored, restoredConfig).resume();
    assert.equal(resumed.export_status, 'ready');
    assert.equal((await restored.listWork('export', 'pending')).length, 0);
    const regenerated = (await restored.listOutbox())[0];
    assert(regenerated.export_path!.startsWith(restoredDir + '/'));
    assert.notEqual(regenerated.export_path, outbox.export_path);
    assert.deepEqual(await readFile(regenerated.export_path!), originalBytes);
    assert.equal(canonical(await restored.readEffectiveFacts({ range })), facts);
    assert.equal(canonical(await restored.getReviewResult(review.result_id)), accepted);
    assert.equal(canonical(restored.analyticsPort().confirmedGoals(c, '2026-09-30T13:00:00Z')), goal);
    assert.equal((await restored.listReadyBatches('analytics')).length, 0); // Prior acknowledgement survives.
    assert.equal((await restored.listReadyBatches('monthly')).length, 1);
    assert.equal((await createMonthlyConsumer(restored, restoredConfig).consume()).status, 'complete');
    assert.equal((await restored.listReadyBatches('monthly')).length, 0);
    assert.equal((await createPublisher(restored, restoredConfig).resume()).export_status, 'ready');
    await assert.rejects(restored.markExportReady(regenerated.batch_id, join(c.data_dir, 'unrelated.json')), /Immutable export path conflict/);
    restored.close();
});
