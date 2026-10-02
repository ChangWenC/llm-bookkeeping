import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeCommand, parseArgs, runCli } from '../../src/cli.ts';
import { createStore } from '../../src/store/index.ts';
import { createRuntime } from '../../src/runtime.ts';
import { event, collection, bundle, result } from '../store/fixtures.ts';
import type { BookkeepingConfig, CollectionBatch } from '../../src/contracts/types.ts';

const cutoff = '2026-10-02T16:00:00Z';
const range = { schema_version: 1 as const, from: '2026-08-31T22:00:00Z', to: '2026-09-30T22:00:00Z' };
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'bookkeeping-scoped-capture-'));
  const config: BookkeepingConfig = {
    schema_version: 1, wiki_root: join(root, 'wiki'), data_dir: join(root, 'data'),
    journal_timezone: 'Europe/Amsterdam', analysis_timezone: 'Europe/Amsterdam', cutover_at: '2026-09-30T12:00:00Z', live_start: '2026-09-29T22:00:00Z',
    journal_timezone_timeline: [{ schema_version: 1, effective_from: '1970-01-01T00:00:00Z', timezone: 'Europe/Amsterdam', basis: 'synthetic' }],
    providers: [{ schema_version: 1, provider: 'codex', account_id: 'synthetic-account', enabled: true, roots: [join(root, 'sources')], options: {} }],
    limits: { chunk_events: 80, chunk_body_bytes: 32768, bundle_bytes: 131072, bundles_per_round: 4 }, project_whitelist: [], goal_whitelist: [],
  };
  await mkdir(config.wiki_root); await mkdir(config.providers[0].roots[0]);
  const path = join(root, 'config.json'); await writeFile(path, JSON.stringify(config));
  const records = [{ timestamp: '2026-10-02T15:00:00Z', type: 'session_meta', payload: { id: 'synthetic-scoped-session', source: 'vscode', originator: 'Codex Desktop' } }, ...[
    ['2026-08-15T12:00:00Z', 'synthetic-august'], ['2026-09-15T12:00:00Z', '9007199254740997'], ['2026-10-03T12:00:00Z', 'synthetic-after-cutoff'],
  ].map(([timestamp, id]) => ({ timestamp, type: 'event_msg', payload: { type: 'user_message', id, message: `Synthetic message ${id}` } }))];
  await writeFile(join(config.providers[0].roots[0], 'session.jsonl'), records.map(value => JSON.stringify(value) + '\n').join(''));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = async (args: string[]) => {
    let output = '', diagnostics = '';
    const code = await runCli([...args, '--config', path], { stdout: text => { output += text; }, stderr: text => { diagnostics += text; }, now: () => '2026-10-04T20:00:00Z' });
    return { code, json: JSON.parse(output), diagnostics };
  };
  const scoped = (from = range.from, to = range.to) => ['collect', '--lane', 'history', '--source', 'codex', '--from', from, '--to', to, '--cutoff', cutoff];
  return { root, config, path, cli, scoped };
}

