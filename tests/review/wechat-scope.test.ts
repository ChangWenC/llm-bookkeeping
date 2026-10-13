import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createStore, canonical } from '../../src/store/index.ts';
import { createReviewer } from '../../src/review/index.ts';
import { config, event, collection, bundle, result, range } from '../store/fixtures.ts';
import type { SourceEvent, BookkeepingConfig } from '../../src/contracts/types.ts';

// Scope-focused history fixtures must precede the normal 48-hour boundary.
const cutoff = '2026-10-03T00:00:00.000Z';
async function setup() {
    const c = await config();
    c.providers = ['codex', 'claude', 'wechat'].map(provider => ({ schema_version: 1, provider, account_id: 'synthetic-account', roots: [], enabled: true, options: provider === 'wechat' ? { group_allowlist: ['allowed@chatroom'] } : {} }));
    return c;
}
function source(id: string, provider = 'wechat', chat = 'private-chat', time = '2026-09-30T09:00:00Z'): SourceEvent {
    const e = event(id, 'Synthetic message ' + id, time);
    e.source = { ...e.source, provider, account_id: 'synthetic-account', conversation_id: chat };
    e.context = provider === 'wechat' ? { identity_verified: true, is_group: chat.endsWith('@chatroom'), sender_id: 'wxid_known', sender_wxid: 'wxid_known' } : {};
    return e;
}
async function capture(store: Awaited<ReturnType<typeof createStore>>, events: SourceEvent[], lane: 'live' | 'history' = 'history') {
    const batch = collection(events, lane, 'capture:' + events.map(e => e.event_id).join(','));
    batch.coverage = [...new Set(events.map(e => e.source.provider))].map(provider => ({ ...batch.coverage[0], coverage_id: 'coverage:' + provider, provider, account_id: 'synthetic-account' }));
    await store.saveCollection(batch);
}
const query = { range, lane: 'history' as const, limit: 1 };

test('stable group scope and source apply before body LIMIT, context and replay freezing; raw historical rows survive', async () => {
    const c = await setup(), store = await createStore(c);
    const excluded = Array.from({ length: 40 }, (_, i) => source('excluded:' + i, 'wechat', 'excluded@chatroom', '2026-09-01T09:00:00Z'));
    const other = source('early-codex', 'codex', 'chat', '2026-09-02T09:00:00Z');
    const allowed = source('allowed', 'wechat', 'allowed@chatroom');
    await capture(store, [...excluded, other, allowed]);
    const raw = store.db.prepare('SELECT id,json FROM events ORDER BY id').all();
    assert.deepEqual((await store.listEvents({ ...query, source: 'wechat' })).map(e => e.event_id), ['allowed']);
    assert.deepEqual((await store.getReviewableEvents({ ...query, source: 'wechat' }, 'daily')).map(e => e.event_id), ['allowed']);
    assert.deepEqual(store.getContextEvents(excluded[0]), []);
    const replay = await store.requestSemanticReplay({ schema_version: 1, replay_key: 'scoped', source: 'wechat', range, cutoff });
    assert.equal(replay.payload.event_count, 1);
    const prepared = await createReviewer(store, c).prepare({ kind: 'daily', lane: 'history', cutoff, replay_id: replay.work_id });
    assert(!canonical(prepared).includes('excluded:'));
    assert(prepared.every(b => b.source === 'wechat'));
    assert.deepEqual(store.db.prepare('SELECT id,json FROM events ORDER BY id').all(), raw);
    for (const b of prepared) await createReviewer(store, c).accept(result(b, 'scope-zero', false));
    assert.equal((await store.listCoverage(range)).find(c => c.provider === 'wechat')!.review_status, 'complete');
    assert.equal(store.getReviewedUnits('daily', 'history').has(excluded[0].event_id), false);
    store.close();
});

