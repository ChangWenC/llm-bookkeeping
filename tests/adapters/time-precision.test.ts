import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdapters, parseTime, parseLossless, parseWechatHistory } from '../../src/adapters/index.ts';
import { createStore } from '../../src/store/index.ts';
import { config as defaults } from '../../test/fixtures/basic.ts';
import type { BookkeepingConfig, CollectionBatch, CollectRequest } from '../../src/contracts/types.ts';

test('ISO fractions survive Z, offset and explicit IANA resolution without false precision', () => {
  for (const [raw, zone, expected, precision] of [
    ['2026-09-30T12:00:00.123456Z', undefined, '2026-09-30T12:00:00.123456Z', 'microsecond'],
    ['2026-10-01T00:00:00.000000001+02:00', undefined, '2026-09-30T22:00:00.000000001Z', 'nanosecond'],
    ['2026-09-30T23:59:59.999999999-0200', undefined, '2026-10-01T01:59:59.999999999Z', 'nanosecond'],
    ['2026-10-01 00:00:00.000001', 'Asia/Shanghai', '2026-09-30T16:00:00.000001Z', 'microsecond'],
    ['2026-10-01 00:00:00.000000001', 'Europe/Amsterdam', '2026-09-30T22:00:00.000000001Z', 'nanosecond'],
    ['1790769660.123456789', undefined, '2026-09-30T12:01:00.123456789Z', 'nanosecond'],
  ] as const) {
    const parsed = parseTime(raw, zone);
    assert.equal(parsed.utc, expected, raw);
    assert.equal(parsed.precision, precision, raw);
    assert.equal(parsed.reason, null, raw);
  }
  assert.equal(parseTime(-0.1).utc, '1969-12-31T23:59:59.9Z');
  assert.equal(parseTime('2026-10-01 00:00:00.000000001').reason, 'missing_wire_timezone');
  assert.equal(parseTime('2026-10-25 02:30:00.000000001', 'Europe/Amsterdam').reason, 'ambiguous_local_time');
  assert.equal(parseTime('2026-03-29 02:30:00.000001', 'Europe/Amsterdam').reason, 'nonexistent_local_time');
  assert.equal(parseTime('2026-02-30T12:00:00.123456Z').reason, 'invalid_time');
  assert.equal(parseTime('2026-09-30T12:00:00.1234567890Z').utc, null);
});

async function fixture(t: test.TestContext, travelBoundary = false) {
  const root = await mkdtemp(join(tmpdir(), 'bookkeeping-exact-time-'));
  const sourceRoot = join(root, 'source');
  await mkdir(sourceRoot);
  await mkdir(join(root, 'wiki'));
  const config: BookkeepingConfig = {
    ...defaults, wiki_root: join(root, 'wiki'), data_dir: join(root, 'data'),
    providers: [{ schema_version: 1, provider: 'codex', account_id: 'synthetic', enabled: true, roots: [sourceRoot], options: {} }],
    journal_timezone_timeline: [
      { schema_version: 1, effective_from: '2026-01-01T00:00:00Z', timezone: 'Europe/Amsterdam', basis: 'before travel' },
      ...(travelBoundary ? [{ schema_version: 1 as const, effective_from: '2026-09-30T10:00:00.000000001Z', timezone: 'Asia/Shanghai', basis: 'exact travel boundary' }] : []),
    ],
  };
  const input = [
    { type: 'session_meta', payload: { id: 'exact-session', source: 'vscode', thread_source: 'user' } },
    ...['000000000', '000000001', '000000002'].map((fraction, index) => ({
      timestamp: `2026-09-30T10:00:00.${fraction}Z`, type: 'event_msg',
      payload: { type: 'user_message', id: `native:${index}`, message: `synthetic ${index}` },
    })),
  ];
  await writeFile(join(sourceRoot, 'session.jsonl'), input.map(row => JSON.stringify(row) + '\n').join(''));
  const request: CollectRequest = {
    lane: 'live', cutoff: '2026-09-30T12:00:00Z',
    range: { schema_version: 1, from: '2026-09-30T00:00:00Z', to: '2026-09-30T12:00:00Z' },
    budget: { max_bytes: 1024 * 1024, max_directory_entries: 100, max_duration_ms: 10000 },
  };
  const batches: CollectionBatch[] = [];
  const adapter = createAdapters(config)[0];
  try {
    for await (const batch of adapter.collect(request, { config, checkpoints: [] })) batches.push(batch);
  } finally { if ('close' in adapter) await (adapter as any).close(); }
  const store = await createStore(config);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  return { store, batches, request };
}

