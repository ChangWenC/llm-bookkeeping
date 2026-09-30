import type { BookkeepingConfig, PrepareRequest, ReviewBundle, Store } from '../contracts/types.ts';
import { prepareWeeklyAnalysis } from '../consumers/analytics/index.ts';
import { analysisWeekEnd } from '../time.ts';
import { canonical, digest } from '../store/index.ts';
export async function prepareWeeklyBundle(store: Store, config: BookkeepingConfig, request: PrepareRequest): Promise<ReviewBundle[]> {
    const weekEnd = request.period ?? analysisWeekEnd(request.cutoff);
    const context = await prepareWeeklyAnalysis(store, config, weekEnd);
    const bundle: ReviewBundle = { schema_version: 1, bundle_id: '', kind: 'weekly', lane: request.lane, period: weekEnd, cutoff: request.cutoff,
        chunks: [{ schema_version: 1, chunk_id: 'analysis:' + digest(canonical(context)), events: [], context_events: [], body_bytes: 0 }],
        existing_facts: [], baselines: [], coverage: [], unfinished: [], analysis_context: structuredClone(context) };
    const limit = config.limits.bundle_bytes;
    let omitted = false;
    const fits = () => Buffer.byteLength(canonical(bundle)) + 768 <= limit;
    while (!fits() && bundle.analysis_context!.previous_weeks.length) {
        bundle.analysis_context!.previous_weeks.shift();
        omitted = true;
    }
    while (!fits() && bundle.analysis_context!.facts.length) {
        const removed = bundle.analysis_context!.facts.pop()!;
        bundle.analysis_context!.observation_candidates = bundle.analysis_context!.observation_candidates!.filter(observation => !observation.evidence_refs.some(ref => ref.fact_id === removed.fact_ref.fact_id && ref.revision === removed.fact_ref.revision));
        omitted = true;
    }
    while (!fits() && bundle.analysis_context!.coverage.length) {
        bundle.analysis_context!.coverage.pop();
        omitted = true;
    }
    if (!fits())
        throw new Error('Weekly fixed context cannot fit configured bundle budget');
    if (omitted) {
        bundle.analysis_context!.coverage_status = 'partial';
        bundle.unfinished.push({ schema_version: 1, range: context.range, reason: 'Bounded weekly preparation omitted professional facts/coverage/history; preserve pending ranges', locator: null, resumable: true });
    }
    if (context.coverage_status !== 'complete')
        bundle.unfinished.push({ schema_version: 1, range: context.range, reason: 'Weekly capture/review coverage is incomplete', locator: null, resumable: true });
    if (!context.facts.length)
        bundle.unfinished.push({ schema_version: 1, range: context.range, reason: 'No ready professional facts; missing projections are excluded and never derived from private source text', locator: null, resumable: true });
    bundle.coverage = bundle.analysis_context!.coverage;
    // Avoid carrying the same large coverage twice in the typed and generic fields.
    if (Buffer.byteLength(canonical(bundle)) + 128 > limit)
        bundle.coverage = [];
    bundle.bundle_id = 'bundle:' + digest(canonical(bundle));
    await store.saveBundle(bundle);
    return [bundle];
}
import { createMonthlyConsumer } from '../consumers/monthly/index.ts';
import { readPageBaseline } from './baselines.ts';
import { coverageStatus } from '../analytics/model.ts';
export async function prepareMonthlyBundle(store: Store, config: BookkeepingConfig, request: PrepareRequest): Promise<ReviewBundle[]> {
    const month = request.period ?? request.cutoff.slice(0, 7);
    const context = await createMonthlyConsumer(store, config).prepareMonthlyContext(month);
    context.coverage_status = coverageStatus(config, context.coverage, context.range);
    context.manual_baselines = await Promise.all(context.manual_baselines.map(page => readPageBaseline(config, page.path, Math.max(64, Math.floor(config.limits.bundle_bytes / 8)))));
    const original = { facts: context.facts.length, coverage: context.coverage.length };
    const bundle: ReviewBundle = { schema_version: 1, bundle_id: '', kind: 'monthly', lane: request.lane, period: month, cutoff: request.cutoff, chunks: [{ schema_version: 1, chunk_id: 'monthly:' + digest(canonical(context)), events: [], context_events: [], body_bytes: 0 }], existing_facts: [], baselines: context.manual_baselines, coverage: [], unfinished: [], monthly_context: context };
    const fits = () => Buffer.byteLength(canonical(bundle)) + 768 <= config.limits.bundle_bytes;
    while (!fits() && context.facts.length)
        context.facts.pop();
    while (!fits() && context.coverage.length)
        context.coverage.pop();
    if (!fits())
        throw new Error('Monthly fixed context cannot fit configured bundle budget');
    if (context.facts.length < original.facts || context.coverage.length < original.coverage) {
        context.coverage_status = 'partial';
        bundle.unfinished.push({ schema_version: 1, range: context.range, reason: `Bounded monthly context omitted: facts ${context.facts.length}/${original.facts}, coverage ${context.coverage.length}/${original.coverage}`, locator: null, resumable: true });
    }
    for (const page of context.manual_baselines)
        if (page.context_excerpt)
            bundle.unfinished.push({ schema_version: 1, range: null, reason: page.excerpt_reason!, locator: page.path, resumable: true });
    if (context.coverage_status !== 'complete')
        bundle.unfinished.push({ schema_version: 1, range: context.range, reason: 'Monthly capture/review coverage is incomplete', locator: null, resumable: true });
    const work = (await store.listWork('prepare_monthly', 'pending')).filter(item => item.payload.month === month);
    context.prepared_work_ids = [];
    for (const item of work) {
        context.prepared_work_ids.push(item.work_id);
        if (!fits()) {
            context.prepared_work_ids.pop();
            break;
        }
    }
    if (context.prepared_work_ids.length < work.length)
        bundle.unfinished.push({ schema_version: 1, range: context.range, reason: `Monthly preparation work IDs omitted by budget: ${context.prepared_work_ids.length}/${work.length}`, locator: null, resumable: true });
    bundle.bundle_id = 'bundle:' + digest(canonical(bundle));
    await store.saveBundle(bundle);
    return [bundle];
}