test('stored missing or unknown chat type is local pending under explicit list; configured private metadata admits canonical known sender', async () => {
    const c = await setup(), store = await createStore(c);
    const missing = source('missing-type', 'wechat', 'private-stable'); delete missing.context.is_group;
    const unknown = source('unknown-type', 'wechat', 'unknown-stable'); delete unknown.context.is_group; unknown.context.conversation_type = 'unknown';
    await capture(store, [missing, unknown]);
    assert.deepEqual(await store.getReviewableEvents({ ...query, source: 'wechat' }, 'daily'), []);
    const outcomes = await createReviewer(store, c).prepareWithOutcomes!({ kind: 'daily', source: 'wechat', lane: 'history', cutoff });
    assert.equal(outcomes.providers[0].execution_status, 'partial');
    const replay = await store.requestSemanticReplay({ schema_version: 1, replay_key: 'missing-types', source: 'wechat', range, cutoff });
    const reviewer = createReviewer(store, c);
    for (const b of await reviewer.prepare({ kind: 'daily', lane: 'history', replay_id: replay.work_id, cutoff })) await reviewer.accept(result(b, 'unknown-type-zero', false));
    assert.equal((await store.getSemanticReplay(replay.work_id))!.state, 'pending');
    c.providers.find(p => p.provider === 'wechat')!.options.chat_types = { 'private-stable': 'private' };
    assert.deepEqual((await store.getReviewableEvents({ ...query, source: 'wechat' }, 'daily')).map(e => e.event_id), ['missing-type']);
    store.close();
});

test('config narrowing rejects pending/stale sources and context at transaction acceptance; accepted history reuses unchanged', async () => {
    const c = await setup(), store = await createStore(c), reviewer = createReviewer(store, c);
    const allowed = source('allowed', 'wechat', 'allowed@chatroom');
    await capture(store, [allowed]);
    const replay = await store.requestSemanticReplay({ schema_version: 1, replay_key: 'before-narrow', source: 'wechat', range, cutoff });
    const acceptedBundle = (await reviewer.prepare({ kind: 'daily', source: 'wechat', lane: 'history', cutoff }))[0];
    const accepted = result(acceptedBundle, 'accepted', false);
    await reviewer.accept(accepted);
    const acceptedArtifact = canonical((await store.listOutbox())[0].artifact);
    const pending = bundle([allowed], 'stale'); pending.source = 'wechat'; await store.saveBundle(pending);
    const context = bundle([source('codex', 'codex')], 'stale-context'); context.source = 'codex'; context.chunks[0].context_events = [allowed]; await store.saveBundle(context);
    c.providers.find(p => p.provider === 'wechat')!.options.group_allowlist = [];
    await assert.rejects(store.getBundle(pending.bundle_id), /scope changed/);
    assert.equal(store.getReplayEvents(replay.work_id, 1).length, 0);
    assert(!(await store.listPendingChunks(range, 'live')).some(c => c.chunk_id === pending.chunks[0].chunk_id));
    const replayMaterial = await reviewer.prepare({ kind: 'daily', lane: 'history', cutoff, replay_id: replay.work_id });
    assert(replayMaterial.every(b => b.chunks.every(c => c.events.length === 0)));
    assert.equal((await store.getSemanticReplay(replay.work_id))!.state, 'pending');
    await assert.rejects(reviewer.accept(result(pending, 'stale-result', false)), /scope changed/);
    await assert.rejects(reviewer.accept(result(context, 'stale-context-result', false)), /scope changed/);
    assert.equal((await reviewer.accept(accepted)).reused, true);
    assert.equal(canonical((await store.listOutbox())[0].artifact), acceptedArtifact);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM results').get()!.n, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM events').get()!.n, 1);
    store.close();
});

