import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, canonical, digest, SqliteStore } from '../../src/store/index.ts';
import { createReviewer } from '../../src/review/index.ts';
import { parseCapturedLines } from '../../src/adapters/file-reader.ts';
import { correctCodexClassification } from '../../src/store/codex-automation.ts';
import type { BookkeepingConfig, CollectionBatch, SourceEvent } from '../../src/contracts/types.ts';
import { config, collection, range, result, bundle } from '../store/fixtures.ts';

const cutoff = '2026-09-30T23:00:00Z';
const packet = '<heartbeat>\n<automation_id>synthetic-monitor</automation_id>\n<current_time_iso>2026-09-30T09:00:00Z</current_time_iso>\n<instructions>Synthetic automation only.</instructions>\n</heartbeat>';
function row(role: string, body: string, turn: string | null, id: string, phase = 'final') {
    return { type: 'response_item', timestamp: '2026-09-30T09:00:00Z', payload: {
        type: 'message', id, role, phase,
        content: [{ type: role === 'user' ? 'input_text' : 'output_text', text: body }],
        ...(turn ? { internal_chat_message_metadata_passthrough: { turn_id: turn } } : {}),
    }, metadata: { retained_source: { id: { ...(turn ? { turn_id: turn } : {}), role, message_id: id } }, client_authored: false } };
}
function captured(c: BookkeepingConfig, rows: any[], id: string): CollectionBatch {
    const bytes = Buffer.from(rows.map(row => JSON.stringify(row) + '\n').join(''));
    const parsed = parseCapturedLines({ provider: 'codex', account: c.providers[0].account_id,
        identity: { id: 'synthetic-chat', classification: 'main', cwd: '/synthetic', metadata: {} },
        locator: '/synthetic/source.jsonl', generation: 'one', buffer: bytes,
        read_start: 0, slice_start: 0, consumed: bytes.length, state: {}, known_events: new Set(), config: c });
    const batch = collection(parsed.events, 'live', id);
    batch.coverage[0].provider = batch.checkpoints[0].provider = 'codex';
    batch.fragments = parsed.fragments;
    return batch;
}
// Seed the prior release's persisted format, rather than constructing a new
// capture through the corrected parser/Store. All evidence is synthetic JSONL.
async function legacyStore(c: BookkeepingConfig, batch: CollectionBatch): Promise<SqliteStore> {
    const store = await createStore(c);
    await store.saveCollection({ ...batch, events: [], fragments: [] });
    for (const fragment of batch.fragments)
        store.db.prepare('INSERT INTO fragments VALUES(?,?)').run(fragment.fragment_id, canonical(fragment));
    for (const event of batch.events) {
        const previous = legacy(event);
        store.db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(previous.event_id, canonical(previous), previous.utc_time.value, 'main', previous.physical_order);
        store.db.prepare('INSERT INTO event_lanes VALUES(?,?)').run(previous.event_id, 'live');
    }
    store.close();
    return createStore(c);
}
function legacy(event: SourceEvent): SourceEvent {
    const context = { ...event.context }; delete context.automation_origin;
    return { ...event, classification: 'main', context };
}
function messages() {
    return [row('user', 'Synthetic human before.', 'human-0', 'u0'),
        row('assistant', 'Synthetic human answer.', 'human-0', 'a0'),
        row('user', packet, 'automation-1', 'heartbeat'),
        row('assistant', 'Synthetic automation progress.', 'automation-1', 'progress', 'commentary'),
        row('assistant', 'Synthetic automation final.', 'automation-1', 'final'),
        row('user', 'Synthetic human after: explain heartbeat.', 'human-2', 'u2'),
        row('assistant', 'Synthetic human final.', 'human-2', 'a2')];
}

test('legacy Codex main events reconcile from saved raw rows on bounded prepare and restart, without recapture', async () => {
    const c = await config(); c.providers[0].provider = 'codex'; c.limits.chunk_events = 1;
    const batch = captured(c, messages(), 'legacy'); const store = await legacyStore(c, batch);
    const rawBefore = store.db.prepare('SELECT json FROM fragments ORDER BY id').all();
    const prepared = await createReviewer(store, c).prepare({ kind: 'daily', lane: 'live', cutoff });
    const main = prepared.flatMap(b => b.chunks.flatMap(chunk => chunk.events));
    assert.deepEqual(main.map(e => e.source.message_id), ['u0', 'a0', 'u2', 'a2']);
    assert(prepared.every(b => b.chunks.every(chunk => chunk.context_events.every(e => !['heartbeat', 'progress', 'final'].includes(e.source.message_id!)))));
    assert.deepEqual(store.db.prepare('SELECT json FROM fragments ORDER BY id').all(), rawBefore);
    const corrected = await store.listEvents({ range, include_context: true });
    assert.deepEqual(corrected.map(e => e.classification), ['main', 'main', 'automation', 'automation', 'automation', 'main', 'main']);
    assert.equal((corrected[3].context.automation_origin as any).anchor_event_id, batch.events[2].event_id);
    store.close(); const reopened = await createStore(c);
    assert.deepEqual((await reopened.listEvents({ range })).map(e => e.source.message_id), ['u0', 'a0', 'u2', 'a2']);
    reopened.close();
});

