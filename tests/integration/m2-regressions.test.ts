import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createStore } from '../../src/store/index.ts';
import { createPublisher } from '../../src/publish/index.ts';
import { createMonthlyConsumer } from '../../src/consumers/monthly/index.ts';
import { createReviewer } from '../../src/review/index.ts';
import { WechatAdapter } from '../../src/adapters/index.ts';
import { config as baseConfig } from '../../test/fixtures/basic.ts';
import type { FactRevision, SourceCheckpoint, CollectRequest, BookkeepingConfig, ReviewBundle, ReviewResult } from '../../src/contracts/types.ts';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'bookkeeping-m2-regression-'));
  const config = { ...baseConfig, wiki_root: join(root, 'wiki'), data_dir: join(root, 'data') } as BookkeepingConfig;
  await mkdir(config.wiki_root);
  const store = await createStore(config, { now: () => new Date('2026-10-01T00:00:00Z') });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const path = 'wiki/personal/journals/reviews/回顾_2026_07.md';
  const seed = async (body: string) => { await mkdir(dirname(join(config.wiki_root, path)), { recursive: true }); await writeFile(join(config.wiki_root, path), body); };
  return { config, store, path, seed };
}
const fact = (id: string, content: string, kind: FactRevision['kind'] = 'fact', revision = 1, action: FactRevision['action'] = 'assert'): FactRevision => ({
  schema_version: 1, fact_id: id, revision, content, kind, action,
  target_refs: action === 'assert' ? [] : [{ schema_version: 1, fact_id: id, revision: revision - 1 }],
  event_refs: [], subject: 'Roy', occurred_at: { schema_version: 1, value: null, reason: 'synthetic date-only record' },
  journal_date: { schema_version: 1, value: '2026-07-15', reason: null },
  analytics_projection: { schema_version: 1, value: null, reason: 'Personal synthetic fixture' },
  scope: ['personal'], attribution: kind === 'legacy_record' ? { legacy_baseline: true, source_format: 'daily-journal-jsonl-v1' } : {},
  recorded_at: `2026-09-${10 + revision}T12:00:00Z`, legacy_locator: kind === 'legacy_record' ? 'sealed:synthetic/daily:2026-07-15/section:0/item:0' : null,
});
async function imported(store: Awaited<ReturnType<typeof createStore>>, record: FactRevision, key: string) {
  await store.importLegacy({ schema_version: 1, migration_key: key, facts: [record], mappings: [], work: [] });
}
async function prepareMonthly(f: Awaited<ReturnType<typeof fixture>>) {
  const bundles = await createReviewer(f.store, f.config).prepare({ schema_version: 1, kind: 'monthly', lane: 'history', period: '2026-07', cutoff: '2026-10-01T00:00:00Z' });
  assert.equal(bundles.length, 1);
  return bundles[0];
}
async function publishPrepared(f: Awaited<ReturnType<typeof fixture>>, b: ReviewBundle, summary: string) {
  const context = b.monthly_context!;
  const result: ReviewResult = {
    schema_version: 1, result_id: `accepted-monthly:${b.bundle_id}`, bundle_id: b.bundle_id,
    chunks: b.chunks.map(chunk => ({ schema_version: 1, chunk_id: chunk.chunk_id, status: 'complete', reviewed_event_ids: [], zero_facts: true, reason: null })),
    candidates: [], pages: [], created_at: '2026-10-01T00:00:00Z',
    monthly_review: { schema_version: 1, month: context.month, summary, fact_refs: context.facts.map(fact => ({ schema_version: 1, fact_id: fact.fact_id, revision: fact.revision })), supplement_text: '', coverage_status: context.coverage_status, completed_work_ids: context.prepared_work_ids ?? [] },
  };
  const accepted = await f.store.commitReview(result);
  await createPublisher(f.store, f.config).exportFacts();
  const batch = (await f.store.getPublicationOutbox!(accepted.batch_id))!.artifact;
  assert.ok(await f.store.getPublicationBatchOrder!(accepted.batch_id), 'Publication must use real accepted identity/order proof');
  return createMonthlyConsumer(f.store, f.config, { now: () => new Date('2026-10-01T00:00:00Z') }).publishMonthlyReview(batch);
}

test('imported legacy archive is existing month context and is not displayed again as a new supplement', async t => {
  const f = await fixture(t);
  await f.seed('# 人工七月回顾\n\n旧原文已经属于本月历史背景。\n');
  await imported(f.store, fact('legacy:baseline', 'Existing original daily narrative', 'legacy_record'), 'migration:baseline');
  const result = await createPublisher(f.store, f.config).resume();
  assert.equal(result.export_status, 'ready');
  const body = await readFile(join(f.config.wiki_root, f.path), 'utf8');
  assert.ok(!body.includes('Existing original daily narrative'), 'Existing legacy archive body must not be replayed as newly added supplement prose');
  assert.equal((await f.store.readEffectiveFacts({ range: { schema_version: 1, from: '2026-07-01T00:00:00Z', to: '2026-08-01T00:00:00Z' } })).length, 1);
});

