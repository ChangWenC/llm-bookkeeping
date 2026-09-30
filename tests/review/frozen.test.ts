import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, canonical } from '../../src/store/index.ts';
import { createReviewer } from '../../src/review/index.ts';
import { createAnalyticsConsumer } from '../../src/consumers/analytics/index.ts';
import { config, event, collection, bundle, result, candidate, range } from '../store/fixtures.ts';
const cutoff = '2026-10-05T00:00:00Z';
test('frozen weekly and monthly pages keep immutable references across backdated additions and retractions', async () => {
    const c = await config();
    c.limits.bundle_bytes = 8192;
    const s = await createStore(c), events = Array.from({ length: 12 }, (_, i) => event('paging:' + i));
    await s.saveCollection(collection(events));
    const b = bundle(events);
    await s.saveBundle(b);
    const r = result(b);
    r.pages = [];
    r.candidates = events.map((e, i) => ({ ...candidate(b, 'candidate:' + i), content: 'PRIVATE mixed source ' + 'x'.repeat(1200), event_refs: [{ schema_version: 1, event_id: e.event_id }], analytics_projection: { schema_version: 1, value: { ...candidate(b).analytics_projection.value!, summary: 'Professional summary ' + i + ' '.repeat(500), event_refs: [{ schema_version: 1, event_id: e.event_id }] }, reason: null } }));
    const commit = await s.commitReview(r);
    await s.markExportReady(commit.batch_id, c.data_dir + '/initial.json');
    const consumer = createAnalyticsConsumer(s, c);
    await consumer.consume();
    const reviewer = createReviewer(s, c), starts = new Map<string, any>();
    for (const kind of ['weekly', 'monthly'] as const) {
        const first = (await reviewer.prepare({ kind, lane: 'history', period: kind === 'weekly' ? '2026-10-04' : '2026-09', cutoff }))[0];
        starts.set(kind, first);
        assert((first.analysis_context ?? first.monthly_context!).facts_page!.next_offset !== null);
    }
    const extra = event('late-old-time');
    await s.saveCollection(collection([extra], 'live', 'late-capture'));
    const lateBundle = bundle([extra], 'late');
    await s.saveBundle(lateBundle);
    const lateResult = result(lateBundle, 'late');
    lateResult.pages = [];
    lateResult.created_at = '2026-09-30T10:00:00Z';
    const lateCommit = await s.commitReview(lateResult);
    await s.markExportReady(lateCommit.batch_id, c.data_dir + '/late.json');
    const retractEvent = event('retract');
    await s.saveCollection(collection([retractEvent], 'live', 'retract-capture'));
    const rb = bundle([retractEvent], 'retract');
    rb.existing_facts = await s.readEffectiveFacts({ range });
    await s.saveBundle(rb);
    const rr = result(rb, 'retract');
    rr.pages = [];
    rr.candidates[0].disposition = 'retract';
    rr.candidates[0].target_refs = [{ schema_version: 1, fact_id: commit.facts[11].fact_id, revision: 1 }];
    const retracted = await s.commitReview(rr);
    await s.markExportReady(retracted.batch_id, c.data_dir + '/retract.json');
    await consumer.consume();
    for (const kind of ['weekly', 'monthly'] as const) {
        let current = starts.get(kind);
        const refs: string[] = [], id = (current.analysis_context ?? current.monthly_context!).facts_page!.snapshot_id;
        for (let n = 0; n < 20; n++) {
            const context = current.analysis_context ?? current.monthly_context!, page = context.facts_page!;
            assert.equal(page.snapshot_id, id);
            assert(Buffer.byteLength(canonical(current)) <= 8192);
            assert(context.facts.length);
            if (kind === 'weekly')
                assert(!canonical(current).includes('PRIVATE'));
            for (const fact of context.facts)
                refs.push(('fact_ref' in fact ? fact.fact_ref.fact_id : fact.fact_id) + ':' + ('fact_ref' in fact ? fact.fact_ref.revision : fact.revision));
            if (page.next_offset === null)
                break;
            current = (await reviewer.prepare({ kind, lane: 'history', period: kind === 'weekly' ? '2026-10-04' : '2026-09', cutoff, fact_snapshot: id, fact_offset: page.next_offset }))[0];
        }
        assert.equal(refs.length, 12);
        assert.equal(new Set(refs).size, 12);
        assert.deepEqual(new Set(refs), new Set(commit.facts.map(fact => fact.fact_id + ':1')));
        await assert.rejects(reviewer.prepare({ kind, lane: 'history', period: kind === 'weekly' ? '2026-10-04' : '2026-09', cutoff: '2026-10-06T00:00:00Z', fact_snapshot: id, fact_offset: 1 }), /scope\/cutoff mismatch/);
    }
    s.close();
});