test('new parser recapture upgrades old native and fallback records without an immutable conflict', async () => {
    for (const fallback of [false, true]) {
        const c = await config(); c.providers[0].provider = 'codex';
        const rows = messages(); if (fallback) for (const row of rows) delete (row.payload as any).id;
        const batch = captured(c, rows, 'legacy:' + fallback), store = await legacyStore(c, batch);
        await store.saveCollection({ ...batch, batch_id: 'recapture:' + fallback });
        assert.equal((await store.listWork('event_conflict')).length, 0);
        assert.equal((await store.listEvents({ range, include_context: true })).filter(e => e.classification === 'automation').length, 3);
        assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM events').get()!.n, 7);
        store.close();
    }
});

test('partial envelopes, conflicting turns and no-turn legacy assistants stay locally unknown; humans and quoted packets survive', async () => {
    const c = await config(); c.providers[0].provider = 'codex';
    const conflict = row('assistant', 'Conflicting assistant IDs.', 'auto', 'conflict');
    (conflict.metadata.retained_source.id as any).turn_id = 'other';
    const rows = [row('user', packet, null, 'no-turn'), row('assistant', 'Unproven old assistant.', null, 'no-turn-answer'),
        row('user', packet.slice(0, -12), 'partial', 'partial'), row('assistant', 'Partial anchor answer.', 'partial', 'partial-answer'),
        row('user', packet, 'auto', 'valid'), conflict,
        row('user', '```xml\n' + packet + '\n```', 'human', 'quoted'), row('assistant', 'Normal human response.', 'human', 'normal')];
    const batch = captured(c, rows, 'local-unknown'), store = await legacyStore(c, batch);
    const prepared = await createReviewer(store, c).prepare({ kind: 'daily', lane: 'live', cutoff });
    assert.deepEqual(prepared.flatMap(b => b.chunks.flatMap(chunk => chunk.events)).map(e => e.source.message_id), ['quoted', 'normal']);
    assert(prepared.some(b => b.unfinished.some(gap => gap.reason.includes('Codex'))));
    const saved = await store.listEvents({ range, include_context: true });
    assert.deepEqual(saved.map(e => e.classification), ['automation', 'unknown', 'unknown', 'unknown', 'automation', 'unknown', 'main', 'main']);
    assert.equal((await store.listWork('event_classification')).filter(work => work.state === 'pending').length, 4);
    store.close();
});

test('forged context proof, changed raw body or wrong fragment source cannot downgrade a saved main event', async () => {
    const c = await config(); c.providers[0].provider = 'codex';
    const batch = captured(c, messages(), 'proof'); const store = await legacyStore(c, batch);
    const human = legacy(batch.events[0]);
    const forged = { ...human, classification: 'automation' as const, context: { ...human.context, automation_origin: batch.events[2].context.automation_origin } };
    await store.saveCollection({ ...batch, batch_id: 'forged', events: [forged] });
    assert.equal((await store.listWork('event_conflict')).length, 1);
    assert.equal((await store.listEvents({ range })).find(e => e.event_id === human.event_id)!.classification, 'main');
    const anchor = legacy(batch.events[2]); const fragment = batch.fragments.find(f => f.fragment_id === anchor.fragment_ref)!;
    const wrongSource = { ...fragment, locator: fragment.locator.replace('synthetic-chat', 'other-chat') };
    assert.equal(correctCodexClassification(anchor, wrongSource, null, null).event.classification, 'unknown');
    const modified = Buffer.from(JSON.stringify(row('user', packet + ' changed', 'automation-1', 'heartbeat')));
    const otherBody = { ...fragment, bytes_base64: modified.toString('base64'), sha256: digest(modified) };
    assert.equal(correctCodexClassification(anchor, otherBody, null, null).event.classification, 'unknown');
    store.close();
});

