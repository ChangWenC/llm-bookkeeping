import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { continueDailyPlan, validateDailyPlan } from '../../src/daily-continuation.ts';
import { executeCommand, parseArgs, runCli } from '../../src/cli.ts';
import { createStore } from '../../src/store/index.ts';
import { createPublisher } from '../../src/publish/index.ts';
import { createRuntime } from '../../src/runtime.ts';
import { config as makeConfig, event, collection, bundle, result } from '../store/fixtures.ts';
import type { BookkeepingConfig, ReviewBundle } from '../../src/contracts/types.ts';

const cutoff = '2026-10-01T12:00:00Z';
async function fixture(t: test.TestContext) {
  const config = await makeConfig(), root = dirname(config.wiki_root);
  config.journal_timezone_timeline = [{ schema_version: 1, effective_from: '1970-01-01T00:00:00Z', timezone: 'Europe/Amsterdam', basis: 'synthetic' }];
  config.providers = ['wechat', 'codex'].map(provider => ({ schema_version: 1, provider, account_id: 'self-synthetic', enabled: true, roots: [], options: provider === 'wechat' ? { group_allowlist: [], identity_verified: true, self_ids: ['self-synthetic'] } : {} }));
  const path = join(root, 'config.json');
  await writeFile(path, JSON.stringify(config));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { config, root, path };
}
const step = (source: string, args: string[]) => ({ schema_version: 1, source, args });
const plan = (...steps: ReturnType<typeof step>[]) => ({ schema_version: 1, steps });

function providerBundle(provider: string): ReviewBundle {
  const row = event(`event:${provider}`);
  row.source = { ...row.source, provider, account_id: 'self-synthetic', conversation_id: 'person-synthetic' };
  row.context = { chat_type: 'private', sender_wxid: 'self-synthetic', is_self: true };
  const material = bundle([row], `bundle:${provider}`);
  material.source = provider;
  material.baselines[0].path = `wiki/projects/项目_${provider}.md`;
  material.coverage = [{ ...collection([row]).coverage[0], coverage_id: `coverage:${provider}`, provider, account_id: 'self-synthetic' }];
  return material;
}

async function seed(f: Awaited<ReturnType<typeof fixture>>) {
  const store = await createStore(f.config);
  const inputs: Record<string, string> = {};
  try {
    for (const source of ['wechat', 'codex']) {
      const material = providerBundle(source);
      const captured = collection(material.chunks[0].events, 'live', `collection:${source}`);
      captured.coverage = material.coverage;
      captured.checkpoints = [];
      await store.saveCollection(captured);
      await store.saveBundle(material);
      const review = result(material, `result:${source}`); review.source = source;
      inputs[source] = join(f.root, `${source}-result.json`);
      await writeFile(inputs[source], JSON.stringify(review));
    }
  } finally { store.close(); }
  return inputs;
}

