import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WechatAdapter } from '../../src/adapters/index.ts';
import { hash } from '../../src/adapters/common.ts';
import { createStore } from '../../src/store/index.ts';
import { config as defaults } from '../../test/fixtures/basic.ts';
import type { BookkeepingConfig, CollectRequest, CollectionBatch, SourceCheckpoint } from '../../src/contracts/types.ts';
import type { HistoryCursor } from '../../src/adapters/wechat-history.ts';
const DAY = 86400000;
function fixtureConfig(): BookkeepingConfig {
  return {
    ...defaults,
    providers: [{ schema_version: 1, provider: 'wechat', account_id: 'synthetic-owner', enabled: true, roots: [], options: {
      bundle_id: 'synthetic.wechat', routing: 'managed_bundle', chats: ['synthetic-friend'],
      self_ids: ['synthetic-owner'], identity_verified: true, cursor_readonly_verified: true,
      copy_verified_since: '2026-09-25T00:00:00Z', limit: 2,
    } }],
    journal_timezone_timeline: [{ schema_version: 1, effective_from: '1970-01-01T00:00:00Z', timezone: 'Europe/Amsterdam', basis: 'synthetic history' }],
  };
}
function request(cutoff = '2026-10-01T00:00:00Z'): CollectRequest {
  return {
    lane: 'history', cutoff, range: { schema_version: 1, from: '1970-01-01T00:00:00Z', to: cutoff },
    budget: { max_duration_ms: 10000, max_bytes: 1024 * 1024, max_directory_entries: 100 },
  };
}
function oldCheckpoint(config: BookkeepingConfig, req: CollectRequest): SourceCheckpoint {
  return {
    schema_version: 1, checkpoint_id: hash(`wechat:synthetic-owner:history:synthetic-friend`),
    provider: 'wechat', lane: 'history', locator: 'wechat:synthetic-friend', generation: '0',
    cursor: { account_id: 'synthetic-owner', bundle_id: 'synthetic.wechat', history: {
      root_from: req.range.from, root_to: '2026-09-30T00:00:00Z', queue: [], blocked: [],
    } }, updated_at: '2026-09-30T00:00:00Z',
  };
}
function advance(checkpoints: SourceCheckpoint[], batches: CollectionBatch[]): SourceCheckpoint[] {
  const byId = new Map(checkpoints.map(checkpoint => [checkpoint.checkpoint_id, checkpoint]));
  for (const batch of batches) for (const checkpoint of batch.checkpoints) byId.set(checkpoint.checkpoint_id, checkpoint);
  return [...byId.values()];
}
function cursor(checkpoints: SourceCheckpoint[]): HistoryCursor {
  return checkpoints.find(checkpoint => checkpoint.locator === 'wechat:synthetic-friend')!.cursor.history as unknown as HistoryCursor;
}
function row(id: string, instant: string) {
  return { server_id: id, local_id: id, sender_wxid: 'synthetic-owner', create_time: Date.parse(instant) / 1000,
    message_kind: 'text', message_content: 'synthetic late record' };
}
function runner(config: BookkeepingConfig, rows: ReturnType<typeof row>[], calls: { from: number; to: number }[], failure?: (from: number, to: number) => boolean) {
  return async (_binary: string, args: string[]) => {
    if (args[0] === 'accounts') return JSON.stringify({ accounts: [{ bundle_id: 'synthetic.wechat', wxid: 'synthetic-owner' }] });
    assert(args.includes('--no-transcribe'));
    assert(!args.includes('--account'));
    assert(!args.includes('new-messages'));
    const from = Number(args[args.indexOf('--since') + 1]);
    const to = Number(args[args.indexOf('--until') + 1]);
    calls.push({ from, to });
    if (failure?.(from, to)) throw new Error('synthetic unavailable old shard');
    return JSON.stringify({ meta: { status: 'windowed', since_resolved: from, until_resolved: to,
      shards_hit: 1, shards_scanned: 1, unknown_shards: [], unreadable_shards: [] },
      rows: rows.filter(item => item.create_time >= from && item.create_time < to).slice(-Number(config.providers[0].options.limit)) });
  };
}
async function collect(config: BookkeepingConfig, req: CollectRequest, checkpoints: SourceCheckpoint[], run: ReturnType<typeof runner>) {
  const batches: CollectionBatch[] = [];
  for await (const batch of new WechatAdapter(config.providers[0], config, run).collect(req, { config, checkpoints })) batches.push(batch);
  return batches;
}

