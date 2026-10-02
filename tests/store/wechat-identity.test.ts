import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, canonical, digest } from '../../src/store/index.ts';
import { config, event, collection } from './fixtures.ts';

test('same native WeChat body and precise instant can upgrade only unknown numeric sender to fresh verified stable identity', async () => {
    const c = await config(), store = await createStore(c);
    const raw = Buffer.from('Synthetic saved original numeric sender record');
    const fragment = { schema_version: 1 as const, fragment_id: 'original-fragment', locator: '/synthetic/wechat', bytes_base64: raw.toString('base64'), sha256: digest(raw), created_at: '2026-09-30T09:00:00Z' };
    const old = event('native-wechat'); old.source.provider = 'wechat'; old.role = 'unknown'; old.classification = 'unknown'; old.context = { identity_verified: true, sender_id: '2' }; old.fragment_ref = fragment.fragment_id;
    await store.saveCollection({ ...collection([old]), fragments: [fragment] });
    const fresh = { ...old, role: 'other' as const, classification: 'main' as const, context: { identity_verified: true, sender_id: 'custom-native-contact', sender_wxid: 'custom-native-contact' }, fragment_ref: null };
    await store.saveCollection(collection([fresh], 'live', 'fresh-stable'));
    const stored = JSON.parse(store.db.prepare('SELECT json FROM events WHERE id=?').get(old.event_id)!.json as string);
    assert.equal(stored.event_id, old.event_id); assert.equal(stored.role, 'other'); assert.equal(stored.context.sender_id, 'custom-native-contact');
    assert.equal(stored.fragment_ref, fragment.fragment_id); assert.equal(canonical(JSON.parse(store.db.prepare('SELECT json FROM fragments WHERE id=?').get(fragment.fragment_id)!.json as string)), canonical(fragment));
    assert.equal((await store.listWork('event_conflict')).length, 0);
    await store.saveCollection(collection([old], 'live', 'stable-to-numeric'));
    await store.saveCollection(collection([{ ...fresh, context: { identity_verified: true, sender_id: 'wxid_different', sender_wxid: 'wxid_different' } }], 'live', 'stable-to-different'));
    assert.equal((await store.listWork('event_conflict', 'pending')).length, 2);
    assert.equal(JSON.parse(store.db.prepare('SELECT json FROM events WHERE id=?').get(old.event_id)!.json as string).context.sender_id, 'custom-native-contact');
    store.close();
});

test('sender upgrades require exact native source, body, precise time and verification; numeric known roles never gain guessed stable IDs', async () => {
    for (const change of ['body', 'time', 'missing_time', 'message', 'verification', 'role', 'wxid'] as const) {
        const c = await config(), store = await createStore(c), old = event('old');
        old.source.provider = 'wechat'; old.role = change === 'role' ? 'other' : 'unknown'; old.classification = 'unknown'; old.context = { sender_id: '2' };
        if (change === 'missing_time') old.utc_time = { schema_version: 1, value: null, reason: 'Synthetic unknown time' };
        await store.saveCollection(collection([old]));
        const fresh = { ...old, source: { ...old.source }, role: 'other' as const, classification: 'main' as const, utc_time: { ...old.utc_time }, context: { identity_verified: true, sender_id: 'wxid_verified', sender_wxid: 'wxid_verified' } };
        if (change === 'body') fresh.body += ' changed';
        if (change === 'missing_time') fresh.utc_time = { schema_version: 1, value: '2026-09-30T09:00:00Z', reason: null };
        if (change === 'time') fresh.utc_time.value = '2026-09-30T09:00:00.001Z';
        if (change === 'message') fresh.source.message_id = 'different-native';
        if (change === 'verification') fresh.context.identity_verified = false;
        if (change === 'wxid') fresh.context.sender_wxid = 'wxid_different';
        await store.saveCollection(collection([fresh], 'live', 'incoming:' + change));
        assert.equal((await store.listWork('event_conflict', 'pending')).length, 1, change);
        assert.equal(JSON.parse(store.db.prepare('SELECT json FROM events WHERE id=?').get(old.event_id)!.json as string).context.sender_id, '2', change);
        store.close();
    }
});