test('retraction of a monthly-summary represented fact visibly invalidates the old derived conclusion', async t => {
  const f = await fixture(t);
  await imported(f.store, fact('fact:summary', 'Original represented fact'), 'initial:summary');
  await createPublisher(f.store, f.config).exportFacts();
  const prepared = await prepareMonthly(f);
  assert.equal((await publishPrepared(f, prepared, 'The synthetic result succeeded.')).status, 'complete');
  await imported(f.store, fact('fact:summary', '', 'fact', 2, 'retract'), 'retract:summary');
  await createPublisher(f.store, f.config).resume();
  const body = await readFile(join(f.config.wiki_root, f.path), 'utf8');
  assert.match(body, /撤回|失效|重算|retract|invalidated/i, 'A removed represented fact must visibly invalidate its still-rendered old monthly summary');
  assert.equal((await f.store.readEffectiveFacts({ range: { schema_version: 1, from: '2026-07-01T00:00:00Z', to: '2026-08-01T00:00:00Z' } })).length, 0);
});


test('successful typed monthly publication acknowledges only explicitly reviewed preparation IDs', async t => {
  const f = await fixture(t);
  await imported(f.store, fact('fact:queue', 'Synthetic represented fact'), 'initial:queue');
  await createPublisher(f.store, f.config).exportFacts();
  const monthly = createMonthlyConsumer(f.store, f.config, { now: () => new Date('2026-10-01T00:00:00Z') });
  await monthly.consume();
  const prepared = await f.store.listWork('prepare_monthly', 'pending');
  assert.ok(prepared.length);
  const bundle = await prepareMonthly(f);
  await f.store.enqueueWork({ schema_version: 1, work_id: 'prepare-monthly:later', kind: 'prepare_monthly', state: 'pending', lane: 'history', payload: { month: '2026-07', batch_id: 'later-unread' }, reason: 'Synthetic after-bundle work', migration_key: null, updated_at: '2026-10-01T00:00:00Z' });
  const outcome = await publishPrepared(f, bundle, '已核验的合成月摘要。');
  assert.equal(outcome.status, 'complete');
  assert.deepEqual((await f.store.listWork('prepare_monthly', 'pending')).map(work => work.work_id), ['prepare-monthly:later']);
  const body = await readFile(join(f.config.wiki_root, f.path), 'utf8');
  assert.match(body, /type: journal\nnamespace: personal/);
  assert.match(body, /status: stable/); assert.match(body, /retention: pinned/);
});

test('monthly display snapshot refreshes each month once and never acknowledges a later batch', async t => {
  const f = await fixture(t);
  await f.seed('# 手工七月回顾\n');
  for (let index = 0; index < 5; index++) await imported(f.store, fact('legacy:group:' + index, 'existing baseline ' + index, 'legacy_record'), 'group:' + index);
  await createPublisher(f.store, f.config).exportFacts();
  const originalRead = f.store.readEffectiveFacts.bind(f.store);
  let reads = 0;
  f.store.readEffectiveFacts = async query => {
    reads++;
    if (reads === 1) {
      await imported(f.store, fact('fact:arrived-later', 'Synthetic later supplement'), 'later-after-snapshot');
      await createPublisher(f.store, f.config).exportFacts();
    }
    return originalRead(query);
  };
  await createPublisher(f.store, f.config).resume();
  assert.equal(reads, 1, 'Five historical outbox batches in one month require only one effective-month read');
  assert.equal((await f.store.listReadyBatches('monthly-display')).length, 1, 'After-snapshot batch is never accidentally acknowledged');
  await createPublisher(f.store, f.config).resume();
  assert.equal((await f.store.listReadyBatches('monthly-display')).length, 0);
  assert.equal(reads, 2);
});

test('coalesced monthly display failure remains local while another captured month acknowledges', async t => {
  const f = await fixture(t);
  await f.seed('# 七月手工回顾\n');
  const augustPath = join(f.config.wiki_root, 'wiki/personal/journals/reviews/回顾_2026_08.md');
  await writeFile(augustPath, '# 八月手工回顾\n');
  await imported(f.store, fact('fact:failed-july', 'July synthetic supplement'), 'failed-july');
  const august = fact('fact:successful-august', 'August synthetic supplement');
  august.journal_date.value = '2026-08-15';
  await imported(f.store, august, 'successful-august');
  await createPublisher(f.store, f.config).exportFacts();
  const result = await createPublisher(f.store, f.config, { fault(stage, operation) {
    if (stage === 'before_target' && operation.startsWith('monthly-supplement:2026-07:')) throw new Error('Synthetic July disk fault');
  } }).resume();
  assert.ok(result.pending.some(reason => reason.includes('monthly-display:2026-07')));
  const remaining = await f.store.listReadyBatches('monthly-display');
  assert.equal(remaining.length, 1);
  assert.ok(remaining[0].affected_dates.includes('2026-07-15'));
  assert.ok((await readFile(augustPath, 'utf8')).includes('August synthetic supplement'));
  await createPublisher(f.store, f.config).resume();
  assert.equal((await f.store.listReadyBatches('monthly-display')).length, 0);
});