test('completed legacy history checkpoint captures a later inserted old message through persistent sweep and actual SQLite', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bookkeeping-wechat-late-'));
  await mkdir(join(root, 'wiki'));
  const config = { ...fixtureConfig(), wiki_root: join(root, 'wiki'), data_dir: join(root, 'data') };
  const store = await createStore(config);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const req = request(), checkpoint = oldCheckpoint(config, req);
  await store.saveCollection({ schema_version: 1, batch_id: 'completed-before-arrival', events: [], fragments: [], coverage: [], checkpoints: [checkpoint] });
  const calls: { from: number; to: number }[] = [];
  const run = runner(config, [row('9223372036854775807', '2026-09-26T12:00:00Z')], calls);
  for (const batch of await collect(config, req, await store.getCheckpoints('wechat', 'history'), run)) await store.saveCollection(batch);
  const captured = await store.listEvents({ range: { schema_version: 1, from: '2026-09-26T00:00:00Z', to: '2026-09-27T00:00:00Z' }, lane: 'history' });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].source.message_id, '9223372036854775807');
  assert.equal(captured[0].context.context_only, false);
  assert(cursor(await store.getCheckpoints('wechat', 'history')).late_sweep);
  const persisted = await store.getCheckpoints('wechat', 'history');
  for (const batch of await collect(config, req, persisted, run)) await store.saveCollection(batch);
  assert.equal((await store.listEvents({ range: req.range, lane: 'history' })).length, 1);
  assert.deepEqual(await store.listWork('event_conflict'), []);
  assert((await store.listCoverage(req.range)).some(coverage => coverage.gaps.some(gap => gap.reason === 'wechat_copy_history_range_unverified')));
  const live = { ...req, lane: 'live' as const, range: { ...req.range, from: '2026-09-29T00:00:00Z' } };
  assert.equal((await collect(config, live, persisted, run)).flatMap(batch => batch.events).length, 0);
});

test('1970 empty history sweeps recent windows first, grows empty spans, resumes across restart and waits between cycles', async () => {
  const config = fixtureConfig(), req = request();
  let checkpoints = [oldCheckpoint(config, req)];
  const calls: { from: number; to: number }[] = [];
  const run = runner(config, [], calls);
  const oldEnd = Date.parse(req.cutoff) / 1000 - 2 * DAY / 1000;
  for (let round = 0; round < 14 && !cursor(checkpoints).late_sweep?.next_cycle_at; round++) {
    const before = calls.length;
    const batches = await collect(config, req, checkpoints, run);
    assert(calls.length - before <= 2, 'one new core window plus at most one late window per chat');
    checkpoints = advance(checkpoints, batches);
  }
  const late = calls.filter(call => call.to <= oldEnd);
  assert.equal(late[0].to, oldEnd);
  assert.equal(late[0].to - late[0].from, 7 * DAY / 1000);
  assert(late.every((call, index) => !index || call.to <= late[index - 1].from));
  assert(late.length <= 12, 'empty decades must not require one query per day or per week');
  assert.equal(Date.parse(cursor(checkpoints).late_sweep!.frontier), Date.parse(req.range.from));
  assert(cursor(checkpoints).late_sweep!.next_cycle_at);
  const count = calls.length;
  checkpoints = advance(checkpoints, await collect(config, req, checkpoints, run));
  assert.equal(calls.length, count);
  const tomorrow = request('2026-10-02T00:00:00Z');
  const batches = await collect(config, tomorrow, checkpoints, run);
  assert(calls.slice(count).some(call => call.to === Date.parse(tomorrow.cutoff) / 1000 - 2 * DAY / 1000));
  assert(cursor(advance(checkpoints, batches)).late_sweep!.frontier > req.range.from);
});

test('late shard failure rotates behind fresh older windows while newly extended core still advances', async () => {
  const config = fixtureConfig(), req = request();
  let checkpoints = [oldCheckpoint(config, req)];
  const calls: { from: number; to: number }[] = [];
  const failEnd = Date.parse(req.cutoff) / 1000 - 2 * DAY / 1000;
  const run = runner(config, [], calls, (_from, to) => to === failEnd);
  const first = await collect(config, req, checkpoints, run);
  checkpoints = advance(checkpoints, first);
  const failed = cursor(checkpoints).late_sweep!.deferred!.find(window => window.retry_after)!;
  assert(failed);
  const next = request('2026-10-02T00:00:00Z');
  const before = calls.length;
  checkpoints = advance(checkpoints, await collect(config, next, checkpoints, run));
  const secondCalls = calls.slice(before);
  assert(secondCalls.some(call => call.from === Date.parse(req.cutoff) / 1000 && call.to === Date.parse(next.cutoff) / 1000));
  assert(secondCalls.some(call => call.to === Date.parse(failed.from) / 1000));
  assert.equal(cursor(checkpoints).queue.length, 0);
  assert(cursor(checkpoints).late_sweep!.deferred!.some(window => window.retry_after));
});

