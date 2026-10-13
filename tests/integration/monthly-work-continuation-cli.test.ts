import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createStore } from '../../src/store/index.ts';
import { runCli, parseArgs } from '../../src/cli.ts';
import { config, event, collection, bundle, result } from '../store/fixtures.ts';
import type { ReviewBundle } from '../../src/contracts/types.ts';
const cutoff = '2026-10-07T12:00:00.000Z';
async function fixture(t: test.TestContext, count = 65, facts = 2) {
  const cfg = await config(), root = dirname(cfg.wiki_root); t.after(() => rm(root, { recursive: true, force: true })); cfg.providers = []; cfg.journal_timezone_timeline = [{ schema_version: 1, effective_from: '1970-01-01T00:00:00Z', timezone: 'Europe/Amsterdam', basis: 'Synthetic fixture' }];
  const output = join(root, 'round'), manifest = join(output, 'manifest.json'), configPath = join(root, 'config.json'); await mkdir(output, { mode: 0o700 }); await writeFile(configPath, JSON.stringify(cfg));
  const s = await createStore(cfg, { now: () => new Date(cutoff) });
  for (let i = 0; i < facts; i++) { const e = event('work-fact:' + i, 'Synthetic event', '2026-09-20T12:00:00Z'), b = bundle([e], 'work-bundle:' + i), r = result(b, 'work-result:' + i); r.pages = []; await s.saveCollection(collection([e], 'history', 'work-collect:' + i)); await s.saveBundle(b); await s.commitReview(r); }
  for (let i = 0; i < count; i++) await s.enqueueWork({ schema_version: 1, work_id: 'frozen:' + String(i).padStart(3, '0'), kind: 'prepare_monthly', lane: 'history', state: 'pending', payload: { month: '2026-09' }, reason: 'Synthetic frozen debt', migration_key: null, updated_at: cutoff }); s.close();
  const step = async (extra: string[] = []) => { let stdout = '', stderr = ''; const exit = await runCli(['monthly-round', '--manifest', manifest, '--output', output, '--config', configPath, ...extra], { now: () => cutoff, stdout: v => stdout += v, stderr: v => stderr += v }); assert.equal(exit, 0, stderr); return JSON.parse(stdout); };
  const review = async (active: any, index: number, omit = false) => { const b: ReviewBundle = JSON.parse(await readFile(active.file, 'utf8')), c = b.monthly_context!; const r = { schema_version: 1, result_id: 'monthly-work:' + index, bundle_id: b.bundle_id, chunks: b.chunks.map(chunk => ({ schema_version: 1, chunk_id: chunk.chunk_id, status: 'complete', reviewed_event_ids: [], zero_facts: true, reason: null })), candidates: [], pages: [], created_at: cutoff, monthly_review: { schema_version: 1, month: '2026-09', summary: c.work_only ? 'Different immutable work-only raw note ' + index : 'Synthetic preserved base summary', fact_refs: c.facts.map(f => ({ schema_version: 1, fact_id: f.fact_id, revision: f.revision })), supplement_text: '', coverage_status: 'partial', completed_work_ids: omit ? [] : c.prepared_work_ids ?? [] } }; const input = join(output, 'result-' + index + '.json'); await writeFile(input, JSON.stringify(r)); return { b, r, input }; };
  return { cfg, output, manifest, step, review, configPath };
}
for (const facts of [2, 0]) test(`actual monthly CLI completes 65 frozen work IDs with ${facts} facts without rereading or duplicating conclusions`, async t => {
  const f = await fixture(t, 65, facts); let response = await f.step(), snapshot = '', originalReads = 0; const returned: string[] = [], summaries: string[] = []; let starts = 0;
  while (response.state === 'monthly_review' && starts < 5) {
    const { b, r, input } = await f.review(response.active, ++starts), context = b.monthly_context!;
    if (!snapshot) { snapshot = context.facts_page!.snapshot_id; assert.equal(context.work_only, undefined); } else { assert.equal(context.work_only, true); assert.equal(context.facts_page!.snapshot_id, snapshot); assert.equal(context.facts_page!.offset, facts); assert.deepEqual(context.facts, []); assert.deepEqual(context.manual_baselines, []); assert.equal(context.archive_contexts?.length ?? 0, 0); }
    returned.push(...context.prepared_work_ids ?? []); assert.equal(new Set(returned).size, returned.length, 'Each frozen work ID is returned once');
    if (starts === 1) { const s = await createStore(f.cfg); await s.enqueueWork({ schema_version: 1, work_id: 'late:not-frozen', kind: 'prepare_monthly', lane: 'history', state: 'pending', payload: { month: '2026-09' }, reason: 'After snapshot', migration_key: null, updated_at: '2026-10-07T12:01:00Z' }); s.close(); }
    response = await f.step(['--input', input]); const s = await createStore(f.cfg); const count = Number(s.db.prepare('SELECT COUNT(*) AS n FROM fact_material_reads WHERE snapshot_id=?').get(snapshot)!.n); if (starts === 1) originalReads = count; else assert.equal(count, originalReads);
    const identity = await s.acceptedReviewIdentity(b.bundle_id), artifact = (await s.getPublicationOutbox(identity!.batch_id))!.artifact; summaries.push(artifact.monthly_review!.summary); assert.equal((await s.getReviewResult(r.result_id))!.monthly_review!.summary, r.monthly_review.summary, 'Raw acceptance is preserved'); s.close();
  }
  assert.equal(starts, 3); assert.equal(response.terminal, true); assert.equal(response.started_bundles, 3); assert.equal(response.started_at, cutoff); assert.equal(response.cutoff, cutoff); assert.equal(returned.length, 65);
  assert.ok(summaries.every(summary => summary === 'Synthetic preserved base summary'));
  const s = await createStore(f.cfg); try { const state = await s.factMaterialProgress(snapshot); assert.equal(state!.pending_work_count, 0); assert.equal(state!.first_unread_offset, null); assert.equal((await s.listWork('prepare_monthly', 'pending')).find(w => w.work_id === 'late:not-frozen')!.state, 'pending'); assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM semantic_material_pages WHERE snapshot_id=?').get(snapshot)!.n, 1); const text = await readFile(join(f.cfg.wiki_root, 'wiki/personal/journals/reviews/回顾_2026_09.md'), 'utf8'); assert.equal(text.split('Synthetic preserved base summary').length - 1, 1); assert.ok(!text.includes('Different immutable work-only raw note')); } finally { s.close(); }
});
test('accepted work-only input without completed IDs keeps active acceptance and starts unchanged', async t => {
  const f = await fixture(t, 40); let response = await f.step(); const first = await f.review(response.active, 1); response = await f.step(['--input', first.input]); assert.equal(response.active.work_only, true);
  const incomplete = await f.review(response.active, 2, true); response = await f.step(['--input', incomplete.input]); assert.equal(response.state, 'monthly_material_deferred'); assert.equal(response.active.accepted.result_id, incomplete.r.result_id); assert.equal(response.started_bundles, 2);
  const again = await f.step(); assert.equal(again.state, 'monthly_material_deferred'); assert.equal(again.started_bundles, 2); const s = await createStore(f.cfg); try { assert.equal((await s.factMaterialProgress(incomplete.b.monthly_context!.facts_page!.snapshot_id))!.pending_work_count, 8); } finally { s.close(); }
});
test('work-only publication busy lock retains accepted identity and retries without a new start', async t => {
  const f = await fixture(t, 40); let response = await f.step(); const first = await f.review(response.active, 1); response = await f.step(['--input', first.input]); const second = await f.review(response.active, 2);
  const { acquireWikiLock } = await import('../../src/publish/lock.ts'); const lock = await acquireWikiLock(f.cfg.wiki_root); assert.ok(lock);
  try { const pending = await f.step(['--input', second.input]); assert.equal(pending.state, 'publication_pending'); assert.equal(pending.active.bundle_id, second.b.bundle_id); assert.equal(pending.active.accepted.result_id, second.r.result_id); assert.equal(pending.started_bundles, 2); const s = await createStore(f.cfg); try { assert.equal((await s.factMaterialProgress(second.b.monthly_context!.facts_page!.snapshot_id))!.pending_work_count, 8); } finally { s.close(); } } finally { await lock.release(); }
  response = await f.step(['--input', second.input]); assert.equal(response.terminal, true); assert.equal(response.started_bundles, 2); assert.equal(response.started_at, cutoff);
});
test('manual work-only CLI requires exact monthly frozen scope and rejects fresh material', () => {
  const base = ['prepare', '--kind', 'monthly', '--lane', 'history', '--period', '2026-09', '--fact-snapshot', 'snapshot:synthetic', '--fact-offset', '0', '--cutoff', cutoff, '--output', '/private/tmp/synthetic-output', '--work-only']; assert.equal(parseArgs(base).options['work-only'], true);
  assert.throws(() => parseArgs(base.concat('--pages', '/private/tmp/synthetic-pages.json')), /Work-only/); assert.throws(() => parseArgs(base.filter((v, i) => i !== base.indexOf('--fact-offset') && i !== base.indexOf('--fact-offset') + 1)), /Work-only/);
});
test('an unaccepted frozen empty month still starts ordinary semantics rather than inferring a prior conclusion', async t => {
  const f = await fixture(t, 40, 0), s = await createStore(f.cfg); const { createReviewer } = await import('../../src/review/index.ts');
  const prepared = (await createReviewer(s, f.cfg).prepare({ kind: 'monthly', lane: 'history', period: '2026-09', cutoff }))[0]; assert.equal(await s.hasCompleteMonthlyConclusion!(prepared.monthly_context!.facts_page!.snapshot_id), false); s.close();
  const response = await f.step(); assert.equal(response.state, 'monthly_review'); const active: ReviewBundle = JSON.parse(await readFile(response.active.file, 'utf8')); assert.equal(active.monthly_context!.work_only, undefined); assert.equal(active.bundle_id, prepared.bundle_id); assert.equal(response.started_bundles, 1);
});
test('actual status CLI exposes pending month metadata and the same fully-read frozen work continuation', async t => {
  const f = await fixture(t, 40), first = await f.step(), review = await f.review(first.active, 1), next = await f.step(['--input', review.input]); assert.equal(next.active.work_only, true);
  let stdout = '', stderr = ''; const code = await runCli(['status', '--config', f.configPath], { now: () => cutoff, stdout: v => stdout += v, stderr: v => stderr += v }); assert.equal(code, 0, stderr);
  const status = JSON.parse(stdout).monthly_semantic; assert.ok(status.pending_count >= 8); assert.equal(status.oldest_month, '2026-09'); const month = status.months.find((item: any) => item.month === '2026-09'); assert.ok(month.reasons.length); assert.equal(month.continuation.snapshot_id, review.b.monthly_context!.facts_page!.snapshot_id); assert.equal(month.continuation.cutoff, cutoff); assert.equal(month.continuation.offset, 2);
});
