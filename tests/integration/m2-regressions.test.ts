import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createStore } from '../../src/store/index.ts';
import { createPublisher } from '../../src/publish/index.ts';
import { createMonthlyConsumer } from '../../src/consumers/monthly/index.ts';
import { WechatAdapter } from '../../src/adapters/index.ts';
import { config as baseConfig } from '../../test/fixtures/basic.ts';
import type { FactRevision, SourceCheckpoint, CollectRequest, BookkeepingConfig } from '../../src/contracts/types.ts';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'bookkeeping-m2-regression-'));
  const config = { ...baseConfig, wiki_root: join(root, 'wiki'), data_dir: join(root, 'data') } as BookkeepingConfig;
  await mkdir(config.wiki_root);
  const store = await createStore(config);
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
  const batch = (await f.store.listReadyBatches('monthly-publish'))[0];
  const monthly = createMonthlyConsumer(f.store, f.config);
  await monthly.publishMonthlyReview({ ...batch, monthly_review: { schema_version: 1, month: '2026-07', summary: 'The synthetic result succeeded.', fact_refs: [{ schema_version: 1, fact_id: 'fact:summary', revision: 1 }], supplement_text: '', coverage_status: 'partial' } });
  await imported(f.store, fact('fact:summary', '', 'fact', 2, 'retract'), 'retract:summary');
  await createPublisher(f.store, f.config).resume();
  const body = await readFile(join(f.config.wiki_root, f.path), 'utf8');
  assert.match(body, /撤回|失效|重算|retract|invalidated/i, 'A removed represented fact must visibly invalidate its still-rendered old monthly summary');
  assert.equal((await f.store.readEffectiveFacts({ range: { schema_version: 1, from: '2026-07-01T00:00:00Z', to: '2026-08-01T00:00:00Z' } })).length, 0);
});