test('exact frozen capture uses independent resumable checkpoints and creates no semantic replay work', async t => {
  const f = await fixture(t);
  const first = await f.cli(f.scoped());
  assert.equal(first.code, 0, first.diagnostics); assert.equal(first.json.cutoff, cutoff); assert.deepEqual(first.json.range, range);
  assert.equal(first.json.providers[0].events, 1);
  let store = await createStore(f.config);
  let identity: unknown;
  try {
    const events = await store.listEvents({ range: { schema_version: 1, from: '2026-01-01T00:00:00Z', to: '2027-01-01T00:00:00Z' }, include_context: true });
    assert.equal(events.length, 1); assert.equal(events[0].source.message_id, '9007199254740997');
    identity = events.map(value => [value.event_id, value.source, value.generation]);
    assert.equal((await store.listWork('semantic_replay')).length, 0);
    const checkpoints = await store.getCheckpoints('codex', 'history');
    assert.ok(checkpoints.length > 0 && checkpoints.every(value => value.cursor.manual_capture_scope === first.json.capture_scope));
  } finally { store.close(); }
  const repeated = await f.cli(f.scoped()); assert.equal(repeated.code, 0, repeated.diagnostics); assert.equal(repeated.json.capture_scope, first.json.capture_scope);
  store = await createStore(f.config);
  try {
    const events = await store.listEvents({ range, include_context: true });
    assert.deepEqual(events.map(value => [value.event_id, value.source, value.generation]), identity);
  } finally { store.close(); }
  const ordinary = await f.cli(['collect', '--lane', 'history', '--source', 'codex', '--cutoff', cutoff]);
  assert.equal(ordinary.code, 0, ordinary.diagnostics); assert.equal(ordinary.json.providers[0].events, 3, 'Ordinary capture does not borrow manual scoped completion');
  store = await createStore(f.config);
  let ordinaryCheckpoints: unknown;
  try { ordinaryCheckpoints = (await store.getCheckpoints('codex', 'history')).filter(value => value.cursor.manual_capture_scope === undefined); assert.ok((ordinaryCheckpoints as unknown[]).length); }
  finally { store.close(); }
  const second = await f.cli(f.scoped('2026-08-01T00:00:00Z', '2026-08-31T22:00:00Z'));
  assert.equal(second.code, 0, second.diagnostics); assert.notEqual(second.json.capture_scope, first.json.capture_scope); assert.equal(second.json.providers[0].events, 1, 'Different scope starts its own physical scan');
  store = await createStore(f.config);
  try {
    assert.deepEqual((await store.getCheckpoints('codex', 'history')).filter(value => value.cursor.manual_capture_scope === undefined), ordinaryCheckpoints);
    assert.equal((await store.listWork('semantic_replay')).length, 0);
  } finally { store.close(); }
});

test('scoped checkpoint IDs are unwrapped only for their scope, ordinary capture excludes them, and peer source failure continues', async t => {
  const f = await fixture(t);
  const store = await createStore(f.config);
  f.config.providers.push({ schema_version: 1, provider: 'wechat', account_id: 'synthetic-account', enabled: true, roots: [], options: {} });
  const captured = collection([event('synthetic-september', 'Synthetic body', '2026-09-15T12:00:00Z')], 'history');
  captured.events[0].source.provider = 'codex'; captured.events[0].source.account_id = 'synthetic-account';
  captured.coverage = [{ ...captured.coverage[0], provider: 'codex', account_id: 'synthetic-account', query_range: range, cutoff, read_ranges: [range] }];
  captured.checkpoints = [{ schema_version: 1, checkpoint_id: 'original-native-checkpoint', provider: 'codex', lane: 'history', locator: '/synthetic', generation: 'unchanged', cursor: { offset: 7 }, updated_at: cutoff }];
  const seen: unknown[][] = [];
  const services: any = { store, adapters: [{ provider: 'wechat', account_id: 'synthetic-account', async *collect() { throw new Error('Synthetic WeChat outage'); } }, { provider: 'codex', account_id: 'synthetic-account', async *collect(request: any, context: any) { seen.push(context.checkpoints); assert.equal(request.cutoff, cutoff); assert.deepEqual(request.range, range); yield captured; } }] };
  const args = ['collect', '--lane', 'history', '--from', range.from, '--to', range.to, '--cutoff', cutoff];
  try {
    const first: any = await executeCommand(parseArgs(args), f.config, services, '2026-10-05T20:00:00Z');
    assert.equal(first.providers[0].execution_status, 'partial'); assert.equal(first.providers[1].execution_status, 'complete');
    const second: any = await executeCommand(parseArgs(args), f.config, services, '2026-10-06T20:00:00Z'); assert.equal(second.capture_scope, first.capture_scope);
    assert.deepEqual(seen[0], []); assert.equal((seen[1][0] as any).checkpoint_id, 'original-native-checkpoint'); assert.equal((seen[1][0] as any).cursor.manual_capture_scope, undefined);
    let ordinarySeen: any;
    services.adapters = [{ provider: 'codex', async *collect(_request: any, context: any) { ordinarySeen = context.checkpoints; yield { ...captured, batch_id: 'ordinary-capture', events: [] }; } }];
    await executeCommand(parseArgs(['collect', '--lane', 'history', '--cutoff', cutoff]), f.config, services, cutoff);
    assert.deepEqual(ordinarySeen, []);
  } finally { store.close(); }
});