test('daily budget gives each provider a bundle then earliest pending provider; a bad WeChat result cannot roll back peers', async () => {
    const c = await setup(); c.limits = { chunk_events: 1, chunk_body_bytes: 128, bundle_bytes: 4096, bundles_per_round: 4 };
    const store = await createStore(c), reviewer = createReviewer(store, c);
    const events = ['codex', 'claude', 'wechat'].flatMap((provider, p) => Array.from({ length: 8 }, (_, i) => source(provider + ':' + i, provider, 'chat', `2026-09-${String(1 + p).padStart(2, '0')}T09:00:00Z`)));
    await capture(store, events);
    const prepared = await reviewer.prepareWithOutcomes!({ kind: 'daily', lane: 'history', cutoff });
    assert.equal(prepared.bundles.length, 4);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM bundles').get()!.n, 4);
    assert.deepEqual(prepared.bundles.slice(0, 3).map(b => b.source), ['codex', 'claude', 'wechat']);
    assert.equal(prepared.bundles[3].source, 'codex');
    assert(prepared.bundles.every(b => new Set(b.chunks.flatMap(c => [...c.events, ...c.context_events]).map(e => e.source.provider)).size === 1));
    const bad = result(prepared.bundles[2], 'bad-wechat', false); bad.source = 'codex';
    await assert.rejects(reviewer.accept(bad), /source differs/);
    await reviewer.accept(result(prepared.bundles[0], 'codex-zero', false));
    await reviewer.accept(result(prepared.bundles[1], 'claude-zero', false));
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM results').get()!.n, 2);
    assert.equal(store.getReviewedUnits('daily', 'history').has('wechat:0'), false);
    store.close();
});

test('malformed WeChat scope remains local, explicit source/range/max apply before SQL pages, and storage failures escape', async () => {
    const c = await setup(), store = await createStore(c), reviewer = createReviewer(store, c);
    await capture(store, [source('old', 'codex', 'chat', '2026-09-01T09:00:00Z'), source('new', 'codex', 'chat', '2026-09-30T09:00:00Z'), source('wechat')]);
    c.providers.find(p => p.provider === 'wechat')!.options.group_allowlist = 'bad';
    const outcomes = await reviewer.prepareWithOutcomes!({ kind: 'daily', lane: 'history', cutoff });
    assert(outcomes.bundles.some(b => b.source === 'codex'));
    assert.equal(outcomes.providers.find(p => p.provider === 'wechat')!.execution_status, 'unavailable');
    const scoped = await reviewer.prepare({ kind: 'daily', source: 'codex', lane: 'history', cutoff, max_bundles: 1, range: { ...range, from: '2026-09-29T00:00:00Z' } });
    assert.equal(scoped.length, 1); assert.deepEqual(scoped.flatMap(b => b.chunks.flatMap(c => c.events)).map(e => e.event_id), ['new']);
    await assert.rejects(reviewer.prepare({ kind: 'daily', lane: 'history', cutoff, max_bundles: 5 }), /max_bundles/);
    const old = store.saveBundle.bind(store); store.saveBundle = async () => { throw Object.assign(new Error('Synthetic disk full'), { code: 'ENOSPC' }); };
    await assert.rejects(reviewer.prepareWithOutcomes!({ kind: 'daily', source: 'codex', lane: 'history', cutoff }), /disk full/);
    store.saveBundle = old; store.close();
});

test('unknown WeChat sender stays pending and never enters body context or reviewed marks; known canonical conflict remains usable', async () => {
    const c = await setup(), store = await createStore(c), reviewer = createReviewer(store, c);
    const known = source('known'), unknown = source('unknown', 'wechat', 'private-chat', '2026-09-30T08:00:00Z'); unknown.role = 'unknown'; unknown.context.sender_id = '2'; delete unknown.context.sender_wxid;
    await capture(store, [known, unknown]);
    assert.deepEqual(store.getContextEvents(known), []);
    const incoming = { ...known, role: 'unknown' as const, context: { identity_verified: true, sender_id: '2' } };
    await store.saveCollection({ ...collection([incoming], 'history', 'conflicting-capture'), coverage: [] });
    const prepared = await reviewer.prepare({ kind: 'daily', source: 'wechat', lane: 'history', cutoff });
    assert.deepEqual(prepared.flatMap(b => b.chunks.flatMap(c => c.events)).map(e => e.event_id), ['known']);
    assert(prepared.some(b => b.unfinished.some(g => g.reason.includes('Conflicting known sender'))));
    for (const b of prepared) await reviewer.accept(result(b, 'known-only', false));
    assert.equal(store.getReviewedUnits('daily', 'history').has('unknown'), false);
    assert.equal((await store.listCoverage(range))[0].review_status, 'partial');
    assert.equal((await store.listWork('event_conflict', 'pending')).length, 1);
    store.close();
});