test('old pending bundles cannot accept newly excluded evidence; accepted facts and results remain immutable and reusable', async () => {
    const c = await config(); c.providers[0].provider = 'codex'; const batch = captured(c, messages(), 'old-bundles');
    const store = await legacyStore(c, batch), oldBundle = bundle(batch.events.map(legacy), 'stale');
    await store.saveBundle(oldBundle);
    await assert.rejects(store.commitReview(result(oldBundle, 'stale-result', false)), /classification changed/);
    // Historical pending material remains auditable, but fresh prepare rebuilds
    // from current source rows and never reuses the stale chunk.
    const fresh = await createReviewer(store, c).prepare({ kind: 'daily', lane: 'live', cutoff });
    assert(!fresh.flatMap(b => b.chunks).some(chunk => chunk.chunk_id === oldBundle.chunks[0].chunk_id));
    const humanBundle = bundle([legacy(batch.events[0])], 'accepted'); await store.saveBundle(humanBundle);
    const accepted = result(humanBundle, 'accepted-result'); accepted.pages = [];
    const commit = await store.commitReview(accepted);
    const factBytes = canonical(commit.facts), resultBytes = canonical(await store.getReviewResult(accepted.result_id));
    await createReviewer(store, c).prepare({ kind: 'daily', lane: 'live', cutoff });
    assert.equal(canonical((await store.listOutbox())[0].artifact.facts), factBytes);
    assert.equal(canonical(await store.getReviewResult(accepted.result_id)), resultBytes);
    assert.equal((await store.commitReview(accepted)).reused, true);
    store.close();
});

test('classification reconciliation touches at most the selected event page and one preceding user per assistant', async () => {
    const c = await config(); c.providers[0].provider = 'codex';
    const rows = Array.from({ length: 20 }, (_, i) => row('user', packet, 'auto:' + i, 'heartbeat:' + i));
    const store = await legacyStore(c, captured(c, rows, 'bounded'));
    assert.deepEqual(await store.getReviewableEvents({ range, lane: 'live', limit: 1 }, 'daily'), []);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE classification='automation'").get()!.n, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE classification='main'").get()!.n, 19);
    assert.deepEqual(await store.getReviewableEvents({ range, lane: 'live', limit: 1 }, 'daily'), []);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE classification='automation'").get()!.n, 2);
    const plan = store.db.prepare("EXPLAIN QUERY PLAN SELECT json FROM events WHERE json_extract(json,'$.source.provider')='codex' AND json_extract(json,'$.source.account_id')=? AND json_extract(json,'$.source.conversation_id')=? AND json_extract(json,'$.locator')=? AND json_extract(json,'$.generation')=? AND json_extract(json,'$.role')='user' AND ordering<? ORDER BY ordering DESC,id DESC LIMIT 1")
        .all(c.providers[0].account_id, 'synthetic-chat', '/synthetic/source.jsonl', 'one', '99999999999999999999');
    assert(plan.some((row: any) => row.detail.includes('SEARCH events USING INDEX codex_source_user')));
    assert(!plan.some((row: any) => /SCAN events|TEMP B-TREE/.test(row.detail)));
    store.close();
});

test('actual parser tail with unknown origin reconciles against saved raw anchor without duplicate conflicts', async () => {
    const c = await config(); c.providers[0].provider = 'codex';
    const rows = messages(), batch = captured(c, rows, 'saved-origin'), store = await legacyStore(c, batch);
    const prefix = Buffer.byteLength(rows.slice(0, 3).map(row => JSON.stringify(row) + '\n').join(''));
    const tail = Buffer.from(JSON.stringify(rows[3]) + '\n');
    const parsed = parseCapturedLines({ provider: 'codex', account: c.providers[0].account_id,
        identity: { id: 'synthetic-chat', classification: 'main', cwd: '/synthetic', metadata: {} },
        locator: '/synthetic/source.jsonl', generation: 'one', buffer: tail,
        read_start: prefix, slice_start: 0, consumed: tail.length, state: {}, known_events: new Set(), config: c });
    assert.equal(parsed.events[0].classification, 'unknown');
    assert.equal(parsed.events[0].event_id, batch.events[3].event_id);
    await store.saveCollection({ ...batch, batch_id: 'old-checkpoint-tail', events: parsed.events, fragments: parsed.fragments });
    assert.equal((await store.listWork('event_conflict')).length, 0);
    assert.equal((await store.listEvents({ range, include_context: true })).find(e => e.event_id === parsed.events[0].event_id)!.classification, 'automation');
    store.close();
});