test('unknown capture time remains durable partial evidence and exact-range parameter mistakes reject', async t => {
  const f = await fixture(t), store = await createStore(f.config);
  const unknown = event('unknown-time'); unknown.source.provider = 'codex'; unknown.utc_time = { schema_version: 1, value: null, reason: 'Synthetic missing time' };
  const batch = collection([unknown], 'history'); batch.checkpoints = []; batch.coverage = [{ ...batch.coverage[0], provider: 'codex', query_range: range, cutoff }];
  try {
    const receipt: any = await executeCommand(parseArgs(f.scoped()), f.config, { store, adapters: [{ provider: 'codex', async *collect() { yield batch; } }] } as any, cutoff);
    assert.equal(receipt.coverage[0].capture_status, 'partial'); assert.ok(receipt.coverage[0].gaps.some((value: any) => value.reason === 'manual_capture_event_time_unknown'));
    assert.equal((await store.status()).events, 1);
  } finally { store.close(); }
  assert.throws(() => parseArgs(['collect', '--lane', 'history', '--from', range.from, '--to', range.to]), /cutoff/);
  assert.throws(() => parseArgs(f.scoped().map(value => value === 'history' ? 'live' : value)), /history/);
  assert.throws(() => parseArgs(['collect', '--lane', 'history', '--from', range.from, '--to', '2026-10-03T00:00:00Z', '--cutoff', cutoff]), /follow/);
});

test('CLI exact replay manifest validates bounded IDs before recapture and passes them without creating them', async t => {
  const f = await fixture(t), path = join(f.root, 'events.json');
  let selected: any, recaptured = false;
  const store: any = { getCheckpoints: async () => [], saveCollection: async () => {}, requestSemanticReplay: async (request: any) => { selected = request; return { work_id: 'replay:synthetic', state: 'pending', payload: { cutoff } }; } };
  const batch: CollectionBatch = collection([]); batch.coverage = [{ ...batch.coverage[0], provider: 'codex' }];
  const services: any = { store, adapters: [{ provider: 'codex', account_id: 'synthetic-account', async *replay() { recaptured = true; yield batch; } }] };
  const args = ['replay', '--source', 'codex', '--from', range.from, '--to', range.to, '--events', path];
  await writeFile(path, JSON.stringify({ schema_version: 1, event_ids: ['stable:2', 'stable:1'] }));
  await executeCommand(parseArgs(args), f.config, services, cutoff);
  assert.deepEqual(selected.event_ids, ['stable:2', 'stable:1']); assert.equal(recaptured, true);
  for (const ids of [[], ['duplicate', 'duplicate'], Array.from({ length: 65 }, (_, index) => String(index))]) {
    recaptured = false; await writeFile(path, JSON.stringify({ schema_version: 1, event_ids: ids }));
    await assert.rejects(executeCommand(parseArgs(args), f.config, services, cutoff), /unique event/); assert.equal(recaptured, false);
  }
});