test('exact private registry enriches bounded review only; aliases, groups, pets, unverified and same-name senders never map', async () => {
    const c = await setup();
    const root = join(c.wiki_root, 'wiki/personal/people'); await mkdir(root, { recursive: true });
    await writeFile(join(root, 'person.md'), '---\ntype: personal-person\nsource: group-source\n---\nSynthetic person.');
    await writeFile(join(root, 'pet.md'), '---\ntype: personal-pet\n---\nSynthetic pet.');
    const mapping = { schema_version: 1, wxid: 'wxid_known', display_name: 'Shared nickname', wiki_path: 'wiki/personal/people/person.md', relationship: 'Synthetic relationship', verified: true };
    c.providers.find(p => p.provider === 'wechat')!.options.private_person_registry = [mapping, { ...mapping, wxid: 'wxid_pet', wiki_path: 'wiki/personal/people/pet.md' }, { ...mapping, wxid: 'allowed@chatroom' }, { ...mapping, wxid: 'wxid_unverified', verified: false }];
    const store = await createStore(c), reviewer = createReviewer(store, c);
    const known = source('known'), wrong = source('same-name'), numeric = source('numeric'), pet = source('pet'), unverified = source('unverified'), group = source('group', 'wechat', 'allowed@chatroom');
    for (const [e, sender] of [[wrong, 'wxid_other'], [numeric, '2'], [pet, 'wxid_pet'], [unverified, 'wxid_unverified'], [group, 'allowed@chatroom']] as [SourceEvent, string][]) e.context = { ...e.context, sender_id: sender, sender_wxid: sender, sender_display_name: 'Shared nickname' };
    await capture(store, [known, wrong, numeric, pet, unverified, group]);
    const raw = store.db.prepare('SELECT id,json FROM events ORDER BY id').all();
    const prepared = await reviewer.prepare({ kind: 'daily', source: 'wechat', lane: 'history', cutoff });
    const reviewed = prepared.flatMap(b => b.chunks.flatMap(c => c.events));
    assert.equal((reviewed.find(e => e.event_id === 'known')!.context.person_context as any).wiki_path, mapping.wiki_path);
    assert(reviewed.filter(e => e.event_id !== 'known').every(e => e.context.person_context === undefined));
    assert(prepared.some(b => b.unfinished.some(g => g.reason.includes('person mapping remains pending'))));
    const oldChunk = prepared[0].chunks[0].chunk_id;
    mapping.display_name = 'Updated exact context';
    const updated = await reviewer.prepare({ kind: 'daily', source: 'wechat', lane: 'history', cutoff });
    assert.notEqual(updated[0].chunks[0].chunk_id, oldChunk);
    assert.deepEqual(store.db.prepare('SELECT id,json FROM events ORDER BY id').all(), raw);
    store.close();
});

