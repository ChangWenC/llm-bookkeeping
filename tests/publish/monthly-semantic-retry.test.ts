import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createStore } from '../../src/store/index.ts';
import { createReviewer } from '../../src/review/index.ts';
import { createPublisher, acquireWikiLock } from '../../src/publish/index.ts';
import { createMonthlyConsumer } from '../../src/consumers/monthly/index.ts';
import { monthlyPath } from '../../src/consumers/archive/records.ts';
import type { ReviewBundle, ReviewResult } from '../../src/contracts/types.ts';
import { config as fixtureConfig, event, collection, bundle, result, candidate } from '../store/fixtures.ts';

const cutoff = '2026-10-07T12:00:00.000Z';
for (const mode of ['partial', 'omitted', 'partial_busy_lock'] as const) test(`SQLite ${mode} monthly publication survives fresh complete review of the same frozen snapshot`, async t => {
  const config = await fixtureConfig(); config.limits.bundle_bytes = 8192;
  let time = Date.parse(cutoff); const now = () => new Date(time);
  const store = await createStore(config, { now });
  t.after(async () => { await store.close(); await rm(dirname(config.wiki_root), { recursive: true, force: true }); });
  const events = Array.from({ length: 6 }, (_, i) => event(`synthetic-monthly:${i}`));
  await store.saveCollection(collection(events)); const source = bundle(events, `source:${mode}`); source.cutoff = cutoff;
  await store.saveBundle(source); const sourceReview = result(source, `accepted-source:${mode}`); sourceReview.pages = [];
  sourceReview.candidates = events.map((item, i) => ({ ...candidate(source, `candidate:${i}`), content: `Synthetic ledger fact ${i}. ` + 'Synthetic bounded evidence. '.repeat(30), event_refs: [{ schema_version: 1, event_id: item.event_id, start_byte: 0, end_byte: Buffer.byteLength(item.body ?? '') }], analytics_projection: { schema_version: 1, value: null, reason: 'Synthetic monthly-only evidence' } }));
  await store.commitReview(sourceReview);
  const month = '2026-09', frozenWork = `prepare-monthly:frozen:${mode}`, lateWork = `prepare-monthly:late:${mode}`;
  const work = (work_id: string) => ({ schema_version: 1 as const, work_id, kind: 'prepare_monthly', lane: 'history' as const, state: 'pending' as const, payload: { month }, reason: 'Synthetic exact monthly semantic debt', migration_key: null, updated_at: now().toISOString() });
  await store.enqueueWork(work(frozenWork));
  const reviewer = createReviewer(store, config), publisher = createPublisher(store, config, { now });
  const first = (await reviewer.prepare({ kind: 'monthly', lane: 'history', period: month, cutoff }))[0];
  const scope = first.monthly_context!.facts_page!; assert.ok(scope.next_offset !== null);
  time += 1000; await store.enqueueWork(work(lateWork));
  function review(packet: ReviewBundle, id: string, complete: boolean): ReviewResult {
    const context = packet.monthly_context!;
    return { schema_version: 1, result_id: id, bundle_id: packet.bundle_id,
      chunks: !complete && mode === 'omitted' ? [] : packet.chunks.map(chunk => ({ schema_version: 1, chunk_id: chunk.chunk_id, status: complete ? 'complete' : 'partial', reviewed_event_ids: [], zero_facts: complete, reason: complete ? null : 'Synthetic partial reading' })),
      candidates: [], pages: [], created_at: cutoff, monthly_review: { schema_version: 1, month, summary: complete ? `Synthetic complete semantic page ${context.facts_page!.offset}.` : 'Synthetic retained partial note.',
        fact_refs: complete ? context.facts.map(fact => ({ schema_version: 1, fact_id: fact.fact_id, revision: fact.revision })) : [], supplement_text: '', coverage_status: 'partial',
        completed_work_ids: complete ? context.prepared_work_ids ?? [] : [], completed_archive_context_ids: [] } };
  }
  const earlier = review(first, `monthly-partial:${mode}`, false), lock = mode === 'partial_busy_lock' ? await acquireWikiLock(config.wiki_root) : null;
  let partial;
  try { partial = await publisher.publish(earlier); } finally { if (lock) await lock.release(); }
  assert.equal(partial.fact_commit, 'committed'); assert.equal(partial.export_status, 'ready');
  const target = join(config.wiki_root, monthlyPath(month));
  if (mode !== 'partial_busy_lock') assert.ok((await readFile(target, 'utf8')).includes('Synthetic retained partial note.'));
  else assert.ok(partial.consumers.some(outcome => outcome.target.startsWith('monthly-publish:') && outcome.status === 'pending'));
  if (mode !== 'partial_busy_lock') await writeFile(target, (await readFile(target, 'utf8')) + '\nSynthetic manual note retained outside managed output.\n');
  const originalResult = JSON.stringify(await store.getReviewResult(earlier.result_id));
  const originalArtifact = store.db.prepare('SELECT json FROM outbox WHERE id=?').get(partial.batch_id!)!.json;
  const originalExport = await readFile((await store.getPublicationOutbox(partial.batch_id!))!.export_path!);
  const originalIntents = (await store.listFileIntents()).filter(intent => intent.operation_id.startsWith(`monthly-review:${partial.batch_id}:`));
  assert.equal((await store.factMaterialProgress!(scope.snapshot_id))!.first_unread_offset, 0);
  let current = (await reviewer.prepare({ kind: 'monthly', lane: 'history', period: month, cutoff, fact_snapshot: scope.snapshot_id, fact_offset: 0 }))[0];
  assert.notEqual(current.bundle_id, first.bundle_id, 'A fresh incomplete-page attempt must not reuse the accepted immutable bundle');
  let count = 0;
  while (count++ < 10) {
    assert.equal(current.monthly_context!.facts_page!.snapshot_id, scope.snapshot_id); assert.equal(current.cutoff, cutoff);
    time += 1000; const accepted = await publisher.publish(review(current, `monthly-full:${mode}:${count}`, true));
    assert.equal(accepted.fact_commit, 'committed'); assert.equal(accepted.export_status, 'ready');
    assert.ok(!accepted.files.some(file => file.status === 'conflict'));
    assert.ok((await readFile(target, 'utf8')).includes(`Synthetic complete semantic page ${current.monthly_context!.facts_page!.offset}.`), 'Current complete output survives older pending recovery in the same publish');
    const progress = await store.factMaterialProgress!(scope.snapshot_id); assert.ok(progress);
    if (progress.first_unread_offset === null) break;
    assert.ok((await store.listWork('prepare_monthly', 'pending')).some(item => item.work_id === frozenWork));
    current = (await reviewer.prepare({ kind: 'monthly', lane: 'history', period: month, cutoff, fact_snapshot: scope.snapshot_id, fact_offset: progress.first_unread_offset }))[0];
  }
  assert.ok(count < 10); assert.equal((await store.factMaterialProgress!(scope.snapshot_id))!.first_unread_offset, null);
  assert.equal(JSON.stringify(await store.getReviewResult(earlier.result_id)), originalResult);
  assert.equal(store.db.prepare('SELECT json FROM outbox WHERE id=?').get(partial.batch_id!)!.json, originalArtifact);
  assert.deepEqual(await readFile((await store.getPublicationOutbox(partial.batch_id!))!.export_path!), originalExport);
  for (const intent of originalIntents) assert.deepEqual(await store.getFileIntent(intent.operation_id), intent);
  assert.ok(!(await store.listWork('prepare_monthly', 'pending')).some(item => item.work_id === frozenWork));
  assert.ok((await store.listWork('prepare_monthly', 'pending')).some(item => item.work_id === lateWork));
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM facts').get()!.n, 6);
  const finalBytes = await readFile(target); assert.ok(finalBytes.toString().includes('Synthetic complete semantic page'));
  if (mode !== 'partial_busy_lock') assert.ok(finalBytes.toString().includes('Synthetic manual note retained outside managed output.'));
  const noOrder = Object.create(store); noOrder.getPublicationBatchOrder = async () => null;
  const unavailable = createMonthlyConsumer(noOrder, config, { now });
  const deferred = await unavailable.publishMonthlyReview((await store.getPublicationOutbox(partial.batch_id!))!.artifact);
  assert.equal(deferred.status, 'pending'); assert.match(deferred.reason!, /acceptance order/);
  assert.equal((await unavailable.refreshMonthlySupplements(month)).status, 'pending');
  assert.deepEqual(await readFile(target), finalBytes, 'Missing order proof cannot change the accepted output');
  assert.ok((await store.listWork('prepare_monthly', 'pending')).some(item => item.work_id === lateWork));
  const retried = await publisher.publish(earlier); assert.equal(retried.fact_commit, 'already_committed'); assert.equal(retried.batch_id, partial.batch_id);
  assert.deepEqual(await readFile(target), finalBytes, 'Retrying old partial acceptance cannot replace the later full monthly output');
  assert.equal(JSON.stringify(await store.getReviewResult(earlier.result_id)), originalResult);
  assert.equal(store.db.prepare('SELECT json FROM outbox WHERE id=?').get(partial.batch_id!)!.json, originalArtifact);
  assert.deepEqual(await readFile((await store.getPublicationOutbox(partial.batch_id!))!.export_path!), originalExport);
  for (const intent of originalIntents) assert.deepEqual(await store.getFileIntent(intent.operation_id), intent);
});