test('exact WeChat zero-fact replay reviews only selected already accepted events and preserves omitted history', async t => {
  const f = await fixture(t);
  f.config.providers.push({ schema_version: 1, provider: 'wechat', account_id: 'self-synthetic', enabled: true, roots: [], options: { identity_verified: true, self_ids: ['self-synthetic'], group_allowlist: [], chat_types: { 'person-synthetic': 'private' } } });
  await writeFile(f.path, JSON.stringify(f.config));
  const rows = ['selected', 'omitted'].map(id => {
    const row = event(`event:wechat-${id}`, `Synthetic private ${id}`, '2026-09-15T12:00:00Z');
    row.source = { ...row.source, provider: 'wechat', account_id: 'self-synthetic', conversation_id: 'person-synthetic' };
    row.context = { is_group: false, chat_type: 'private', sender_wxid: 'self-synthetic', sender_id: 'self-synthetic', identity_verified: true, is_self: true };
    return row;
  });
  const captured = collection(rows, 'history', 'wechat-original-capture'); captured.checkpoints = [];
  captured.coverage = [{ ...captured.coverage[0], coverage_id: 'wechat-selected-original', provider: 'wechat', account_id: 'self-synthetic', query_range: range, cutoff, read_ranges: [range] }];
  const material = bundle(rows, 'wechat-original-bundle'); material.source = 'wechat'; material.coverage = captured.coverage; material.cutoff = cutoff;
  const original = result(material, 'wechat-original-zero', false); original.source = 'wechat'; original.created_at = cutoff;
  let store = await createStore(f.config);
  try { await store.saveCollection(captured); await store.saveBundle(material); await store.commitReview(original); }
  finally { store.close(); }
  const selection = join(f.root, 'wechat-selected-events.json'); await writeFile(selection, JSON.stringify({ schema_version: 1, event_ids: [rows[0].event_id] }));
  const cli = async (args: string[]) => {
    let stdout = '', stderr = '';
    const code = await runCli([...args, '--config', f.path], {
      stdout: value => { stdout += value; }, stderr: value => { stderr += value; }, now: () => cutoff,
      createRuntime: async (config, command, options, now) => {
        const runtime = await createRuntime(config, command, options, now);
        if (command === 'replay') runtime.adapters = [{ provider: 'wechat', account_id: 'self-synthetic', async *replay() { throw new Error('Synthetic WeChat recapture unavailable'); } }];
        return runtime;
      },
    });
    return { code, json: JSON.parse(stdout), stderr };
  };
  const args = ['replay', '--source', 'wechat', '--from', range.from, '--to', range.to, '--events', selection, '--replay-key', 'synthetic-selected-zero'];
  const replay = await cli(args); assert.equal(replay.code, 0, replay.stderr); assert.equal(replay.json.recapture[0].capture_status, 'unavailable');
  const output = join(f.root, 'wechat-zero-replay-material');
  const prepared = await cli(['prepare', '--kind', 'daily', '--lane', 'history', '--replay-id', replay.json.replay_id, '--output', output]);
  assert.equal(prepared.code, 0, prepared.stderr); assert.equal(prepared.json.bundles.length, 1);
  const selected = JSON.parse(await readFile(join(output, prepared.json.bundles[0]), 'utf8'));
  assert.deepEqual(selected.chunks.flatMap((chunk: any) => chunk.events.map((row: any) => row.event_id)), [rows[0].event_id]);
  const review = result(selected, 'wechat-selected-zero-result', false); review.source = 'wechat'; review.created_at = cutoff;
  const input = join(f.root, 'wechat-selected-zero-result.json'); await writeFile(input, JSON.stringify(review));
  const published = await cli(['publish', '--input', input]); assert.equal(published.code, 0, published.stderr); assert.equal(published.json.fact_commit, 'committed');
  store = await createStore(f.config);
  try {
    assert.deepEqual(await store.getReviewResult(original.result_id), original);
    assert.deepEqual((await store.getSemanticReplay(replay.json.replay_id))?.payload.event_ids, [rows[0].event_id]);
    assert.equal((await store.getSemanticReplay(replay.json.replay_id))?.state, 'complete');
    assert.equal((await store.readEffectiveFacts({ range })).length, 0);
    assert.equal((await store.listEvents({ range, source: 'wechat', include_context: true })).length, 2);
  } finally { store.close(); }
  const repeat = await cli(args); assert.equal(repeat.code, 0, repeat.stderr); assert.equal(repeat.json.replay_id, replay.json.replay_id); assert.equal(repeat.json.review_state, 'complete');
  await writeFile(selection, JSON.stringify({ schema_version: 1, event_ids: [rows[1].event_id] }));
  const conflict = await cli(args); assert.notEqual(conflict.code, 0); assert.match(conflict.stderr, /different|conflict|scope|selection/i);
});


