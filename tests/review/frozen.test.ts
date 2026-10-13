import {exactReviewUnit} from '../../src/store/unit-dispositions.ts';
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
    r.candidates = events.map((e, i) => ({ ...candidate(b, 'candidate:' + i), content: 'PRIVATE mixed source ' + 'x'.repeat(1200), event_refs: [{ schema_version: 1, ...exactReviewUnit(e) }], analytics_projection: { schema_version: 1, value: { ...candidate(b).analytics_projection.value!, summary: 'Professional summary ' + i + ' '.repeat(500), event_refs: [{ schema_version: 1, ...exactReviewUnit(e) }] }, reason: null } }));
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
test('accepted consecutive pages accumulate monthly refs and weekly observations without replacing the previous page', async () => {
    const c = await config();
    c.limits.bundle_bytes = 8192;
    const s = await createStore(c), events = Array.from({ length: 8 }, (_, i) => event('accumulate:' + i));
    await s.saveCollection(collection(events));
    const b = bundle(events);
    await s.saveBundle(b);
    const r = result(b);
    r.pages = [];
    r.candidates = events.map((e, i) => ({ ...candidate(b, 'claim:' + i), content: 'Monthly original ' + i + 'x'.repeat(1800), event_refs: [{ schema_version: 1, ...exactReviewUnit(e) }], analytics_projection: { schema_version: 1, value: { ...candidate(b).analytics_projection.value!, summary: 'Professional ' + i + 'x'.repeat(500), event_refs: [{ schema_version: 1, ...exactReviewUnit(e) }] }, reason: null } }));
    const initial = await s.commitReview(r);
    await s.markExportReady(initial.batch_id, c.data_dir + '/initial.json');
    const analytics = createAnalyticsConsumer(s, c);
    await analytics.consume();
    const reviewer = createReviewer(s, c);
    for (const kind of ['monthly', 'weekly'] as const) {
        let page = (await reviewer.prepare({ kind, lane: 'history', period: kind === 'weekly' ? '2026-10-04' : '2026-09', cutoff }))[0];
        const allRefs = new Set<string>();
        let snapshotId = '', offset = 0;
        for (let i = 0; i < 2; i++) {
            const context = page.analysis_context ?? page.monthly_context!, fp = context.facts_page!;
            snapshotId = fp.snapshot_id;
            const rr = result(page, kind + ':page:' + i, false);
            if (kind === 'monthly') {
                rr.monthly_review = { schema_version: 1, month: '2026-09', summary: 'Accepted page ' + i, supplement_text: '', fact_refs: page.monthly_context!.facts.map(fact => ({ schema_version: 1, fact_id: fact.fact_id, revision: fact.revision })), coverage_status: 'partial' };
                for (const ref of rr.monthly_review.fact_refs)
                    allRefs.add(ref.fact_id + ':' + ref.revision);
            }
            else {
                rr.analysis = { schema_version: 1, snapshot: { schema_version: 1, analysis_ref: page.analysis_context!.analysis_ref!, week_end: '2026-10-04', coverage_status: 'partial', observations: page.analysis_context!.observation_candidates!, capabilities: [], goal_gaps: [], direction: 'unknown', patterns: ['Accepted weekly material ' + i], validation_action: null }, prior_action_disposition: null, proposed_confirmations: page.analysis_context!.observation_candidates!.slice(0, 3).map(observation => observation.observation_ref), freshness_at: cutoff };
                for (const observation of rr.analysis.snapshot.observations)
                    for (const ref of observation.evidence_refs)
                        allRefs.add(ref.fact_id + ':' + ref.revision);
            }
            const accepted = await reviewer.accept(rr);
            await s.markExportReady(accepted.batch_id, c.data_dir + '/' + kind + i + '.json');
            const artifact = (await s.listOutbox()).find(item => item.batch_id === accepted.batch_id)!.artifact;
            if (kind === 'monthly') {
                assert.deepEqual(new Set(artifact.monthly_review!.fact_refs.map(ref => ref.fact_id + ':' + ref.revision)), allRefs);
                if (i === 1)
                    assert(artifact.monthly_review!.summary.includes('Accepted page 0'));
                const { createMonthlyConsumer } = await import('../../src/consumers/monthly/index.ts');
                assert.equal((await createMonthlyConsumer(s, c).publishMonthlyReview(artifact)).status, 'complete');
            }
            else {
                assert.deepEqual(new Set(artifact.analysis!.snapshot.observations.flatMap(observation => observation.evidence_refs.map(ref => ref.fact_id + ':' + ref.revision))), allRefs);
                assert(artifact.analysis!.proposed_confirmations.length <= 3);
                assert.equal((await analytics.consume()).status, 'complete');
            }
            offset = fp.next_offset!;
            if (i === 0)
                assert(offset > fp.offset);
            if (i === 0)
                page = (await reviewer.prepare({ kind, lane: 'history', period: kind === 'weekly' ? '2026-10-04' : '2026-09', cutoff, fact_snapshot: snapshotId, fact_offset: offset }))[0];
        }
    }
    s.close();
});
