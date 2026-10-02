import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WechatAdapter, parseWechatHistory, parseChatExport } from '../../src/adapters/index.ts';
import { wechatConversationScope } from '../../src/adapters/wechat-policy.ts';
import { createMigrationService } from '../../src/migration/index.ts';
import { createStore } from '../../src/store/index.ts';
import { config as defaults } from '../../test/fixtures/basic.ts';
import type { BookkeepingConfig, CollectRequest, CollectionBatch } from '../../src/contracts/types.ts';
function config(): BookkeepingConfig {
  return { ...defaults, providers: [{ schema_version: 1, provider: 'wechat', account_id: 'wxid_owner', enabled: true, roots: [], options: {
    bundle_id: 'synthetic.wechat', group_allowlist: ['selected@chatroom'], self_ids: ['wxid_owner'],
    identity_verified: true, cursor_readonly_verified: true, copy_verified_since: '2026-09-30T00:00:00Z', limit: 100,
  } }] };
}
const request: CollectRequest = { lane: 'live', cutoff: '2026-10-01T00:00:00Z', range: { schema_version: 1, from: '2026-09-30T00:00:00Z', to: '2026-10-01T00:00:00Z' }, budget: { max_duration_ms: 10000, max_bytes: 1024 * 1024, max_directory_entries: 100 } };
function payload(rows: Record<string, unknown>[], args?: string[]) {
  return JSON.stringify({ meta: { status: 'ok', shards_scanned: 1, shards_hit: 1,
    since_resolved: args ? Number(args[args.indexOf('--since') + 1]) : Date.parse(request.range.from) / 1000,
    until_resolved: args ? Number(args[args.indexOf('--until') + 1]) : Date.parse(request.range.to) / 1000 }, rows });
}
function row(id = 'native-message', sender: string | null = 'wxid_owner', minute = 0) {
  return { server_id: id, sender_wxid: sender, create_time: Date.parse('2026-09-30T12:00:00Z') / 1000 + minute * 60, message_kind: 'text', message_content: 'anonymous fixture' };
}
test('exact allowlist rejects discovered and pinned groups before body calls despite changed or missing group names', async () => {
  const c = config(), options = c.providers[0].options;
  options.chats = ['excluded@chatroom', 'unclassified-stable-id']; options.pinned_chats = ['pinned@chatroom']; options.discover_sessions = true;
  const asked: string[] = [], batches: CollectionBatch[] = [];
  const runner = async (_binary: string, args: string[]) => {
    if (args.includes('sessions')) return JSON.stringify({ meta: { status: 'ok' }, rows: [
      { username: 'selected@chatroom', chat_type: 'group', nickname: 'renamed anonymous group' },
      { username: 'unnamed@chatroom', chat_type: 'group' },
      { username: 'private-friend', chat_type: 'private' }, { username: 'filehelper', chat_type: 'unknown' },
      { username: 'gh_service', chat_type: 'private' },
    ] });
    const chat = args[args.indexOf('--chat') + 1]; asked.push(chat);
    assert(!['excluded@chatroom', 'pinned@chatroom', 'unnamed@chatroom', 'gh_service', 'unclassified-stable-id'].includes(chat));
    return payload(chat.endsWith('@chatroom') ? [row('anchor'), row('near', 'wxid_other', 19), row('far', 'wxid_other', 21)] : [row()], args);
  };
  for await (const batch of new WechatAdapter(c.providers[0], c, runner).collect(request, { config: c, checkpoints: [] })) batches.push(batch);
  assert.deepEqual(asked.sort(), ['filehelper', 'private-friend', 'selected@chatroom']);
  const group = batches.flatMap(b => b.events).filter(e => e.source.conversation_id === 'selected@chatroom');
  assert.deepEqual(group.map(e => e.source.message_id), ['anchor', 'near']);
  assert.equal(group[1].context.context_only, true);
  assert.equal(group[0].context.is_group, true);
});
test('empty group list excludes all groups; malformed scope fails only the adapter before queries', async () => {
  const c = config(); c.providers[0].options.chats = ['selected@chatroom']; c.providers[0].options.group_allowlist = [];
  let calls = 0;
  const runner = async () => { calls++; throw new Error('body query forbidden'); };
  for await (const _ of new WechatAdapter(c.providers[0], c, runner).collect(request, { config: c, checkpoints: [] })) {}
  assert.equal(calls, 0);
  c.providers[0].options.group_allowlist = 'selected@chatroom';
  const batches: CollectionBatch[] = [];
  for await (const batch of new WechatAdapter(c.providers[0], c, runner).collect(request, { config: c, checkpoints: [] })) batches.push(batch);
  assert.equal(calls, 0); assert.equal(batches[0].coverage[0].capture_status, 'unavailable');
  assert.equal(batches[0].coverage[0].gaps[0].reason, 'wechat_group_allowlist_invalid');
  assert.equal(wechatConversationScope({ group_allowlist: [] }, 'private', 'unknown').admitted, false);
  assert.equal(wechatConversationScope({}, 'old@chatroom').admitted, true);
  assert.equal(wechatConversationScope({ group_allowlist: [] }, 'unclassified').reason, 'wechat_conversation_type_unknown');
  assert.equal(wechatConversationScope({ group_allowlist: [] }, 'private', 'private').admitted, true);
  assert.equal(wechatConversationScope({ group_allowlist: [], chat_types: { private: 'private' } }, 'private').admitted, true);
  assert.equal(wechatConversationScope({ group_allowlist: [], chat_types: { private: 'private' } }, 'private', 'group').admitted, false);
});
test('excluded export bodies and excluded history are not parsed or decoded', () => {
  const c = config(), bytes = Buffer.from('malformed anonymous body');
  bytes.toString = () => { throw new Error('excluded body decoded'); };
  for (const format of ['chatlab-json', 'chatlab-jsonl', 'legacy-json', 'legacy-jsonl'] as const) {
    const parsed = parseChatExport(bytes, format, { account_id: 'wxid_owner', conversation_id: 'excluded@chatroom', conversation_type: 'group', locator: 'anonymous-export' }, c);
    assert.deepEqual(parsed.events, []); assert.deepEqual(parsed.members, []); assert.deepEqual(parsed.metadata, {});
    assert.equal(parsed.gaps[0].reason, 'wechat_group_not_allowlisted');
  }
  assert.equal(parseChatExport(bytes, 'legacy-json', { account_id: 'unknown-account', conversation_id: 'selected@chatroom', locator: 'anonymous-export' }, c).gaps[0].reason, 'wechat_import_account_scope_missing_or_ambiguous');
  assert.equal(parseWechatHistory('malformed body', c.providers[0], 'excluded@chatroom', request, c).events.length, 0);
  assert.equal(parseChatExport(bytes, 'legacy-json', { account_id: 'wxid_owner', conversation_id: 'gh_service', locator: 'anonymous-export' }, c).gaps[0].reason, 'wechat_service_chat_excluded');
});
test('native wxid wins conflicting alias and sender flag; numeric representation requires exact chat evidence', () => {
  const c = config(), source = c.providers[0];
  Object.assign(source.options, { self_aliases: ['owner alias'], aliases_verified: true, sender_is_self_verified: true });
  const conflicting = { ...row('conflict', 'wxid_other'), sender_name: 'owner alias', sender_is_self: true, real_sender_id: '2' };
  assert.equal(parseWechatHistory(payload([conflicting]), source, 'private', request, c, undefined, 'private').events[0].role, 'other');
  const numeric = { ...row('numeric', null), real_sender_id: '2', sender_name: 'owner alias' };
  assert.equal(parseWechatHistory(payload([numeric]), source, 'private', request, c, undefined, 'private').events[0].role, 'unknown');
  source.options.self_ids_by_chat = { private: ['2', '8'] };
  const first = parseWechatHistory(payload([numeric]), source, 'private', request, c, undefined, 'private').events[0];
  const second = parseWechatHistory(payload([{ ...numeric, real_sender_id: '8' }]), source, 'private', request, c, undefined, 'private').events[0];
  assert.equal(first.role, 'user'); assert.equal(first.context.sender_wxid, 'wxid_owner'); assert.deepEqual(first, second);
  assert.equal(parseWechatHistory(payload([numeric]), source, 'other-private', request, c, undefined, 'private').events[0].role, 'unknown');
  const flag = { ...row('flag', null), sender_is_self: true };
  source.options.sender_is_self_verified = false;
  assert.equal(parseWechatHistory(payload([flag]), source, 'private', request, c, undefined, 'private').events[0].role, 'unknown');
  source.options.sender_is_self_verified = true;
  assert.equal(parseWechatHistory(payload([flag]), source, 'private', request, c, undefined, 'private').events[0].role, 'user');
});
test('import native identity overrides display alias and unknown numeric identity stays unknown', () => {
  const c = config(), manifest = { account_id: 'wxid_owner', conversation_id: 'private', conversation_type: 'private' as const, locator: 'synthetic-export', identity_verified: true,
    self_ids: ['wxid_owner'], aliases_verified: true, self_aliases: ['owner alias'] };
  const parsed = parseChatExport(JSON.stringify({ ...row('conflict', 'wxid_other'), sender: 'owner alias' }), 'legacy-jsonl', manifest, c);
  assert.equal(parsed.events[0].role, 'other'); assert.equal(parsed.events[0].context.sender_wxid, 'wxid_other');
  const numeric = parseChatExport(JSON.stringify({ ...row('unknown', null), real_sender_id: '2', sender: 'owner alias' }), 'legacy-jsonl', manifest, c);
  assert.equal(numeric.events[0].role, 'unknown'); assert.equal(numeric.events[0].context.context_only, true);
});
test('migration rejects excluded chat export before opening a missing body file and creates no capture checkpoint', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bookkeeping-wechat-scope-')); await mkdir(join(root, 'wiki'));
  const c = { ...config(), wiki_root: join(root, 'wiki'), data_dir: join(root, 'data') }, store = await createStore(c);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const report = await createMigrationService(store, c).importManifest({ schema_version: 1, manifest_id: 'excluded-fixture', kind: 'import', entries: [{
    kind: 'chat_export', format: 'legacy-jsonl', path: join(root, 'never-opened.jsonl'), source_file_id: 'synthetic-excluded', recorded_at: request.cutoff,
    account_id: 'wxid_owner', conversation_id: 'excluded@chatroom', owner_id: 'wxid_owner', conversation_type: 'group', identity_verified: true,
    time_source: 'create_time', source_timezone: null, known_range: request.range,
  }] });
  assert.equal(report.bytes_read, 0); assert.equal(report.records, 0); assert.equal(report.entries[0].status, 'inspected');
  assert.deepEqual(report.entries[0].pending, ['wechat_group_not_allowlisted']);
  assert.deepEqual(await store.getCheckpoints('migration', 'history'), []); assert.equal((await store.status()).events, 0);
});
test('numeric sender_wxid and ChatLab platform sender never establish a global stable identity', () => {
  const c = config(), source = c.providers[0];
  source.options.self_ids = ['2'];
  for (const numeric of [2, '2', '9007199254740993', '1e3']) {
    const input = { ...row('numeric-field'), sender_wxid: numeric };
    const captured = parseWechatHistory(payload([input]), source, 'private', request, c, undefined, 'private');
    assert.equal(captured.events[0].role, 'unknown'); assert.equal(captured.events[0].context.sender_wxid, null);
    assert(captured.gaps.some(gap => gap.reason === 'wechat_sender_unknown'));
    for (const senderFields of [{ sender: numeric }, { sender_id: numeric }, { sender_wxid: numeric, sender: 'wxid_owner' }]) {
      const imported = parseChatExport(JSON.stringify({ chatlab: { version: '0.0.2' }, messages: [{ ...senderFields, platformMessageId: 'numeric-import', timestamp: input.create_time, type: 0, content: 'anonymous numeric sender' }] }), 'chatlab-json', {
        account_id: 'wxid_owner', conversation_id: 'private', conversation_type: 'private', locator: 'numeric-platform-fixture', identity_verified: true, self_ids: ['2'],
      }, c);
      assert.equal(imported.events[0].role, 'unknown'); assert.equal(imported.events[0].context.sender_wxid, null);
      assert(imported.gaps.some(gap => gap.reason === 'import_sender_unknown'));
    }
  }
  source.options.self_ids = ['wxid_owner']; source.options.self_ids_by_chat = { private: ['2', '8'] };
  const numeric = { ...row('chat-local'), sender_wxid: '2' };
  const first = parseWechatHistory(payload([numeric]), source, 'private', request, c, undefined, 'private').events[0];
  const second = parseWechatHistory(payload([{ ...numeric, sender_wxid: '8' }]), source, 'private', request, c, undefined, 'private').events[0];
  assert.equal(first.role, 'user'); assert.equal(first.context.sender_wxid, 'wxid_owner'); assert.deepEqual(first, second);
  assert.equal(parseWechatHistory(payload([numeric]), source, 'other-private', request, c, undefined, 'private').events[0].role, 'unknown');
  const stable = { ...row('stable-wins', 'wxid_other'), real_sender_id: '2', sender_is_self: true };
  source.options.sender_is_self_verified = true;
  const result = parseWechatHistory(payload([stable]), source, 'private', request, c, undefined, 'private').events[0];
  assert.equal(result.role, 'other'); assert.equal(result.context.sender_wxid, 'wxid_other');
});