test('scoped capture retains admitted WeChat participation context while excluding outside primary events', async t => {
  const f = await fixture(t), store = await createStore(f.config);
  f.config.providers.push({ schema_version: 1, provider: 'wechat', account_id: 'self-synthetic', enabled: true, roots: [], options: { group_allowlist: ['group-synthetic@chatroom'] } });
  const rows = [event('wechat-core', 'Synthetic core', '2026-08-31T22:01:00Z'), event('wechat-context', 'Synthetic participation context', '2026-08-31T21:50:00Z'), event('wechat-outside', 'Synthetic outside primary', '2026-08-31T21:50:00Z')];
  for (const row of rows) { row.source = { ...row.source, provider: 'wechat', account_id: 'self-synthetic', conversation_id: 'group-synthetic@chatroom' }; row.context = { is_group: true, identity_verified: true, sender_id: 'wxid_synthetic' }; }
  rows[1].context.context_only = true;
  const batch = collection(rows, 'history', 'synthetic-context-capture'); batch.checkpoints = [];
  batch.coverage = [{ ...batch.coverage[0], provider: 'wechat', account_id: 'self-synthetic', query_range: range, cutoff }];
  try {
    await executeCommand(parseArgs(['collect', '--lane', 'history', '--source', 'wechat', '--from', range.from, '--to', range.to, '--cutoff', cutoff]), f.config, { store, adapters: [{ provider: 'wechat', async *collect() { yield batch; } }] } as any, cutoff);
    const saved = await store.listEvents({ range: { ...range, from: '2026-08-31T21:40:00Z' }, source: 'wechat', include_context: true });
    assert.deepEqual(saved.map(value => value.event_id).sort(), ['wechat-context', 'wechat-core']);
  } finally { store.close(); }
});

test('real scoped CLI preserves already rewritten normal generations and native event IDs without advancing normal history', async t => {
  const f = await fixture(t);
  assert.equal((await f.cli(['collect', '--lane', 'history', '--source', 'codex', '--cutoff', cutoff])).code, 0);
  const changed = [
    { timestamp: '2026-10-02T15:00:00Z', type: 'session_meta', payload: { id: 'synthetic-scoped-session', source: 'vscode', originator: 'Codex Desktop' } },
    { timestamp: '2026-09-18T12:00:00Z', type: 'event_msg', payload: { type: 'user_message', id: '9007199254740997', message: 'Synthetic rewritten September message' } },
  ];
  await writeFile(join(f.config.providers[0].roots[0], 'session.jsonl'), changed.map(value => JSON.stringify(value) + '\n').join(''));
  const ordinary = await f.cli(['collect', '--lane', 'history', '--source', 'codex', '--cutoff', cutoff]); assert.equal(ordinary.code, 0, ordinary.diagnostics);
  let store = await createStore(f.config);
  let generations: unknown, ids: unknown, checkpoints: unknown;
  try {
    const current = await store.listEvents({ range, include_context: true });
    const rewritten = current.find(row => row.body === 'Synthetic rewritten September message')!;
    assert.ok(rewritten); assert.notEqual(rewritten.generation, '0'); assert.equal(rewritten.source.message_id, '9007199254740997');
    generations = current.map(row => [row.event_id, row.generation]); ids = current.map(row => row.event_id);
    checkpoints = await store.getCheckpoints('codex', 'history');
  } finally { store.close(); }
  const scoped = await f.cli(f.scoped()); assert.equal(scoped.code, 0, scoped.diagnostics); assert.equal(scoped.json.providers[0].events, 1);
  const repeated = await f.cli(f.scoped()); assert.equal(repeated.code, 0, repeated.diagnostics);
  store = await createStore(f.config);
  try {
    const current = await store.listEvents({ range, include_context: true });
    assert.deepEqual(current.map(row => row.event_id), ids); assert.deepEqual(current.map(row => [row.event_id, row.generation]), generations);
    assert.deepEqual((await store.getCheckpoints('codex', 'history')).filter(row => row.cursor.manual_capture_scope === undefined), checkpoints);
  } finally { store.close(); }
});

