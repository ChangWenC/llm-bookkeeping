import type { BookkeepingConfig, PrepareRequest, ReviewBundle, Store, FactRef, FactRevision, ProfessionalFact, WeeklyObservation, FactsPage, CoverageGap } from '../contracts/types.ts';
import { prepareWeeklyAnalysis, analyticsRepository } from '../consumers/analytics/index.ts';
import { analysisWeekEnd } from '../time.ts';
import { SqliteStore } from '../store/index.ts';
import { canonical, digest } from '../analytics/serialization.ts';
import { createMonthlyConsumer } from '../consumers/monthly/index.ts';
import { readPageBaseline } from './baselines.ts';
import { coverageStatus, factKey } from '../analytics/model.ts';
import { addArchiveContexts } from './archives.ts';
const gap = (reason: string): CoverageGap => ({ schema_version: 1, range: null, reason, locator: null, resumable: true });
function frozen(store: Store, request: PrepareRequest, period: string, initial: FactRef[], work_ids: string[], context_work_ids: string[] = []): {
    refs: FactRef[];
    work_ids: string[];
    page: FactsPage;
} {
    if (!(store instanceof SqliteStore))
        throw new Error('Fact pagination requires transactional Store');
    const offset = request.fact_offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0)
        throw new Error('fact_offset must be nonnegative');
    if (offset && !request.fact_snapshot)
        throw new Error('Continuation requires frozen fact_snapshot');
    let id = request.fact_snapshot;
    if (!id)
        id = store.freezeFactMaterial(request.kind as 'weekly' | 'monthly', period, request.cutoff, initial.sort((a, b) => factKey(a).localeCompare(factKey(b))), work_ids, context_work_ids);
    const snapshot = store.getFactMaterial(id);
    if (!snapshot || snapshot.kind !== request.kind || snapshot.period !== period || snapshot.cutoff !== request.cutoff)
        throw new Error('Fact snapshot scope/cutoff mismatch; prepare only this page again');
    if (offset > snapshot.refs.length)
        throw new Error('fact_offset exceeds frozen snapshot');
    return { refs: snapshot.refs, work_ids: snapshot.work_ids ?? [], page: { schema_version: 1, snapshot_id: id, cutoff: snapshot.cutoff, offset, next_offset: null, total: snapshot.refs.length } };
}
function finishPage(bundle: ReviewBundle, page: FactsPage, end: number): void {
    page.next_offset = end < page.total ? end : null;
    const context = bundle.analysis_context ?? bundle.monthly_context!;
    if (page.offset || page.next_offset !== null) {
        context.coverage_status = 'partial';
        bundle.unfinished.push(gap(`Frozen fact page ${page.offset}..${end}/${page.total}; continue with the same cutoff/snapshot and next_offset`));
    }
}
async function workIds(store: Store, kind: string, period: string, cutoff: string): Promise<string[]> { return (await store.listWork(kind, 'pending')).filter(item => Date.parse(item.updated_at) <= Date.parse(cutoff) && (kind === 'analytics_prepare' ? item.payload.week_end === period : item.payload.month === period)).map(item => item.work_id).sort(); }
function fitIds(bundle: ReviewBundle, ids: string[], limit: number): string[] {
    const context = bundle.analysis_context ?? bundle.monthly_context!;
    context.prepared_work_ids = [];
    for (const id of ids.slice(0, 32)) {
        context.prepared_work_ids.push(id);
        if (Buffer.byteLength(canonical(bundle)) + 2048 > limit) {
            context.prepared_work_ids.pop();
            break;
        }
    }
    if (context.prepared_work_ids.length < ids.length)
        bundle.unfinished.push(gap(`Preparation work IDs omitted by budget: ${context.prepared_work_ids.length}/${ids.length}`));
    return context.prepared_work_ids;
}
async function save(store: Store, bundle: ReviewBundle, limit: number): Promise<ReviewBundle[]> {
    bundle.bundle_id = 'bundle:' + digest(canonical(bundle));
    if (Buffer.byteLength(canonical(bundle)) > limit)
        throw new Error('Bounded semantic context cannot fit; pending only this requested material page');
    await store.saveBundle(bundle);
    return [bundle];
}
export async function prepareWeeklyBundle(store: Store, config: BookkeepingConfig, request: PrepareRequest): Promise<ReviewBundle[]> {
    const week = request.period ?? analysisWeekEnd(request.cutoff), context = await prepareWeeklyAnalysis(store, config, week), repository = analyticsRepository(store);
    const eligible = store instanceof SqliteStore ? store.effectiveFactRefsAt(request.cutoff) : [];
    const all = repository.lookupFacts(eligible).filter(fact => fact.occurred_at.value && Date.parse(fact.occurred_at.value) >= Date.parse(context.range.from) && Date.parse(fact.occurred_at.value) < Date.parse(context.range.to));
    const snapshot = frozen(store, request, week, all.map(fact => fact.fact_ref), await workIds(store, 'analytics_prepare', week, request.cutoff));
    context.facts_page = snapshot.page;
    const material = repository.lookupFacts(snapshot.refs);
    const byRef = new Map(material.map(fact => [factKey(fact.fact_ref), fact]));
    const allCandidates = context.observation_candidates ?? [], coverage = context.coverage;
    context.facts = [];
    context.coverage = [];
    context.observation_candidates = [];
    const bundle: ReviewBundle = { schema_version: 1, bundle_id: '', kind: 'weekly', lane: request.lane, period: week, cutoff: request.cutoff, chunks: [{ schema_version: 1, chunk_id: 'weekly:' + snapshot.page.snapshot_id + ':' + snapshot.page.offset, events: [], context_events: [], body_bytes: 0 }], existing_facts: [], baselines: [], coverage: [], unfinished: [], analysis_context: context };
    const limit = config.limits.bundle_bytes;
    context.prepared_work_ids = [];
    while (Buffer.byteLength(canonical(bundle)) + 2048 > limit && context.previous_weeks.length) {
        context.previous_weeks.shift();
        bundle.unfinished.push(gap('Prior weekly context omitted by material budget'));
    }
    // A single old snapshot may itself be large; it remains immutable in Store and receives a new revision if omitted here.
    if (Buffer.byteLength(canonical(bundle)) + 2048 > limit && context.previous_snapshot) {
        delete context.previous_snapshot;
        bundle.unfinished.push(gap('Previous snapshot body omitted by material budget; identical-content reuse requires a wider page'));
    }
    let end = snapshot.page.offset;
    for (; end < snapshot.refs.length; end++) {
        const ref = snapshot.refs[end], fact = byRef.get(factKey(ref));
        if (!fact) {
            bundle.unfinished.push(gap('Frozen professional fact unavailable: ' + factKey(ref)));
            continue;
        }
        const candidates = allCandidates.filter(item => item.evidence_refs.some(evidence => factKey(evidence) === factKey(ref)));
        const oldCandidates: WeeklyObservation[] = context.observation_candidates ?? [];
        context.facts.push(fact);
        context.observation_candidates = [...oldCandidates, ...candidates];
        if (Buffer.byteLength(canonical(bundle)) + 2048 > limit) {
            context.facts.pop();
            context.observation_candidates = oldCandidates;
            if (context.facts.length)
                break;
            bundle.unfinished.push(gap('Single professional fact exceeds material budget: ' + factKey(ref)));
        }
    }
    finishPage(bundle, snapshot.page, end);
    const reads = store instanceof SqliteStore ? store.getFactMaterialReads(snapshot.page.snapshot_id) : new Set<string>();
    for (const fact of context.facts)
        reads.add(factKey('fact_ref' in fact ? fact.fact_ref : fact));
    if (snapshot.refs.every(ref => reads.has(factKey(ref))))
        fitIds(bundle, snapshot.work_ids, limit);
    for (const record of coverage) {
        if (Buffer.byteLength(canonical(context.coverage)) + Buffer.byteLength(canonical(record)) > 16384)
            break;
        context.coverage.push(record);
        if (Buffer.byteLength(canonical(bundle)) + 1024 > limit) {
            context.coverage.pop();
            break;
        }
    }
    if (context.coverage.length < coverage.length)
        bundle.unfinished.push(gap(`Coverage metadata omitted: ${context.coverage.length}/${coverage.length}; coverage_status computed from the complete provider/scope ledger`));
    if (context.coverage_status !== 'complete')
        bundle.unfinished.push(gap('Weekly capture/review/material coverage is incomplete'));
    if (!context.facts.length)
        bundle.unfinished.push(gap('No ready professional facts; missing projections are excluded and never derived from private source text'));
    return save(store, bundle, limit);
}
export async function prepareMonthlyBundle(store: Store, config: BookkeepingConfig, request: PrepareRequest): Promise<ReviewBundle[]> {
    const month = request.period ?? request.cutoff.slice(0, 7), context = await createMonthlyConsumer(store, config).prepareMonthlyContext(month);
    if (!(store instanceof SqliteStore))
        throw new Error('Monthly pagination requires transactional Store');
    context.coverage_status = coverageStatus(config, context.coverage, context.range);
    context.manual_baselines = await Promise.all(context.manual_baselines.map(page => readPageBaseline(config, page.path, Math.max(64, Math.floor(config.limits.bundle_bytes / 8)))));
    const explicitPaths = [...new Set(request.page_paths ?? [])].slice(0, 16);
    const explicitIssues: CoverageGap[] = [];
    const excerptBudget = Math.max(64, Math.floor(config.limits.bundle_bytes / (8 * (explicitPaths.length + 1))));
    for (const path of explicitPaths) {
        try {
            const page = await readPageBaseline(config, path, excerptBudget);
            if (!context.manual_baselines.some(existing => existing.path === page.path))
                context.manual_baselines.push(page);
            if (page.context_excerpt)
                explicitIssues.push(gap(page.excerpt_reason!));
        }
        catch (error) {
            explicitIssues.push(gap('Explicit monthly page unavailable: ' + String(error)));
        }
    }
    const atCutoff = new Set(store.effectiveFactRefsAt(request.cutoff).map(factKey));
    const snapshot = frozen(store, request, month, context.facts.filter(fact => atCutoff.has(factKey(fact))).map(fact => ({ schema_version: 1, fact_id: fact.fact_id, revision: fact.revision })), await workIds(store, 'prepare_monthly', month, request.cutoff), await workIds(store, 'archive_context', month, request.cutoff));
    context.facts_page = snapshot.page;
    const material = new Map(store.lookupFactRevisions(snapshot.refs).map(fact => [factKey(fact), fact])), coverage = context.coverage;
    context.facts = [];
    context.coverage = [];
    const bundle: ReviewBundle = { schema_version: 1, bundle_id: '', kind: 'monthly', lane: request.lane, period: month, cutoff: request.cutoff, chunks: [{ schema_version: 1, chunk_id: 'monthly:' + snapshot.page.snapshot_id + ':' + snapshot.page.offset, events: [], context_events: [], body_bytes: 0 }], existing_facts: [], baselines: context.manual_baselines, coverage: [], unfinished: [], monthly_context: context };
    const limit = config.limits.bundle_bytes;
    bundle.unfinished.push(...explicitIssues);
    context.prepared_work_ids = [];
    let end = snapshot.page.offset;
    for (; end < snapshot.refs.length; end++) {
        const ref = snapshot.refs[end], fact = material.get(factKey(ref));
        if (!fact) {
            bundle.unfinished.push(gap('Frozen monthly fact unavailable: ' + factKey(ref)));
            continue;
        }
        context.facts.push(fact);
        if (Buffer.byteLength(canonical(bundle)) + 2048 > limit) {
            context.facts.pop();
            if (context.facts.length)
                break;
            bundle.unfinished.push(gap('Single monthly fact exceeds material budget: ' + factKey(ref)));
        }
    }
    finishPage(bundle, snapshot.page, end);
    const reads = store.getFactMaterialReads(snapshot.page.snapshot_id);
    for (const fact of context.facts)
        reads.add(factKey(fact));
    if (snapshot.refs.every(ref => reads.has(factKey(ref))))
        fitIds(bundle, snapshot.work_ids, limit);
    await addArchiveContexts(store, config, bundle, request.archive_context_offset ?? 0);
    for (const record of coverage) {
        if (Buffer.byteLength(canonical(context.coverage)) + Buffer.byteLength(canonical(record)) > 16384)
            break;
        context.coverage.push(record);
        if (Buffer.byteLength(canonical(bundle)) + 1024 > limit) {
            context.coverage.pop();
            break;
        }
    }
    if (context.coverage.length < coverage.length)
        bundle.unfinished.push(gap(`Coverage metadata omitted: ${context.coverage.length}/${coverage.length}; accurate status retained`));
    for (const page of context.manual_baselines)
        if (page.context_excerpt)
            bundle.unfinished.push(gap(page.excerpt_reason!));
    if (context.coverage_status !== 'complete')
        bundle.unfinished.push(gap('Monthly capture/review/material coverage is incomplete'));
    return save(store, bundle, limit);
}