test('exact replay selection freezes only audited IDs, rejects broadened retries and invalid IDs, and never completes omitted material', async () => {
    const c = await setup(), store = await createStore(c), reviewer = createReviewer(store, c);
    const one = source('selected:1'), two = source('selected:2'), unread = source('unread'), excluded = source('excluded', 'wechat', 'excluded@chatroom'), other = source('codex-peer', 'codex'), outside = source('outside', 'wechat', 'private-chat', '2026-08-01T09:00:00Z');
    const unknown = source('unknown'); unknown.role = 'unknown'; unknown.context.sender_id = '2'; delete unknown.context.sender_wxid;
    await capture(store, [one, two, unread, excluded, other, outside, unknown]);
    const prior = bundle([one, two], 'prior-zero'); prior.source = 'wechat'; prior.lane = 'history'; await store.saveBundle(prior); await reviewer.accept(result(prior, 'prior-zero-result', false));
    const marks = store.db.prepare("SELECT * FROM reviewed_sources WHERE kind='daily' ORDER BY lane,source_id").all();
    const request = { schema_version: 1 as const, replay_key: 'exact', source: 'wechat', range, cutoff, event_ids: [two.event_id, one.event_id] };
    const work = await store.requestSemanticReplay(request);
    assert.deepEqual(work.payload.event_ids, [one.event_id, two.event_id]); assert.equal(work.payload.event_count, 2);
    assert.equal((await store.requestSemanticReplay({ ...request, event_ids: [one.event_id, two.event_id], cutoff: '2026-10-02T00:00:00Z' })).work_id, work.work_id);
    await assert.rejects(store.requestSemanticReplay({ ...request, event_ids: [one.event_id] }), /scope conflict/);
    await assert.rejects(store.requestSemanticReplay({ ...request, event_ids: undefined }), /scope conflict/);
    for (const id of ['missing', excluded.event_id, other.event_id, outside.event_id]) await assert.rejects(store.requestSemanticReplay({ ...request, replay_key: 'invalid:' + id, event_ids: [id] }), /missing, excluded or outside/);
    await assert.rejects(store.requestSemanticReplay({ ...request, replay_key: 'duplicate', event_ids: [one.event_id, one.event_id] }), /unique/);
    await assert.rejects(store.requestSemanticReplay({ ...request, replay_key: 'excess', event_ids: Array.from({ length: 65 }, (_, i) => 'x:' + i) }), /64/);
    const material = await reviewer.prepare({ kind: 'daily', lane: 'history', cutoff, replay_id: work.work_id });
    assert.deepEqual(material.flatMap(b => b.chunks.flatMap(c => c.events)).map(e => e.event_id).sort(), [one.event_id, two.event_id]);
    for (const [i, b] of material.entries()) await reviewer.accept(result(b, 'selected-zero:' + i, false));
    assert.equal((await store.getSemanticReplay(work.work_id))!.state, 'complete');
    assert.deepEqual(store.db.prepare("SELECT * FROM reviewed_sources WHERE kind='daily' ORDER BY lane,source_id").all(), marks);
    assert.equal(store.getReviewedUnits('daily', 'history').has(unread.event_id), false);
    assert.equal(store.getReviewedUnits('daily', 'history').has(other.event_id), false);
    assert.equal((await store.listWork('semantic_replay')).length, 1);
    store.close();
});