test('collection retry identities bind the frozen cutoff and known source identity conflicts do not claim a database outage or block peers', async t => {
  const f = await fixture(t), store = await createStore(f.config);
  f.config.providers.push({ schema_version: 1, provider: 'wechat', account_id: 'synthetic-wechat', enabled: true, roots: [], options: {} });
  const healthy = collection([], 'history', 'peer-synthetic-healthy'); healthy.checkpoints = []; healthy.coverage = [{ ...healthy.coverage[0], provider: 'wechat', account_id: 'synthetic-wechat', query_range: range, cutoff }];
  const adapters: any[] = [{ provider: 'codex', account_id: 'synthetic-account', async *collect() { throw new Error('Synthetic source unavailable'); } }, { provider: 'wechat', account_id: 'synthetic-wechat', async *collect() { yield healthy; } }];
  const args = ['collect', '--lane', 'history', '--from', range.from, '--to', range.to];
  try {
    for (const frozen of [cutoff, '2026-10-03T16:00:00Z', '2026-10-02T16:00:00.000Z']) {
      const receipt: any = await executeCommand(parseArgs([...args, '--cutoff', frozen]), f.config, { store, adapters } as any, '2026-10-05T00:00:00Z');
      assert.equal(receipt.providers[0].execution_status, 'partial'); assert.equal(receipt.providers[1].execution_status, 'complete');
    }
    const retries = await store.listWork('collection_retry');
    assert.equal(retries.length, 2); assert.notEqual(retries[0].work_id, retries[1].work_id);
    assert.deepEqual(retries.map(item => Date.parse(item.payload.cutoff as string)), [Date.parse(cutoff), Date.parse('2026-10-03T16:00:00Z')]);
    for (const conflict of ['Work identity conflict', 'Collection batch identity conflict']) {
      const save = store.saveCollection.bind(store); let failed = false;
      store.saveCollection = async captured => { if (!failed && captured.events.length) { failed = true; throw new Error(conflict); } await save(captured); };
      const failing = collection([event('synthetic-conflict-' + conflict)], 'history', 'synthetic-conflict-' + conflict);
      const sources: any[] = [{ provider: 'codex', account_id: 'synthetic-account', async *collect() { yield failing; } }, adapters[1]];
      const receipt: any = await executeCommand(parseArgs([...args, '--cutoff', cutoff]), f.config, { store, adapters: sources } as any, cutoff);
      assert.equal(receipt.providers[0].failure_kind, 'collection_identity_conflict'); assert.equal(receipt.providers[0].reason, conflict);
      assert.equal(receipt.providers[1].execution_status, 'complete'); assert.equal((await store.status()).pending_exports, 0);
      store.saveCollection = save;
    }
    store.saveCollection = async () => { const error = new Error('Synthetic SQLite write failure'); Object.assign(error, { code: 'ERR_SQLITE_ERROR' }); throw error; };
    await assert.rejects(executeCommand(parseArgs([...args, '--cutoff', cutoff]), f.config, { store, adapters: [{ provider: 'codex', async *collect() { yield healthy; } }] } as any, cutoff), (error: any) => error.code === 'BOOKKEEPING_STORAGE_FAILURE');
  } finally { store.close(); }
});

