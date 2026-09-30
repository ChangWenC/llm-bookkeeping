import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createStore } from '../../src/store/index.ts';
import { createReviewer } from '../../src/review/index.ts';
import { executeCommand, parseArgs } from '../../src/cli.ts';
import { config, event, collection, bundle, result, range } from '../store/fixtures.ts';

test('replay source failures remain durable while every account recaptures and cached events remain reviewable', async () => {
    const c = await config(), store = await createStore(c), reviewer = createReviewer(store, c);
    await store.saveCollection(collection()); const first = bundle(); await store.saveBundle(first);
    const accepted = result(first); accepted.pages = []; await store.commitReview(accepted);
    let peerCalled = false;
    const services: any = { store, reviewer, adapters: [
        { provider: 'synthetic', account_id: 'failed-account', async *replay() { throw new Error('Synthetic source offline'); } },
        { provider: 'synthetic', account_id: 'partial-account', async *replay() { yield collection(undefined, 'history', 'partial-recapture'); throw new Error('Synthetic interruption after capture'); } },
        { provider: 'synthetic', account_id: 'peer-account', async *replay() { peerCalled = true; yield collection(undefined, 'history', 'peer-recapture'); } },
    ] };
    const receipt: any = await executeCommand(parseArgs(['replay', '--source', 'synthetic', '--from', range.from, '--to', range.to]), c, services, range.to);
    assert(peerCalled); assert.equal(receipt.batches, 2);
    assert.deepEqual(receipt.recapture.map((item: any) => item.execution_status), ['unavailable', 'partial', 'complete']);
    const failures = (await store.listCoverage(range)).filter(item => item.gaps.some(gap => gap.reason.startsWith('Synthetic')));
    assert(failures.some(item => item.account_id === 'failed-account' && item.capture_status === 'unavailable'));
    assert(failures.some(item => item.account_id === 'partial-account' && item.capture_status === 'partial'));
    assert(!failures.some(item => item.account_id === 'peer-account'));
    const prepared = await reviewer.prepare({ kind: 'daily', lane: 'history', cutoff: range.to, replay_id: receipt.replay_id });
    assert.equal(prepared[0].chunks[0].events[0].event_id, first.chunks[0].events[0].event_id);
    // With no cached material the job still exists, but cannot claim capture or
    // a quiet reviewed scope just because the iterator failed before yielding.
    const empty: any = await executeCommand(parseArgs(['replay', '--source', 'synthetic', '--from', '2026-10-01T00:00:00Z', '--to', '2026-10-02T00:00:00Z']), c,
        { store, reviewer, adapters: services.adapters.slice(0, 1) }, '2026-10-02T00:00:00Z');
    assert.equal(empty.review_state, 'pending'); assert.equal(empty.recapture[0].capture_status, 'unavailable');
    const noMaterial = await reviewer.prepare({ kind: 'daily', lane: 'history', cutoff: empty.cutoff, replay_id: empty.replay_id });
    assert(noMaterial.every(b => b.chunks.every(chunk => chunk.events.length === 0)));
    assert(noMaterial.every(b => b.unfinished.length > 0));
    assert.equal((await store.getSemanticReplay(empty.replay_id))!.state, 'pending');
    store.close();
});

test('public replay durably prepares reviewed original events with current facts, without reopening ordinary review', async () => {
    const c = await config(), store = await createStore(c), reviewer = createReviewer(store, c);
    await store.saveCollection(collection()); const first = bundle(); await store.saveBundle(first);
    const initial = result(first); initial.pages = []; const committed = await store.commitReview(initial);
    const services: any = { store, reviewer, adapters: [{ provider: 'synthetic', async *replay() { yield collection(undefined, 'history', 'recapture'); } }] };
    const command = parseArgs(['replay', '--source', 'synthetic', '--from', range.from, '--to', range.to]);
    const receipt: any = await executeCommand(command, c, services, range.to);
    assert.equal(typeof receipt.replay_id, 'string');
    assert(receipt.next_prepare.includes('--replay-id'));
    const retry: any = await executeCommand(command, c, services, '2026-10-02T00:00:00Z');
    assert.equal(retry.replay_id, receipt.replay_id);
    assert.equal(retry.cutoff, range.to);
    assert.deepEqual(await reviewer.prepare({ kind: 'daily', lane: 'live', cutoff: range.to }), []);
    assert.deepEqual(await reviewer.prepare({ kind: 'daily', lane: 'history', cutoff: range.to }), []);
    const material: any = await executeCommand(parseArgs(['prepare', '--kind', 'daily', '--lane', 'history', '--replay-id', receipt.replay_id,
        '--output', join(c.data_dir, 'replay-material')]), c, services, '2026-10-03T00:00:00Z');
    assert.equal(material.cutoff, range.to);
    const prepared = (await reviewer.prepare({ kind: 'daily', lane: 'history', cutoff: range.to, replay_id: receipt.replay_id }))[0];
    assert.equal(prepared.chunks[0].events[0].event_id, first.chunks[0].events[0].event_id);
    assert.equal(prepared.existing_facts[0].fact_id, committed.facts[0].fact_id);
    const keep = result(prepared, 'replay-keep'); keep.pages = []; keep.candidates[0].disposition = 'keep';
    keep.candidates[0].target_refs = [{ schema_version: 1, fact_id: committed.facts[0].fact_id, revision: 1 }];
    assert.equal((await reviewer.accept(keep)).facts.length, 0);
    assert.equal((await reviewer.accept(keep)).reused, true);
    assert.equal((await store.getSemanticReplay(receipt.replay_id))!.state, 'complete');
    assert.deepEqual(await reviewer.prepare({ kind: 'daily', lane: 'history', cutoff: range.to, replay_id: receipt.replay_id }), []);
    assert.equal((await store.readEffectiveFacts({ range })).length, 1);
    const completedRetry: any = await executeCommand(command, c, services, '2026-10-04T00:00:00Z');
    assert.equal(completedRetry.replay_id, receipt.replay_id);
    assert.equal(completedRetry.review_state, 'complete');
    store.close();
});