test('private counterpart context uses exact custom native conversation ID, independently of Roy or an unknown sender; groups never become counterpart people', async () => {
    const c = await setup(), people = join(c.wiki_root, 'wiki/personal/people'); await mkdir(people, { recursive: true });
    await writeFile(join(people, 'friend.md'), '---\ntype: personal-person\n---\nSynthetic friend.');
    await writeFile(join(people, 'actual-peer.md'), '---\ntype: personal-person\n---\nSynthetic actual peer.');
    const contact = 'custom-native-contact', mapping = { schema_version: 1, wxid: contact, display_name: 'Synthetic counterpart', wiki_path: 'wiki/personal/people/friend.md', relationship: 'Synthetic friend', verified: true };
    c.providers.find(p => p.provider === 'wechat')!.options.private_person_registry = [mapping, { ...mapping, wxid: 'wxid_actual_peer', wiki_path: 'wiki/personal/people/actual-peer.md', display_name: 'Actual sender' }];
    const store = await createStore(c), reviewer = createReviewer(store, c);
    const own = source('own', 'wechat', contact); own.context.sender_id = own.context.sender_wxid = 'wxid_roy';
    const peer = source('peer', 'wechat', contact); peer.role = 'other'; peer.context.sender_id = peer.context.sender_wxid = 'wxid_actual_peer';
    const custom = source('custom', 'wechat', contact); custom.role = 'other'; custom.context.sender_id = custom.context.sender_wxid = contact;
    const legacy = source('legacy-custom', 'wechat', contact); legacy.role = 'other'; legacy.context.sender_id = contact; delete legacy.context.sender_wxid;
    const alias = source('unproven-custom', 'wechat', 'another-chat'); alias.role = 'other'; alias.context.sender_id = contact; delete alias.context.sender_wxid;
    const unknown = source('unknown-private', 'wechat', contact); unknown.role = 'unknown'; unknown.context.sender_id = '2'; delete unknown.context.sender_wxid;
    const group = source('group-private-name', 'wechat', contact); group.context.is_group = true;
    const filehelper = source('filehelper', 'wechat', 'filehelper');
    const enrichedUnknown = store.reviewScope.enrich(unknown);
    assert.equal((enrichedUnknown.context.conversation_person_context as any).wxid, contact);
    assert.equal(enrichedUnknown.context.person_context, undefined); assert.equal(enrichedUnknown.role, 'unknown'); assert.equal(enrichedUnknown.context.sender_id, '2');
    assert.equal(store.reviewScope.enrich(group).context.conversation_person_context, undefined);
    assert.equal(store.reviewScope.enrich(filehelper).context.conversation_person_context, undefined);
    assert.equal(store.reviewScope.enrich(alias).context.person_context, undefined);
    await capture(store, [own, peer, custom, legacy, alias, unknown]);
    const raw = store.db.prepare('SELECT id,json FROM events ORDER BY id').all();
    const prepared = await reviewer.prepare({ kind: 'daily', source: 'wechat', lane: 'history', cutoff });
    const events = prepared.flatMap(b => b.chunks.flatMap(c => c.events));
    const ownMaterial = events.find(e => e.event_id === own.event_id)!;
    assert.equal((ownMaterial.context.conversation_person_context as any).display_name, mapping.display_name);
    assert.equal(ownMaterial.context.person_context, undefined); assert.equal(ownMaterial.context.sender_id, 'wxid_roy'); assert.equal(ownMaterial.role, 'user');
    const peerMaterial = events.find(e => e.event_id === peer.event_id)!;
    assert.equal((peerMaterial.context.conversation_person_context as any).wxid, contact);
    assert.equal((peerMaterial.context.person_context as any).wxid, 'wxid_actual_peer');
    assert.equal((events.find(e => e.event_id === custom.event_id)!.context.person_context as any).wxid, contact);
    assert.equal((events.find(e => e.event_id === legacy.event_id)!.context.person_context as any).wxid, contact);
    assert(!events.some(e => e.event_id === unknown.event_id));
    for (const [i, b] of prepared.entries()) await reviewer.accept(result(b, 'counterpart-zero:' + i, false));
    assert.equal(store.getReviewedUnits('daily', 'history').has(unknown.event_id), false);
    assert.equal((await store.listCoverage(range))[0].review_status, 'partial');
    assert.deepEqual(store.db.prepare('SELECT id,json FROM events ORDER BY id').all(), raw);
    store.close();
});

