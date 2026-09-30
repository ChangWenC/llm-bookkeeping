import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWechatHistory, WechatAdapter } from '../../src/adapters/wechat.ts';
import { parseChatExport } from '../../src/adapters/imports.ts';
import { config } from '../../test/fixtures/basic.ts';
const from = '2026-09-30T12:00:00Z', to = '2026-09-30T12:01:00Z';
const request = { lane: 'history' as const, cutoff: to, range: { schema_version: 1 as const, from, to }, budget: { max_bytes: 100000, max_duration_ms: 10000, max_directory_entries: 100 } };
const options = { bundle_id: 'synthetic.bundle', self_ids: ['self-wxid'], identity_verified: true, aliases_verified: true, self_aliases: ['Roy'], mention_aliases: ['Roy'], cursor_readonly_verified: true };
test('verified alias fallbacks never override native IDs, explicit mentions or unverified identity', () => {
  const rows = [
    { server_id: 'alias', sender: ' ＲＯＹ ', message_content: 'synthetic own activity' },
    { server_id: 'native-other', sender_wxid: 'other-wxid', sender: 'Roy', message_content: 'native ID wins' },
    { server_id: 'mention', sender_wxid: 'other-wxid', message_content: '@Roy synthetic mention' },
    { server_id: 'false-mention', sender_wxid: 'other-wxid', message_content: '@Roy synthetic explicit false', is_mentioned: false },
    { server_id: 'substring', sender_wxid: 'other-wxid', message_content: '@Royal synthetic unrelated' },
  ].map(row => ({ ...row, create_time: Date.parse(from) / 1000, message_kind: 'text' }));
  const provider = { schema_version: 1 as const, provider: 'wechat', account_id: 'self-wxid', enabled: true, roots: [], options };
  const raw = JSON.stringify({ meta: { status: 'windowed', since_resolved: Date.parse(from) / 1000, until_resolved: Date.parse(to) / 1000, shards_scanned: 1, shards_hit: 1 }, rows });
  const parsed = parseWechatHistory(raw, provider, 'synthetic-chat', request, config).events;
  assert.equal(parsed.find(row => row.source.message_id === 'alias')?.role, 'user');
  assert.equal(parsed.find(row => row.source.message_id === 'native-other')?.role, 'other');
  assert.equal(parsed.find(row => row.source.message_id === 'mention')?.context.is_mentioned, true);
  assert.equal(parsed.find(row => row.source.message_id === 'false-mention')?.context.is_mentioned, false);
  assert.equal(parsed.find(row => row.source.message_id === 'substring')?.context.is_mentioned, false);
  const unverified = parseWechatHistory(raw, { ...provider, options: { ...options, aliases_verified: false } }, 'synthetic-chat', request, config).events;
  assert.equal(unverified.find(row => row.source.message_id === 'alias')?.role, 'unknown');
  const imported = parseChatExport(rows.map(row => JSON.stringify(row)).join('\n') + '\n', 'legacy-jsonl', { account_id: 'self-wxid', conversation_id: 'synthetic-chat', locator: '/synthetic', known_range: request.range, ...options }, config).events;
  assert.equal(imported.find(row => row.source.message_id === 'alias')?.role, 'user');
  assert.equal(imported.find(row => row.source.message_id === 'native-other')?.role, 'other');
});
test('pinned chats apply without sessions discovery while ignored and service holders remain excluded', async () => {
  const queried: string[] = [];
  const provider = { schema_version: 1 as const, provider: 'wechat', account_id: 'self-wxid', enabled: true, roots: [], options: { ...options, discover_sessions: false, pinned_chats: ['synthetic-pinned', 'ignored', 'OpenIMHolder'], ignored_chats: ['ignored'] } };
  const adapter = new WechatAdapter(provider, config, async (_binary, args) => {
    queried.push(args.join(' '));
    return JSON.stringify({ meta: { status: 'windowed', since_resolved: Date.parse(from) / 1000, until_resolved: Date.parse(to) / 1000, shards_scanned: 1, shards_hit: 1 }, rows: [] });
  });
  for await (const _batch of adapter.collect(request, { config, checkpoints: [] })) { /* fully consume */ }
  assert.equal(queried.length, 1);
  assert.ok(queried[0].includes('synthetic-pinned'));
  assert.ok(!queried[0].includes('OpenIMHolder') && !queried[0].includes('ignored'));
});