test('late same-second cap stays an explicit import gap and is not retried on every round or next cycle', async () => {
  const config = fixtureConfig(), req = request();
  const checkpoint = oldCheckpoint(config, req), second = '2026-09-26T12:00:00Z';
  checkpoint.cursor.history = {
    root_from: req.range.from, root_to: req.range.to, queue: [], blocked: [], initial_core_complete: true,
    late_sweep: { root_from: req.range.from, root_to: '2026-09-29T00:00:00Z', frontier: req.range.from, window_ms: 7 * DAY, next_cycle_at: null,
      queue: [{ from: second, to: '2026-09-26T12:00:01Z', depth: 0 }], blocked: [] },
  };
  let checkpoints = [checkpoint];
  const calls: { from: number; to: number }[] = [];
  const run = runner(config, [row('1', second), row('2', second)], calls);
  const first = await collect(config, req, checkpoints, run);
  checkpoints = advance(checkpoints, first);
  assert.equal(cursor(checkpoints).late_sweep!.blocked.length, 1);
  assert(first.flatMap(batch => batch.coverage).some(coverage => coverage.gaps.some(gap => gap.reason.includes('dense_second'))));
  await collect(config, req, checkpoints, run);
  assert.equal(calls.length, 1);
  const next = request('2026-10-02T00:00:00Z');
  for (let round = 0; round < 3; round++) checkpoints = advance(checkpoints, await collect(config, next, checkpoints, run));
  assert(calls.slice(1).every(call => !(call.from <= Date.parse(second) / 1000 && call.to > Date.parse(second) / 1000)));
});

test('initial capped history reports late risk and enters sweep only after initial core drains', async () => {
  const config = fixtureConfig(), req = request();
  config.providers[0].options.history_queries_per_round = 1;
  const checkpoint = oldCheckpoint(config, req);
  const second = '2026-09-26T12:00:00Z';
  (checkpoint.cursor.history as unknown as HistoryCursor).queue = [{ from: second, to: '2026-09-26T12:00:01Z', depth: 0 }];
  let checkpoints = [checkpoint];
  const run = runner(config, [row('1', second), row('2', second)], []);
  const first = await collect(config, req, checkpoints, run);
  checkpoints = advance(checkpoints, first);
  assert.equal(cursor(checkpoints).late_sweep, undefined);
  assert(first.flatMap(batch => batch.coverage).some(coverage => coverage.gaps.some(gap => gap.reason === 'wechat_late_arrivals_waiting_for_initial_history')));
  for (let round = 0; round < 3 && !cursor(checkpoints).late_sweep; round++)
    checkpoints = advance(checkpoints, await collect(config, req, checkpoints, run));
  assert(cursor(checkpoints).initial_core_complete);
  assert(cursor(checkpoints).late_sweep);
  assert.equal(cursor(checkpoints).blocked.length, 1);
});

test('late group context queue is retained after the final core sweep window and completes on restart', async () => {
  const config = fixtureConfig(), req = request();
  req.range.from = '2026-09-26T00:00:00Z';
  config.providers[0].options.chats = ['synthetic-group@chatroom'];
  const checkpoint = oldCheckpoint(config, req);
  checkpoint.locator = 'wechat:synthetic-group@chatroom';
  checkpoint.checkpoint_id = hash('wechat:synthetic-owner:history:synthetic-group@chatroom');
  const calls: { from: number; to: number }[] = [];
  const run = runner(config, [row('anchor', '2026-09-26T12:00:00Z')], calls);
  const first = await collect(config, req, [checkpoint], run);
  let checkpoints = advance([checkpoint], first);
  const history = () => checkpoints.find(checkpoint => checkpoint.locator === 'wechat:synthetic-group@chatroom')!.cursor.history as unknown as HistoryCursor;
  assert(history().late_sweep!.queue.some(window => window.purpose === 'context'));
  assert.equal(history().late_sweep!.next_cycle_at, null);
  checkpoints = advance(checkpoints, await collect(config, req, checkpoints, run));
  assert.equal(history().late_sweep!.queue.length, 0);
  assert(history().late_sweep!.next_cycle_at);
  assert.equal(history().late_sweep!.blocked.length, 0);
});