test('accepted Claude facts and eventless legacy records remain Codex dedup context for keep and replace without cross-provider primary events', async () => {
    const c = await setup(), store = await createStore(c), reviewer = createReviewer(store, c);
    const claude = source('claude-accepted', 'claude'), codex = source('codex-pending', 'codex');
    await capture(store, [claude, codex]);
    const oldBundle = bundle([claude], 'claude-accepted-bundle'); oldBundle.source = 'claude'; oldBundle.lane = 'history'; await store.saveBundle(oldBundle);
    const accepted = result(oldBundle, 'claude-fact'); accepted.pages = [];
    const fact = (await reviewer.accept(accepted)).facts[0];
    const oldGroup = source('accepted-group', 'wechat', 'allowed@chatroom'); await capture(store, [oldGroup]);
    const groupBundle = bundle([oldGroup], 'accepted-group-bundle'); groupBundle.source = 'wechat'; groupBundle.lane = 'history'; await store.saveBundle(groupBundle);
    const groupResult = result(groupBundle, 'accepted-group-fact'); groupResult.pages = [];
    const groupFact = (await reviewer.accept(groupResult)).facts[0];
    c.providers.find(p => p.provider === 'wechat')!.options.group_allowlist = [];
    const legacy = { ...fact, fact_id: 'legacy:eventless', revision: 1, event_refs: [], origin: 'legacy_record' as const, content: 'Synthetic accepted legacy diary/archive context.', recorded_at: '2026-09-30T10:00:00Z' };
    await store.importLegacy({ schema_version: 1, migration_key: 'eventless-context', facts: [legacy], mappings: [], work: [] });
    const prepared = (await reviewer.prepare({ kind: 'daily', source: 'codex', lane: 'history', cutoff }))[0];
    assert(prepared.chunks.every(c => [...c.events, ...c.context_events].every(e => e.source.provider === 'codex')));
    assert(prepared.existing_facts.some(f => f.fact_id === fact.fact_id));
    assert(!prepared.existing_facts.some(f => f.fact_id === groupFact.fact_id));
    assert((await store.readEffectiveFacts({ range })).some(f => f.fact_id === groupFact.fact_id));
    assert(prepared.existing_facts.some(f => f.fact_id === legacy.fact_id && f.origin === 'legacy_record' && f.event_refs.length === 0));
    const keep = result(prepared, 'codex-keep'); keep.pages = []; keep.candidates[0].disposition = 'keep'; keep.candidates[0].target_refs = [{ schema_version: 1, fact_id: fact.fact_id, revision: fact.revision }];
    assert.equal((await reviewer.accept(keep)).facts.length, 0);
    const replay = await store.requestSemanticReplay({ schema_version: 1, replay_key: 'dedup-replace', source: 'codex', range, cutoff, event_ids: [codex.event_id] });
    const replayBundle = (await reviewer.prepare({ kind: 'daily', source: 'codex', lane: 'history', cutoff, replay_id: replay.work_id }))[0];
    assert(replayBundle.existing_facts.some(f => f.fact_id === fact.fact_id));
    assert(replayBundle.existing_facts.some(f => f.fact_id === legacy.fact_id));
    const replace = result(replayBundle, 'codex-replace'); replace.pages = []; replace.candidates[0].disposition = 'replace'; replace.candidates[0].target_refs = [{ schema_version: 1, fact_id: fact.fact_id, revision: fact.revision }];
    const changed = await reviewer.accept(replace); assert.equal(changed.facts[0].fact_id, fact.fact_id); assert.equal(changed.facts[0].revision, 2);
    assert.equal((await store.readEffectiveFacts({ range })).filter(f => f.fact_id === fact.fact_id).length, 1);
    store.close();
});

test('exact nonsuffix group metadata uses bounded twenty-minute context and truncation consistently with admission', async () => {
    for (const metadata of ['event-type', 'configured-type'] as const) {
        const c = await setup(), group = 'synthetic-native-group';
        const provider = c.providers.find(p => p.provider === 'wechat')!;
        provider.options.group_allowlist = [group]; provider.options.chat_types = { [group]: 'group' };
        const store = await createStore(c), reviewer = createReviewer(store, c);
        const anchor = source('nonsuffix-anchor:' + metadata, 'wechat', group);
        const old = source('nonsuffix-old:' + metadata, 'wechat', group, '2026-09-01T09:00:00Z'); old.context.context_only = true;
        const nearby = Array.from({ length: 13 }, (_, i) => {
            const e = source('nonsuffix-near:' + metadata + ':' + i, 'wechat', group, `2026-09-30T09:05:${String(i).padStart(2, '0')}Z`);
            e.role = 'other'; e.context.context_only = true; return e;
        });
        for (const e of [anchor, old, ...nearby]) {
            delete e.context.is_group;
            if (metadata === 'event-type') e.context.conversation_type = 'group';
        }
        await capture(store, [old, anchor, ...nearby]);
        const raw = store.db.prepare('SELECT id,json FROM events ORDER BY id').all();
        const context = store.getContextEvents(anchor);
        assert.equal(context.length, 12);
        assert(context.every(e => e.event_id !== old.event_id && Math.abs(Date.parse(e.utc_time.value!) - Date.parse(anchor.utc_time.value!)) <= 20 * 60000));
        assert.equal(store.isContextTruncated(anchor), true);
        const prepared = await reviewer.prepare({ kind: 'daily', source: 'wechat', lane: 'history', cutoff });
        assert(prepared.some(b => b.unfinished.some(g => g.reason.includes('Group participation context truncated'))));
        assert(prepared.flatMap(b => b.chunks.flatMap(c => c.context_events)).every(e => e.event_id !== old.event_id));
        assert.deepEqual(store.db.prepare('SELECT id,json FROM events ORDER BY id').all(), raw);
        store.close();
    }
});