test('intentional replay keys allow keep, replace, retract and missed add while preserving original event/fact identities', async () => {
    const c = await config(), store = await createStore(c), reviewer = createReviewer(store, c);
    await store.saveCollection(collection()); const first = bundle(); await store.saveBundle(first);
    const initial = result(first); initial.pages = []; const original = (await store.commitReview(initial)).facts[0];
    for (const [i, disposition] of (['replace', 'retract', 'add'] as const).entries()) {
        const work = await store.requestSemanticReplay({ schema_version: 1, replay_key: 'intentional:' + i, source: 'synthetic', range, cutoff: range.to });
        const prepared = (await reviewer.prepare({ kind: 'daily', lane: 'history', cutoff: range.to, replay_id: work.work_id }))[0];
        const review = result(prepared, 'intentional-result:' + i); review.pages = [];
        review.candidates[0].disposition = disposition;
        review.candidates[0].target_refs = disposition === 'add' ? [] : prepared.existing_facts.map(f => ({ schema_version: 1, fact_id: f.fact_id, revision: f.revision }));
        review.candidates[0].content = 'Explicit synthetic re-review ' + disposition;
        const accepted = await reviewer.accept(review);
        assert.equal(accepted.facts.length, 1);
        if (disposition !== 'add') assert.equal(accepted.facts[0].fact_id, original.fact_id);
        assert.equal(accepted.facts[0].event_refs[0].event_id, first.chunks[0].events[0].event_id);
        assert.equal((await store.getSemanticReplay(work.work_id))!.state, 'complete');
    }
    assert.equal((await store.readEffectiveFacts({ range })).length, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM events').get()!.n, 1);
    store.close();
});

test('replay progress is exact per slice, survives restart and ignores unreviewed/context/other-source evidence', async () => {
    const c = await config(); c.limits.chunk_body_bytes = 128; c.limits.chunk_events = 1; c.limits.bundles_per_round = 1;
    let store = await createStore(c); const long = event('long-replayed', 'Synthetic original '.repeat(40)), other = event('other-source'); other.source.provider = 'other';
    await store.saveCollection(collection([long, other])); const first = bundle([long]); await store.saveBundle(first);
    const initial = result(first); initial.pages = []; await store.commitReview(initial);
    const normalMarks = store.db.prepare('SELECT * FROM reviewed_sources ORDER BY kind,lane,source_id').all();
    const work = await store.requestSemanticReplay({ schema_version: 1, replay_key: 'slices', source: 'synthetic', range, cutoff: range.to });
    let reviewer = createReviewer(store, c), prepared = (await reviewer.prepare({ kind: 'daily', lane: 'history', cutoff: range.to, replay_id: work.work_id }))[0];
    const firstSlice = prepared.chunks[0].events[0]; assert.notEqual(firstSlice.event_id, long.event_id);
    await reviewer.accept(result(prepared, 'first-replayed-slice', false));
    assert.equal((await store.getSemanticReplay(work.work_id))!.state, 'pending');
    store.close(); store = await createStore(c); reviewer = createReviewer(store, c);
    for (let pass = 0; pass < 20; pass++) {
        const next = await reviewer.prepare({ kind: 'daily', lane: 'history', cutoff: range.to, replay_id: work.work_id });
        if (!next.length) break;
        assert(next.every(b => b.chunks.every(chunk => chunk.events.every(e => e.event_id !== firstSlice.event_id && e.source.provider === 'synthetic'))));
        for (const b of next) await reviewer.accept(result(b, 'remaining:' + pass, false));
    }
    assert.equal((await store.getSemanticReplay(work.work_id))!.state, 'complete');
    assert.deepEqual(store.db.prepare("SELECT * FROM reviewed_sources WHERE kind='daily' ORDER BY kind,lane,source_id").all(), normalMarks);
    assert(!store.getReviewedUnits('replay:' + work.work_id, 'history').has(other.event_id));
    store.close();
});

test('replay completion and fact revisions roll back together; partial review and stale targets remain pending', async () => {
    const c = await config(); let fail = false;
    const store = await createStore(c, { onTransactionStep(step) { if (fail && step === 'review_outbox') throw new Error('Synthetic replay transaction interruption'); } });
    await store.saveCollection(collection()); const first = bundle(); await store.saveBundle(first);
    const initial = result(first); initial.pages = []; const original = (await store.commitReview(initial)).facts[0];
    const work = await store.requestSemanticReplay({ schema_version: 1, replay_key: 'atomic', source: 'synthetic', range, cutoff: range.to });
    const reviewer = createReviewer(store, c), prepared = (await reviewer.prepare({ kind: 'daily', lane: 'history', cutoff: range.to, replay_id: work.work_id }))[0];
    const review = result(prepared, 'atomic-replay'); review.pages = []; review.candidates[0].disposition = 'replace';
    review.candidates[0].target_refs = [{ schema_version: 1, fact_id: original.fact_id, revision: 1 }];
    fail = true; await assert.rejects(reviewer.accept(review), /transaction interruption/); fail = false;
    assert.equal((await store.getSemanticReplay(work.work_id))!.state, 'pending');
    assert.equal(store.getReviewedUnits('replay:' + work.work_id, 'history').size, 0);
    assert.equal((await store.readEffectiveFacts({ range }))[0].revision, 1);
    assert.equal((await reviewer.accept(review)).facts[0].revision, 2);
    assert.equal((await store.getSemanticReplay(work.work_id))!.state, 'complete');
    const stale = await store.requestSemanticReplay({ schema_version: 1, replay_key: 'stale', source: 'synthetic', range, cutoff: range.to });
    const stalePage = (await reviewer.prepare({ kind: 'daily', lane: 'history', cutoff: range.to, replay_id: stale.work_id }))[0];
    const staleResult = result(stalePage, 'stale-target'); staleResult.pages = []; staleResult.candidates[0].disposition = 'replace';
    staleResult.candidates[0].target_refs = [{ schema_version: 1, fact_id: original.fact_id, revision: 1 }];
    assert.equal((await reviewer.accept(staleResult)).facts.length, 0);
    assert.equal((await store.getSemanticReplay(stale.work_id))!.state, 'pending');
    const partial = await store.requestSemanticReplay({ schema_version: 1, replay_key: 'partial', source: 'synthetic', range, cutoff: range.to });
    const p = (await reviewer.prepare({ kind: 'daily', lane: 'history', cutoff: range.to, replay_id: partial.work_id }))[0];
    const r = result(p, 'partial-zero', false); r.chunks[0].status = 'partial';
    await reviewer.accept(r); assert.equal((await store.getSemanticReplay(partial.work_id))!.state, 'pending');
    const final = (await reviewer.prepare({ kind: 'daily', lane: 'history', cutoff: range.to, replay_id: partial.work_id }))[0];
    await reviewer.accept(result(final, 'explicit-completion', false));
    assert.equal((await store.getSemanticReplay(partial.work_id))!.state, 'complete');
    await assert.rejects(store.requestSemanticReplay({ schema_version: 1, replay_key: 'atomic', source: 'other', range, cutoff: range.to }), /scope conflict/);
    store.close();
});

test('replay current targets include moved-date facts, rejects another source and never counts context as reviewed', async () => {
    const c = await config(), store = await createStore(c), reviewer = createReviewer(store, c);
    const original = event(), other = event('unrelated'); other.source.provider = 'other';
    await store.saveCollection(collection([original, other])); const b = bundle([original]); await store.saveBundle(b);
    const r = result(b); r.pages = []; r.candidates[0].occurred_at.value = '2026-10-03T09:00:00Z'; r.candidates[0].journal_date.value = '2026-10-03';
    const fact = (await store.commitReview(r)).facts[0];
    const work = await store.requestSemanticReplay({ schema_version: 1, replay_key: 'moved-target', source: 'synthetic', range, cutoff: range.to });
    const p = (await reviewer.prepare({ kind: 'daily', lane: 'history', cutoff: range.to, replay_id: work.work_id }))[0];
    assert(p.existing_facts.some(target => target.fact_id === fact.fact_id));
    const forged = { ...p, bundle_id: 'forged-replay-source', chunks: [{ ...p.chunks[0], chunk_id: 'forged-replay-chunk', events: [other] }] };
    await store.saveBundle(forged);
    await assert.rejects(reviewer.accept(result(forged, 'outside-scope', false)), /outside frozen source scope/);
    const contextBundle = { ...p, bundle_id: 'context-replay-source', chunks: [{ ...p.chunks[0], chunk_id: 'context-replay-chunk', context_events: [other] }] };
    await store.saveBundle(contextBundle); const contextResult = result(contextBundle, 'context-is-not-evidence'); contextResult.pages = [];
    contextResult.candidates[0].event_refs = [{ schema_version: 1, event_id: other.event_id }];
    await assert.rejects(reviewer.accept(contextResult), /unreviewed\/context event/);
    assert.equal((await store.getSemanticReplay(work.work_id))!.state, 'pending');
    assert.throws(() => parseArgs(['prepare', '--kind', 'weekly', '--lane', 'history', '--replay-id', work.work_id, '--output', c.data_dir]), /daily/);
    store.close();
});