test('permanent deferred shard cannot freeze sweep snapshots across daily cutoffs and failed debt survives', async () => {
  const config = fixtureConfig();
  const first = request('2026-10-01T00:00:00Z');
  first.range.from = '2026-09-28T00:00:00Z';
  const checkpoint = oldCheckpoint(config, first);
  (checkpoint.cursor.history as unknown as HistoryCursor).root_to = first.cutoff;
  let checkpoints = [checkpoint];
  const calls: { from: number; to: number }[] = [];
  const failedFrom = Date.parse(first.range.from) / 1000;
  const failedTo = Date.parse(first.cutoff) / 1000 - 2 * DAY / 1000;
  const lateRecord = row('newly-aged-late', '2026-09-30T12:00:00Z');
  const run = runner(config, [lateRecord], calls, (from, to) => from === failedFrom && to === failedTo);
  checkpoints = advance(checkpoints, await collect(config, first, checkpoints, run));
  assert.equal(cursor(checkpoints).late_sweep!.deferred!.length, 1);
  assert(cursor(checkpoints).late_sweep!.next_cycle_at);
  for (const cutoff of ['2026-10-02T01:00:00Z', '2026-10-03T02:00:00Z']) {
    const next = request(cutoff); next.range.from = first.range.from;
    const before = calls.length;
    const batches = await collect(config, next, checkpoints, run);
    assert(calls.length - before <= 4);
    checkpoints = advance(checkpoints, batches);
    assert.equal(cursor(checkpoints).late_sweep!.root_to, new Date(Date.parse(cutoff) - 2 * DAY).toISOString());
    assert(cursor(checkpoints).late_sweep!.deferred!.some(window => Date.parse(window.from) === failedFrom * 1000 && Date.parse(window.to) === failedTo * 1000));
    assert(batches.flatMap(batch => batch.coverage).some(coverage => coverage.gaps.some(gap => gap.reason.startsWith('wechat_late_arrival_retry_deferred'))));
  }
  assert(calls.filter(call => call.from === failedFrom && call.to === failedTo).length >= 2, 'old failed debt receives a bounded retry');
  assert(calls.some(call => call.to === Date.parse('2026-10-01T02:00:00Z') / 1000), 'latest completed range entered a refreshed sweep');
});

test('one-query budget preserves deferred preference across cycles instead of starving failed old debt', async () => {
  const config = fixtureConfig(); config.providers[0].options.history_queries_per_round = 1;
  const req = request(); req.range.from = '2026-09-28T00:00:00Z';
  const checkpoint = oldCheckpoint(config, req);
  const failedFrom = Date.parse(req.range.from) / 1000, failedTo = Date.parse(req.cutoff) / 1000 - 2 * DAY / 1000;
  checkpoint.cursor.history = {
    root_from: req.range.from, root_to: req.cutoff, queue: [], blocked: [], initial_core_complete: true,
    late_sweep: { root_from: req.range.from, root_to: new Date(failedTo * 1000).toISOString(), frontier: req.range.from,
      window_ms: 7 * DAY, queue: [], blocked: [], next_cycle_at: req.cutoff, deferred_turn_due: true,
      deferred: [{ from: req.range.from, to: new Date(failedTo * 1000).toISOString(), depth: 0, retry_after: req.cutoff }] },
  };
  let checkpoints = [checkpoint];
  const calls: { from: number; to: number }[] = [];
  const run = runner(config, [], calls, (from, to) => from === failedFrom && to === failedTo);
  const first = await collect(config, req, checkpoints, run);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { from: failedFrom, to: failedTo });
  checkpoints = advance(checkpoints, first);
  assert.equal(cursor(checkpoints).late_sweep!.deferred_turn_due, false);
  for (let day = 2; day <= 9; day++) {
    const next = request(`2026-10-${String(day).padStart(2, '0')}T01:00:00Z`); next.range.from = req.range.from;
    const before = calls.length;
    checkpoints = advance(checkpoints, await collect(config, next, checkpoints, run));
    assert(calls.length - before <= 1);
  }
  assert(calls.some(call => call.from === failedFrom && call.to > failedTo), 'fresh late work still advances under a one-query budget');
  assert(calls.filter(call => call.from === failedFrom && call.to === failedTo).length >= 2);
  assert(cursor(checkpoints).late_sweep!.deferred!.length >= 1);
});