test('actual file capture and SQLite preserve nanosecond half-open boundaries and exact timeline selection', async t => {
  const { store, batches } = await fixture(t, true);
  for (const batch of batches) await store.saveCollection(batch);
  const events = await store.listEvents({ range: { schema_version: 1, from: '2026-09-30T10:00:00.000000001Z', to: '2026-09-30T10:00:00.000000002Z' } });
  assert.equal(events.length, 1);
  assert.equal(events[0].source.message_id, 'native:1');
  assert.equal(events[0].original_time.value, '2026-09-30T10:00:00.000000001Z');
  assert.equal(events[0].time_precision, 'nanosecond');
  assert.equal(events[0].journal_timezone.value, 'Asia/Shanghai');
  const before = await store.listEvents({ range: { schema_version: 1, from: '2026-09-30T10:00:00Z', to: '2026-09-30T10:00:00.000000001Z' } });
  assert.equal(before.length, 1);
  assert.equal(before[0].journal_timezone.value, 'Europe/Amsterdam');
});


test('recapturing identical native ISO source enriches a saved truncated timestamp without duplicate or conflict', async t => {
  const { store, batches, request } = await fixture(t);
  for (const batch of batches) {
    const old = structuredClone(batch);
    old.batch_id = 'old-millisecond:' + old.batch_id;
    for (const event of old.events) {
      event.utc_time.value = new Date(event.utc_time.value!).toISOString();
      event.time_precision = 'microsecond';
    }
    await store.saveCollection(old);
  }
  for (const batch of batches) await store.saveCollection(batch);
  const events = await store.listEvents({ range: request.range });
  assert.equal(events.length, 3);
  assert.equal(events.find(event => event.source.message_id === 'native:1')!.utc_time.value, '2026-09-30T10:00:00.000000001Z');
  assert.equal(events.find(event => event.source.message_id === 'native:1')!.time_precision, 'nanosecond');
  assert.deepEqual(await store.listWork('event_conflict'), []);
});


test('source numeric epoch time lexemes are preserved before Number while unrelated decimals remain numeric', () => {
  const parsed = parseLossless('{"timestamp":1790769660.123456789,"payload":{"create_time":1790769660.123456,"epoch":1790769660.100},"other":1790769660.123456789,"text":"timestamp:1790769660.123456789"}');
  assert.equal(parsed.timestamp, '1790769660.123456789');
  assert.equal(parsed.payload.create_time, '1790769660.123456');
  assert.equal(parsed.payload.epoch, '1790769660.100');
  assert.equal(typeof parsed.other, 'number');
  assert.equal(parsed.text, 'timestamp:1790769660.123456789');
  assert.equal(parseLossless('{"time\\u0073tamp":1790769660.123456789}').timestamp, '1790769660.123456789');
  assert.equal(typeof parseLossless('{"timestamp":[1790769660.123456789]}').timestamp[0], 'number');
  const rounded = JSON.parse('{"create_time":1790769660.123456789}').create_time;
  assert.equal(parseTime(rounded).utc, null);
  assert.equal(parseTime(rounded).reason, 'numeric_time_precision_unproven');
});

test('numeric WeChat wire fractions reach actual SQLite nanosecond boundaries without lexical rounding', async t => {
  const { store } = await fixture(t);
  const config: BookkeepingConfig = {
    ...defaults,
    journal_timezone_timeline: [{ schema_version: 1, effective_from: '1970-01-01T00:00:00Z', timezone: 'Europe/Amsterdam', basis: 'synthetic' }],
    providers: [{ schema_version: 1, provider: 'wechat', enabled: true, roots: [], account_id: 'synthetic', options: {
      self_ids: ['synthetic'], identity_verified: true, cursor_readonly_verified: true,
      copy_verified_since: '2026-09-30T00:00:00Z', limit: 2000,
    } }],
  };
  const request: CollectRequest = {
    lane: 'live', cutoff: '2026-09-30T13:00:00Z',
    range: { schema_version: 1, from: '2026-09-30T12:00:00Z', to: '2026-09-30T13:00:00Z' },
    budget: { max_duration_ms: 10000, max_directory_entries: 100, max_bytes: 1024 * 1024 },
  };
  const raw = '{"meta":{"status":"windowed","since_resolved":1790769600,"until_resolved":1790773200,"shards_hit":1,"shards_scanned":1},"rows":[{"server_id":9223372036854775807,"sender_wxid":"synthetic","message_kind":"text","message_content":"synthetic numeric source","create_time":1790769660.123456789},{"server_id":9223372036854775806,"sender_wxid":"synthetic","message_kind":"text","message_content":"synthetic numeric peer","create_time":1790769660.123456790}]}';
  const parsed = parseWechatHistory(raw, config.providers[0], 'synthetic-chat', request, config);
  assert.equal(parsed.events[0].original_time.value, '1790769660.123456789');
  assert.equal(parsed.events[0].utc_time.value, '2026-09-30T12:01:00.123456789Z');
  assert.equal(parsed.events[0].time_precision, 'nanosecond');
  await store.saveCollection({ schema_version: 1, batch_id: 'numeric-wire-time', events: parsed.events, fragments: [], coverage: [], checkpoints: [] });
  const selected = await store.listEvents({ range: { schema_version: 1, from: '2026-09-30T12:01:00.123456789Z', to: '2026-09-30T12:01:00.123456790Z' } });
  assert.equal(selected.length, 1);
  assert.equal(selected[0].source.message_id, '9223372036854775807');
});
