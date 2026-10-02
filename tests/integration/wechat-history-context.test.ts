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
test('dense surrounding group context must not make every narrow history window irreducibly capped', async t => {
  const f = await fixture(t);
  const from = Date.parse('2026-09-30T12:00:00Z') / 1000;
  const config: BookkeepingConfig = { ...f.config, providers: [{ schema_version: 1, provider: 'wechat', account_id: 'owner', enabled: true, roots: [], options: {
    bundle_id: 'synthetic.group', group_allowlist: ['g@chatroom'], chats: ['g@chatroom'], self_ids: ['owner'], identity_verified: true,
    cursor_readonly_verified: true, verified_since_by_chat: { 'g@chatroom': '2026-09-01T00:00:00Z' }, limit: 3,
  } }] };
  const rows = [0, 1, 600, 601, 602].map(second => ({ server_id: `id:${second}`, chat_id: 'g@chatroom', sender_wxid: 'owner', create_time: from + second, message_kind: 'text', message_content: `synthetic ${second}` }));
  let calls = 0;
  const adapter = new WechatAdapter(config.providers[0], config, async (_binary, args) => {
    calls++;
    const since = Number(args[args.indexOf('--since') + 1]);
    const until = Number(args[args.indexOf('--until') + 1]);
    const limit = Number(args[args.indexOf('--limit') + 1]);
    // The verified upstream behavior returns the newest subset, sorted ascending.
    return JSON.stringify({ meta: { status: 'windowed', since_resolved: since, until_resolved: until, shards_scanned: 1, shards_hit: 1, unknown_shards: [], unreadable_shards: [] }, rows: rows.filter(row => row.create_time >= since && row.create_time < until).slice(-limit) });
  });
  const request: CollectRequest = { lane: 'history', cutoff: '2026-09-30T12:30:00Z', range: { schema_version: 1, from: '2026-09-30T12:00:00Z', to: '2026-09-30T12:00:02Z' }, budget: { max_duration_ms: 10000, max_bytes: 1024 * 1024, max_directory_entries: 100 } };
  for (let round = 0; round < 16; round++) {
    const checkpoints: SourceCheckpoint[] = await f.store.getCheckpoints('wechat', 'history');
    for await (const batch of adapter.collect(request, { config, checkpoints })) await f.store.saveCollection(batch);
  }
  const captured = await f.store.listEvents({ range: request.range });
  assert.equal(captured.length, 2, `All actual in-range messages must be enumerable; made ${calls} upstream queries`);
  const all = await f.store.listEvents({ range: { schema_version: 1, from: '2026-09-30T11:40:00Z', to: '2026-09-30T12:30:00Z' }, include_context: true });
  assert.equal(all.length, 5, 'Core-first paging also retrieves surrounding context through independently bounded windows');
  const checkpoint = (await f.store.getCheckpoints('wechat', 'history')).find(item => item.locator === 'wechat:g@chatroom')!;
  const history = checkpoint.cursor.history as { queue: unknown[]; blocked: unknown[] };
  assert.equal(history.queue.length, 0);
  assert.equal(history.blocked.length, 0);
  assert.ok(all.filter(event => Number(event.source.message_id?.slice(3)) >= 600).every(event => event.context.context_only === true));
});