test('six frozen scoped history rounds preserve native IDs and ordinary checkpoints after live capture of an unresolved native event', async t => {
  const f = await fixture(t);
  const source = join(f.config.providers[0].roots[0], 'session.jsonl');
  await writeFile(source, [
    { timestamp: '2026-09-30T18:00:00Z', type: 'session_meta', payload: { id: 'synthetic-unknown-time', source: 'vscode', originator: 'Codex Desktop' } },
    { type: 'event_msg', payload: { type: 'user_message', id: 'synthetic-native-unknown-time', message: 'Synthetic original with unknown timestamp.' } },
  ].map(value => JSON.stringify(value) + '\n').join(''));
  const live = await f.cli(['collect', '--lane', 'live', '--source', 'codex', '--cutoff', cutoff]); assert.equal(live.code, 0, live.diagnostics);
  let store = await createStore(f.config); let nativeIds: unknown, ordinary: unknown;
  try {
    nativeIds = store.db.prepare('SELECT id FROM events ORDER BY id').all();
    ordinary = await store.getCheckpoints('codex', 'live');
    assert.equal((await store.listWork('event_identity_time')).length, 1);
  } finally { store.close(); }
  const frozen = f.scoped(range.from, cutoff); let scope: string | null = null;
  for (let round = 1; round <= 6; round++) {
    const receipt = await f.cli(frozen); assert.equal(receipt.code, 0, `Round${round}: ${receipt.diagnostics}`);
    assert.equal(receipt.json.providers[0].execution_status, 'complete', `Round${round}: ${receipt.json.providers[0].reason}`);
    scope ??= receipt.json.capture_scope; assert.equal(receipt.json.capture_scope, scope);
  }
  store = await createStore(f.config);
  try {
    assert.deepEqual(store.db.prepare('SELECT id FROM events ORDER BY id').all(), nativeIds);
    assert.deepEqual(await store.getCheckpoints('codex', 'live'), ordinary);
    assert.equal((await store.listWork('event_identity_time')).length, 1);
    assert.ok((await store.getCheckpoints('codex', 'history')).every(item => item.cursor.manual_capture_scope === scope));
  } finally { store.close(); }
});

test('six real Claude scoped metadata-only EOF captures persist honest fragment changes without reusing normal progress', async t => {
  const f = await fixture(t); f.config.providers[0].provider = 'claude'; await writeFile(f.path, JSON.stringify(f.config));
  await writeFile(join(f.config.providers[0].roots[0], 'session.jsonl'), [
    { type: 'file-history-snapshot', sessionId: 'synthetic-claude-metadata', timestamp: '2026-09-30T18:00:00Z', snapshot: { trackedFileBackups: {} } },
    { type: 'progress', sessionId: 'synthetic-claude-metadata', timestamp: '2026-09-30T18:01:00Z', data: { type: 'synthetic-progress' } },
  ].map(value => JSON.stringify(value) + '\n').join(''));
  const normal = await f.cli(['collect', '--lane', 'history', '--source', 'claude', '--cutoff', cutoff]); assert.equal(normal.code, 0, normal.diagnostics);
  let store = await createStore(f.config), ordinary: unknown;
  try { ordinary = await store.getCheckpoints('claude', 'history'); }
  finally { store.close(); }
  const frozen = ['collect', '--lane', 'history', '--source', 'claude', '--from', range.from, '--to', cutoff, '--cutoff', cutoff];
  for (let round = 1; round <= 6; round++) {
    const receipt = await f.cli(frozen); assert.equal(receipt.code, 0, `Round${round}: ${receipt.diagnostics}`);
    assert.equal(receipt.json.providers[0].execution_status, 'complete', `Round${round}: ${receipt.json.providers[0].reason}`);
  }
  store = await createStore(f.config);
  try {
    assert.deepEqual((await store.getCheckpoints('claude', 'history')).filter(item => item.cursor.manual_capture_scope === undefined), ordinary);
    assert.equal((await store.status()).events, 0);
    assert.ok(store.db.prepare('SELECT COUNT(*) AS n FROM collections').get()!.n! >= 2);
  } finally { store.close(); }
});
