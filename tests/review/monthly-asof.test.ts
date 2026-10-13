import {exactReviewUnit} from '../../src/store/unit-dispositions.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, canonical } from '../../src/store/index.ts';
import { createReviewer } from '../../src/review/index.ts';
import { config, collection, event, bundle, result, candidate, range } from '../store/fixtures.ts';
import type { FactRevision } from '../../src/contracts/types.ts';

test('first historical monthly freeze includes then-effective revisions after later replacement and withdrawal, and pagination remains fixed', async () => {
    const c = await config(); c.limits.bundle_bytes = 8192;
    const store = await createStore(c), events = Array.from({ length: 12 }, (_, i) => event('historical:' + i));
    await store.saveCollection(collection(events));
    const initial = bundle(events); await store.saveBundle(initial);
    const review = result(initial); review.pages = [];
    review.candidates = events.map((event, i) => ({ ...candidate(initial, 'initial:' + i), content: 'Synthetic then-effective fact ' + i + 'x'.repeat(1200),
        event_refs: [{ schema_version: 1, ...exactReviewUnit(event) }], analytics_projection: { schema_version: 1, value: null, reason: 'No projection in this historical fixture' } }));
    const accepted = await store.commitReview(review);
    const cutoff = '2026-10-01T00:00:00Z';
    const replaced: FactRevision = { ...accepted.facts[0], revision: 2, action: 'replace', content: 'Synthetic correction recorded after cutoff',
        target_refs: [{ schema_version: 1, fact_id: accepted.facts[0].fact_id, revision: 1 }], recorded_at: '2026-10-02T12:00:00Z' };
    const retracted: FactRevision = { ...accepted.facts[1], revision: 2, action: 'retract',
        target_refs: [{ schema_version: 1, fact_id: accepted.facts[1].fact_id, revision: 1 }], recorded_at: '2026-10-03T12:00:00Z' };
    await store.importLegacy({ schema_version: 1, migration_key: 'later-correction-and-withdrawal', facts: [replaced, retracted], mappings: [], work: [] });
    assert.equal((await store.readEffectiveFacts({ range, as_of: cutoff })).length, 12);
    assert.equal((await store.readEffectiveFacts({ range })).length, 11);
    const reviewer = createReviewer(store, c);
    let current = (await reviewer.prepare({ kind: 'monthly', lane: 'history', period: '2026-09', cutoff }))[0];
    assert.equal(current.monthly_context!.facts_page!.total, 12);
    assert(current.monthly_context!.facts_page!.next_offset !== null);
    const frozen = current.monthly_context!.facts_page!.snapshot_id;
    const late = { ...accepted.facts[2], fact_id: 'late-backdated', content: 'Not part of frozen initial material', recorded_at: '2026-09-30T08:00:00Z' };
    await store.importLegacy({ schema_version: 1, migration_key: 'late-backdated-after-first-page', facts: [late], mappings: [], work: [] });
    const seen: string[] = [];
    for (let page = 0; page < 20; page++) {
        const context = current.monthly_context!, cursor = context.facts_page!;
        assert(Buffer.byteLength(canonical(current)) <= c.limits.bundle_bytes);
        for (const fact of context.facts) seen.push(fact.fact_id + ':' + fact.revision);
        if (cursor.next_offset === null) break;
        current = (await reviewer.prepare({ kind: 'monthly', lane: 'history', period: '2026-09', cutoff, fact_snapshot: frozen, fact_offset: cursor.next_offset }))[0];
    }
    assert.deepEqual(new Set(seen), new Set(accepted.facts.map(fact => fact.fact_id + ':1')));
    assert.equal(seen.length, 12);
    const now = (await reviewer.prepare({ kind: 'monthly', lane: 'history', period: '2026-09', cutoff: '2026-10-04T00:00:00Z' }))[0];
    assert.equal(now.monthly_context!.facts_page!.total, 12); // 10 original + replacement + late arrival.
    const currentRefs = store.getFactMaterial(now.monthly_context!.facts_page!.snapshot_id)!.refs;
    assert(currentRefs.some(ref => ref.fact_id === replaced.fact_id && ref.revision === 2));
    assert(!currentRefs.some(ref => ref.fact_id === retracted.fact_id));
    store.close();
});