test('manual source and UTC range controls validate coherently and retain the configured total budget', async t => {
  const f = await fixture(t);
  const args = ['prepare', '--kind', 'daily', '--lane', 'history', '--source', 'wechat', '--from', '2026-09-01T00:00:00Z', '--to', '2026-10-01T00:00:00Z', '--max-bundles', '1', '--output', join(f.root, 'materials')];
  let request: any;
  const receipt: any = await executeCommand(parseArgs(args), f.config, { reviewer: { prepare: async (value: any) => { request = value; return []; } } } as any, cutoff);
  assert.equal(request.source, 'wechat'); assert.equal(request.max_bundles, 1);
  assert.deepEqual(request.range, { schema_version: 1, from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z' });
  assert.equal(receipt.source, 'wechat');
  for (const extra of [['--period', '2026-09-30'], ['--replay-id', 'replay:synthetic']]) assert.throws(() => parseArgs([...args, ...extra]), /Explicit range/);
  for (const value of ['0', '-1', '1.5', '9007199254740992']) assert.throws(() => parseArgs(args.map((item, index) => args[index - 1] === '--max-bundles' ? value : item)), /positive safe/);
  await assert.rejects(executeCommand(parseArgs(args.map((item, index) => args[index - 1] === '--max-bundles' ? '5' : item)), f.config, {} as any, cutoff), /configured/);
  const unbounded = args.filter((_, index) => args[index] !== '--max-bundles' && args[index - 1] !== '--max-bundles');
  await assert.rejects(continueDailyPlan(plan(step('wechat', unbounded), step('codex', unbounded.map(item => item === 'wechat' ? 'codex' : item))), f.path), /total configured/);
  assert.throws(() => validateDailyPlan(plan(step('wechat', ['collect', '--lane', 'live']))), /requires/);
});

test('one material write failure preserves sibling bundles and reports durable provider-specific retry debt', async t => {
  const f = await fixture(t), output = join(f.root, 'materials');
  await mkdir(output); await symlink(join(f.root, 'unused'), join(output, 'bundle-bundle%3Awechat.json'));
  const store = await createStore(f.config);
  try {
    const bundles = ['wechat', 'codex'].map(providerBundle);
    for (const material of bundles) await store.saveBundle(material);
    const receipt: any = await executeCommand(parseArgs(['prepare', '--kind', 'daily', '--lane', 'history', '--output', output]), f.config, {
      store, reviewer: { prepare: async () => { throw new Error('Enhanced port must be used'); }, prepareWithOutcomes: async () => ({ schema_version: 1, bundles, providers: [{ schema_version: 1, provider: 'wechat', stage: 'prepare', execution_status: 'complete', reason: null, bundle_ids: [bundles[0].bundle_id] }] }) },
    } as any, cutoff);
    assert.deepEqual(receipt.bundles, ['bundle-bundle%3Acodex.json']);
    assert.ok(receipt.providers.some((item: any) => item.provider === 'wechat' && item.stage === 'material' && item.execution_status === 'partial'));
    assert.ok(receipt.providers.some((item: any) => item.provider === 'codex' && item.stage === 'material' && item.execution_status === 'complete'));
    assert.equal((await store.listWork('review_material_retry', 'pending'))[0].payload.provider, 'wechat');
    assert.equal(JSON.parse(await readFile(join(output, receipt.bundles[0]), 'utf8')).source, 'codex');
  } finally { store.close(); }
});

test('source read failure keeps independent collection running while Store write failure is global', async t => {
  const f = await fixture(t), store = await createStore(f.config);
  try {
    const material = providerBundle('codex');
    const captured = collection(material.chunks[0].events); captured.coverage = material.coverage; captured.checkpoints = [];
    const adapters = [{ provider: 'wechat', account_id: 'self-synthetic', async *collect() { throw new Error('Synthetic source read failure'); } }, { provider: 'codex', account_id: 'self-synthetic', async *collect() { yield captured; } }];
    const receipt: any = await executeCommand(parseArgs(['collect', '--lane', 'history']), f.config, { store, adapters } as any, cutoff);
    assert.equal(receipt.providers[0].execution_status, 'partial'); assert.equal(receipt.providers[1].execution_status, 'complete');
    assert.equal((await store.listEvents({ range: material.coverage[0].query_range })).length, 1);
    let continued = false, stdout = '';
    const code = await runCli(['collect', '--lane', 'history'], { loadConfig: async () => f.config, createRuntime: async () => ({ store: { getCheckpoints: async () => [], saveCollection: async () => { throw new Error('Synthetic local DB failure'); }, close() {} }, adapters: [{ provider: 'wechat', async *collect() { yield captured; } }, { provider: 'codex', async *collect() { continued = true; yield captured; } }] } as any), stdout: value => { stdout += value; }, stderr() {}, now: () => cutoff });
    assert.equal(code, 1); assert.equal(JSON.parse(stdout).error.scope, 'storage'); assert.equal(continued, false);
  } finally { store.close(); }
});

test('source review failure leaves the next source preparation eligible through real CLI routing', async t => {
  const f = await fixture(t);
  await seed(f);
  const receipt = await continueDailyPlan(plan(...['wechat', 'codex'].map(source => step(source, ['prepare', '--kind', 'daily', '--lane', 'history', '--source', source, '--max-bundles', '1', '--output', join(f.root, `material-${source}`)]))), f.path, {
    now: () => cutoff,
    createRuntime: async (config, command, options, now) => {
      const services = await createRuntime(config, command, options, now);
      if (command === 'prepare' && options?.source === 'wechat') services.reviewer = { prepare: async () => { throw new Error('Synthetic WeChat review failure'); } };
      return services;
    },
  });
  assert.deepEqual(receipt.receipts.map(item => item.exit_code), [1, 0]); assert.equal(receipt.remaining_steps, 0);
  assert.equal((receipt.receipts[1].result as any).bundles.length, 1);
});

for (const stage of ['commit', 'export', 'journal'] as const) test(`WeChat ${stage} failure does not prevent independent Codex semantic commit/export`, async t => {
  const f = await fixture(t), inputs = await seed(f);
  const receipt = await continueDailyPlan(plan(...['wechat', 'codex'].map(source => step(source, ['publish', '--input', inputs[source]]))), f.path, {
    now: () => cutoff,
    createRuntime: async (config, command, options, now) => {
      const services = await createRuntime(config, command, options, now);
      if (command === 'publish' && options?.input === inputs.wechat) {
        if (stage === 'commit') services.publisher.publish = async () => { throw new Error('Synthetic WeChat commit input failure'); };
        else services.publisher = createPublisher(services.store, config, { now, fault(point) { if (point === (stage === 'export' ? 'after_export_rename' : 'before_target')) throw new Error(`Synthetic WeChat ${stage} failure`); } });
      }
      return services;
    },
  });
  assert.equal(receipt.receipts.length, 2); assert.equal(receipt.receipts[1].exit_code, 0);
  const codex = receipt.receipts[1].result as any;
  assert.equal(codex.fact_commit, 'committed'); assert.equal(codex.export_status, 'ready');
  if (stage === 'commit') assert.equal(receipt.receipts[0].exit_code, 1);
  if (stage === 'export') assert.equal((receipt.receipts[0].result as any).export_status, 'pending');
  if (stage === 'journal') assert.equal((receipt.receipts[0].result as any).files[0].status, 'pending');
  const store = await createStore(f.config);
  try { assert.equal((await store.readEffectiveFacts({ range: providerBundle('codex').coverage[0].query_range })).length, stage === 'commit' ? 1 : 2); }
  finally { store.close(); }
});

test('an explicitly identified SQLite failure stops the plan and leaves later steps unexecuted', async t => {
  const f = await fixture(t), inputs = await seed(f); let calls = 0;
  const receipt = await continueDailyPlan(plan(step('wechat', ['publish', '--input', inputs.wechat]), step('codex', ['publish', '--input', inputs.codex])), f.path, {
    now: () => cutoff, createRuntime: async () => { calls++; throw Object.assign(new Error('Synthetic corrupted DB'), { code: 'ERR_SQLITE_ERROR' }); },
  });
  assert.equal(receipt.storage, 'unavailable'); assert.equal(receipt.remaining_steps, 1); assert.equal(calls, 1);
});
