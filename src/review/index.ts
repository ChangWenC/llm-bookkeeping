import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { BookkeepingConfig, Reviewer, Store, ReviewBundle, ReviewChunk, SourceEvent, PrepareRequest, ReviewResult, TimeRange, CoverageGap, PageBaseline, PreparationResult } from '../contracts/types.ts';
import { SqliteStore, canonical, digest } from '../store/index.ts';
import { validateReviewResult, utc, date } from '../contracts/validation.ts';
import { prepareWeeklyBundle, prepareMonthlyBundle } from './analysis.ts';
import { readPageBaseline } from './baselines.ts';
function localDate(time: string, zone: string): string { return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(time)); }
function addDays(value: string, amount: number): string { const d = new Date(value + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + amount); return d.toISOString().slice(0, 10); }
/** Resolve local midnight using actual IANA offsets (including DST), never the host timezone. */
function midnight(value: string, zone: string): string {
    let guess = Date.parse(value + 'T00:00:00Z');
    const target = guess;
    for (let n = 0; n < 5; n++) {
        const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(guess));
        const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
        const wall = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
        const next = guess + target - wall;
        if (next === guess)
            return new Date(guess).toISOString();
        guess = next;
    }
    throw new Error('Cannot resolve period midnight in timezone ' + zone);
}
function requestRange(request: PrepareRequest, config: BookkeepingConfig): TimeRange {
    utc(request.cutoff, 'cutoff');
    if (!['daily', 'weekly', 'monthly'].includes(request.kind) || !['live', 'history'].includes(request.lane))
        throw new Error('Invalid review kind/lane');
    if (request.range) {
        if (request.period || request.replay_id) throw new Error('Explicit range cannot combine period or replay');
        utc(request.range.from, 'range.from'); utc(request.range.to, 'range.to');
        if (Date.parse(request.range.from) >= Date.parse(request.range.to) || Date.parse(request.range.to) > Date.parse(request.cutoff)) throw new Error('Invalid explicit review range');
        return request.range;
    }
    let from: string;
    let to = request.cutoff;
    if (request.period) {
        const historical = request.period + 'T12:00:00Z';
        const timeline = [...config.journal_timezone_timeline].sort((a, b) => Date.parse(a.effective_from) - Date.parse(b.effective_from));
        const zone = request.kind === 'daily' ? timeline.filter(entry => Date.parse(entry.effective_from) <= Date.parse(historical)).at(-1)?.timezone ?? config.journal_timezone : config.analysis_timezone;
        if (request.kind === 'monthly') {
            if (!/^\d{4}-\d\d$/.test(request.period))
                throw new Error('Monthly period must be YYYY-MM');
            date(request.period + '-01', 'period');
            from = midnight(request.period + '-01', zone);
            const next = new Date(request.period + '-01T12:00:00Z');
            next.setUTCMonth(next.getUTCMonth() + 1);
            to = midnight(next.toISOString().slice(0, 10), zone);
        }
        else {
            date(request.period, 'period');
            from = midnight(request.kind === 'weekly' ? addDays(request.period, -6) : request.period, zone);
            to = midnight(addDays(request.period, 1), zone);
        }
        if (Date.parse(to) > Date.parse(request.cutoff))
            to = request.cutoff;
    }
    else if (request.kind === 'daily')
        from = request.lane === 'live' ? new Date(Math.max(Date.parse(config.live_start), Date.parse(request.cutoff) - 48 * 3600000)).toISOString() : '0001-01-01T00:00:00.000Z';
    else {
        const today = localDate(request.cutoff, config.analysis_timezone);
        from = request.kind === 'monthly' ? midnight(today.slice(0, 7) + '-01', config.analysis_timezone) : midnight(addDays(today, -(new Date(today + 'T12:00:00Z').getUTCDay() + 6) % 7), config.analysis_timezone);
    }
    if (Date.parse(from) >= Date.parse(to))
        throw new Error('Review period is beyond cutoff');
    return { schema_version: 1, from, to };
}
function* slices(event: SourceEvent, limit: number, reviewedSpans: {
    start_byte: number;
    end_byte: number;
}[]): Generator<SourceEvent> {
    const body = event.body ?? '';
    const bytes = Buffer.from(body);
    if (bytes.length <= limit && !reviewedSpans.length) {
        yield event;
        return;
    }
    const intervals: {
        start: number;
        end: number;
    }[] = [];
    let frontier = 0;
    for (const span of reviewedSpans) {
        if (span.start_byte > frontier)
            intervals.push({ start: frontier, end: span.start_byte });
        frontier = Math.max(frontier, span.end_byte);
    }
    if (frontier < bytes.length)
        intervals.push({ start: frontier, end: bytes.length });
    for (const interval of intervals)
        for (let start = interval.start; start < interval.end;) {
            let end = Math.min(interval.end, start + limit);
            while (end < bytes.length && (bytes[end] & 0xc0) === 0x80)
                end--;
            if (end <= start)
                throw new Error('chunk_body_bytes cannot fit a UTF-8 character');
            const context = { ...event.context, review_slice: { source_event_id: event.event_id, start_byte: start, end_byte: end, total_bytes: bytes.length } };
            yield { ...event, event_id: 'slice:' + digest(canonical([event.event_id, start, end])), body: bytes.subarray(start, end).toString('utf8'), context };
            start = end;
        }
}
const gap = (reason: string, range: TimeRange | null = null, locator: string | null = null): CoverageGap => ({ schema_version: 1, range, reason, locator, resumable: true });
async function baseline(config: BookkeepingConfig, path: string): Promise<PageBaseline> {
    return readPageBaseline(config, path);
}
function targetPath(kind: string, event: SourceEvent | undefined, config: BookkeepingConfig, cutoff: string, period?: string): string {
    if (kind === 'weekly')
        return 'wiki/personal/synthesis/综合_self_analytics_current.md';
    const day = event?.journal_date.value ?? localDate(cutoff, config.journal_timezone);
    const current = localDate(cutoff, config.journal_timezone).slice(0, 7);
    const previous = new Date(current + '-01T12:00:00Z');
    previous.setUTCMonth(previous.getUTCMonth() - 1);
    const keepFrom = previous.toISOString().slice(0, 7);
    if (kind === 'monthly' || day.slice(0, 7) < keepFrom)
        return `wiki/personal/journals/reviews/回顾_${(kind === 'monthly' ? period ?? day.slice(0, 7) : day.slice(0, 7)).replaceAll('-', '_')}.md`;
    return 'wiki/personal/journals/日记_' + day.replaceAll('-', '_') + '.md';
}
export function createReviewer(store: Store, config: BookkeepingConfig): Reviewer {
    if (!(store instanceof SqliteStore))
        throw new Error('Reviewer requires transactional SQLite store');
    for (const [key, value] of Object.entries(config.limits))
        if (!Number.isSafeInteger(value) || value < 1)
            throw new Error('Invalid review limit ' + key);
    const prepareDaily = async (request: PrepareRequest, persist = true): Promise<ReviewBundle[]> => {
            const replayWork = request.replay_id ? await store.getSemanticReplay(request.replay_id) : null;
            if (replayWork && request.source && request.source !== replayWork.payload.source) throw new Error('Replay source differs from frozen work');
            if (replayWork) request = { ...request, source: replayWork.payload.source as string };
            if (request.source === 'wechat') store.reviewScope.validate();
            if (request.replay_id && (!replayWork || request.kind !== 'daily' || request.period))
                throw new Error('Semantic replay requires its explicit daily work scope without --period');
            if (replayWork?.state === 'complete') return [];
            if (replayWork) request = { ...request, cutoff: replayWork.payload.cutoff as string };
            if (request.kind === 'weekly')
                return prepareWeeklyBundle(store, config, request);
            if (request.kind === 'monthly')
                return prepareMonthlyBundle(store, config, request);
            const range = replayWork ? replayWork.payload.range as TimeRange : requestRange(request, config);
            const limits = { ...config.limits, bundles_per_round: Math.min(config.limits.bundles_per_round, request.max_bundles ?? config.limits.bundles_per_round) };
            const progressKind = replayWork ? 'replay:' + replayWork.work_id : request.kind;
            const progressLane = replayWork ? 'history' : request.lane;
            const reviewed = store.getReviewedUnits(progressKind, progressLane);
            // Each page fetch is bounded; fully reviewed sources are excluded in SQL so a historical prefix cannot starve new work.
            const events = replayWork ? store.getReplayEvents(replayWork.work_id, limits.chunk_events * limits.bundles_per_round * 4)
                : request.kind === 'daily' ? await store.getReviewableEvents({ range, source: request.source, lane: request.lane, limit: limits.chunk_events * limits.bundles_per_round * 4 }, request.kind) : [];
            const effectiveFacts = replayWork ? store.getReplayFacts(replayWork.work_id) : await store.readEffectiveFacts({ range });
            const scopedFacts = store.filterReviewFacts(effectiveFacts);
            const facts = request.kind === 'daily' ? scopedFacts : effectiveFacts.flatMap(f => {
                const projection = f.analytics_projection?.value;
                if (!projection)
                    return [];
                return [{ ...f, content: projection.summary, scope: projection.scope, subject: projection.subject, event_refs: projection.event_refs, attribution: projection.attribution }];
            });
            const coverage = (await store.listCoverage(range)).filter(c => c.lane === request.lane && (!request.source || c.provider === request.source) && (c.conversation_id === null || store.reviewScope.allowed(c.provider, c.account_id, c.conversation_id, undefined)));
            const unfinished = coverage.flatMap(c => c.gaps);
            if (request.source === 'wechat') unfinished.push(...store.reviewScope.registryGaps().map(reason => gap(reason, range)));
            if (replayWork) unfinished.push(gap('Explicit semantic replay; only this work’s actual event slices are completed, capture coverage remains independent', range));
            if (!request.source || request.source === 'codex') unfinished.push(...store.getClassificationGaps(range).map(item => gap(item.reason, null, item.locator)));
            unfinished.push(...store.sourcePendingGaps(range, request.source).map(item => gap(item.reason, null, item.locator)));
            if (request.source) unfinished.push(...store.metadataScopeGaps(range, request.source).map(item => gap(item.reason, null, item.locator)));
            const requestedBaselines: PageBaseline[] = [];
            if (request.page_paths && (!Array.isArray(request.page_paths) || request.page_paths.some(path => typeof path !== 'string')))
                throw new Error('page_paths must be an array of explicit Wiki paths');
            for (const path of (request.page_paths ?? []).slice(0, 16)) {
                try {
                    const page = await readPageBaseline(config, path, Math.max(64, Math.floor(limits.bundle_bytes / 8)));
                    requestedBaselines.push(page);
                    if (page.context_excerpt)
                        unfinished.push(gap(page.excerpt_reason!, null, page.path));
                }
                catch (error) {
                    unfinished.push(gap('Explicit page unavailable: ' + String(error), null, path));
                }
            }
            if ((request.page_paths?.length ?? 0) > 16)
                unfinished.push(gap('Explicit page list exceeds bounded 16-page round', range));
            if (request.kind !== 'daily')
                unfinished.push(gap('Weekly/monthly semantic snapshot, confirmation and action payload pending explicit downstream contract', range));
            if (request.kind !== 'daily' && facts.length < effectiveFacts.length)
                unfinished.push(gap('Facts without an explicit professional projection excluded from analytics material', range));
            if (!coverage.length)
                unfinished.push(gap('No capture coverage for requested range', range));
            for (const provider of config.providers.filter(p => p.enabled && (!request.source || p.provider === request.source)))
                if (!coverage.some(c => c.provider === provider.provider && c.account_id === provider.account_id))
                    unfinished.push(gap('Provider has no capture coverage: ' + provider.provider, range));
            const chunks: ReviewChunk[] = [];
            let pending: SourceEvent[] = [];
            let bodyBytes = 0;
            const flush = () => {
                if (!pending.length)
                    return;
                const contextEvents: SourceEvent[] = [];
                const first = pending[0];
                if (store.isContextTruncated(first))
                    unfinished.push(gap('Group participation context truncated by bounded twelve-event window', null, first.locator));
                for (const context of store.getContextEvents(first)) {
                    if (pending.some(e => e.event_id === context.event_id))
                        continue;
                    const bytes = Buffer.byteLength(context.body ?? '');
                    if (bodyBytes + bytes <= limits.chunk_body_bytes && Buffer.byteLength(canonical({ events: pending, context_events: [...contextEvents, context] })) + 1024 <= Math.floor(limits.bundle_bytes / 2)) {
                        contextEvents.push(context);
                        bodyBytes += bytes;
                    }
                    else
                        unfinished.push(gap('Conversation context omitted by chunk byte budget', null, context.locator));
                }
                const chunk: ReviewChunk = { schema_version: 1, chunk_id: 'chunk:' + digest(canonical([request.kind, request.lane, ...(replayWork ? [replayWork.work_id] : []), 'review-material-v2', pending, contextEvents])), events: pending, context_events: contextEvents, body_bytes: bodyBytes };
                chunks.push(chunk);
                pending = [];
                bodyBytes = 0;
            };
            // Reserve room for baselines, coverage and existing facts rather than filling the round with body bytes alone.
            const capacity = limits.bundles_per_round;
            const units = function* () {
                for (const event of events)
                    for (const unit of slices(event, limits.chunk_body_bytes, store.getReviewedSpans(progressKind, progressLane, event.event_id)))
                        if (!reviewed.has(unit.event_id))
                            yield unit;
            };
            for (const unit of units()) {
                // stop_reason describes assistant generation, not whether a captured human input is complete.
                // Keep the independent explicit incomplete-input marker authoritative for every role.
                if ((unit.role !== 'user' && unit.context.turn_complete === false) || unit.context.incomplete_turn === true) {
                    unfinished.push(gap('Incomplete source turn requires subsequent context', null, unit.locator));
                    continue;
                }
                const bytes = Buffer.byteLength(unit.body ?? '');
                if (pending.length && (pending.length >= limits.chunk_events || bodyBytes + bytes > limits.chunk_body_bytes || Buffer.byteLength(canonical([...pending, unit])) > Math.floor(limits.bundle_bytes / 2) || pending[0].journal_date.value !== unit.journal_date.value))
                    flush();
                if (chunks.length >= capacity) {
                    unfinished.push(gap('Unprepared event slices remain', range, unit.locator));
                    break;
                }
                pending.push(unit);
                bodyBytes += bytes;
            }
            flush();
            if (!chunks.length) {
                if (!replayWork && request.kind === 'daily' && !request.page_paths?.length && !events.length && (await store.listEvents({ range, source: request.source, lane: request.lane, limit: 1 })).length)
                    return [];
                // Empty material is an explicit review decision; missing capture remains pending even if zero-facts is accepted.
                const id = (request.page_paths?.length ? 'pages:' : 'empty:') + digest(canonical([request.kind, request.lane, request.source, ...(replayWork ? [replayWork.work_id] : []), range, coverage.map(c => ({ ...c, review_status: null })), facts, requestedBaselines]));
                if (reviewed.has(id))
                    return [];
                chunks.push({ schema_version: 1, chunk_id: id, events: [], context_events: [], body_bytes: 0 });
            }
            const bundles: ReviewBundle[] = [];
            let current: ReviewBundle | null = null;
            const omittedMarker = 'Bounded preparation metadata omitted';
            const initial = (): ReviewBundle => ({ schema_version: 1, bundle_id: '', source: request.source, kind: request.kind, lane: request.lane, period: request.period ?? null, cutoff: request.cutoff, ...(request.kind === 'daily' && (request.range !== undefined || request.period !== undefined || Date.parse(range.to) - Date.parse(range.from) <= 32 * 86400000) ? { review_range: range, review_timezone: [...config.journal_timezone_timeline].filter(entry => Date.parse(entry.effective_from) <= Date.parse(request.period ? request.period + 'T12:00:00Z' : range.from)).sort((a, b) => Date.parse(a.effective_from) - Date.parse(b.effective_from)).at(-1)?.timezone ?? config.journal_timezone } : {}), chunks: [], existing_facts: [], baselines: [], coverage: [], unfinished: [gap(omittedMarker, range)],
                ...(replayWork ? { replay: { schema_version: 1 as const, work_id: replayWork.work_id, source: replayWork.payload.source as string, range } } : {}) });
            const finish = async () => {
                if (!current)
                    return;
                const material = { ...current, unfinished: current.unfinished.filter(g => g.reason !== omittedMarker) };
                // The final omission description and fixed-length identity are part of
                // the hard byte budget. Trim optional context only, never primary events.
                while (true) {
                    const retained = new Set(material.unfinished.map(g => canonical(g)));
                    const omitted = material.coverage.length < coverage.length || material.existing_facts.length < facts.length || unfinished.some(g => !retained.has(canonical(g)));
                    const finished = { ...material, unfinished: omitted ? [gap(`${omittedMarker}: coverage ${material.coverage.length}/${coverage.length}, facts ${material.existing_facts.length}/${facts.length}; remaining metadata stays pending`, range), ...material.unfinished] : [...material.unfinished] };
                    finished.bundle_id = 'bundle:' + digest(canonical({ ...finished, bundle_id: null }));
                    if (Buffer.byteLength(canonical(finished)) <= limits.bundle_bytes) {
                        current = finished;
                        break;
                    }
                    if (material.unfinished.length) material.unfinished.pop();
                    else if (material.coverage.length) material.coverage.pop();
                    else if (material.existing_facts.length) material.existing_facts.pop();
                    else throw new Error('Primary review material cannot fit bounded bundle');
                }
                if (persist) await store.saveBundle(current);
                bundles.push(current);
                current = null;
            };
            for (const chunk of chunks) {
                if (bundles.length >= limits.bundles_per_round)
                    break;
                if (!current)
                    current = initial();
                const path = targetPath(request.kind, chunk.events[0], config, request.cutoff, request.period);
                let base: PageBaseline | undefined;
                try {
                    base = await baseline(config, path);
                }
                catch (error: any) {
                    if (!current.unfinished.some(g => g.locator === path))
                        current.unfinished.push(gap(error.message, null, path));
                }
                const proposed: ReviewBundle = { ...current, chunks: [...current.chunks, chunk], baselines: base && !current.baselines.some(b => b.path === path) ? [...current.baselines, base] : current.baselines };
                if (Buffer.byteLength(canonical(proposed)) + 1024 > limits.bundle_bytes) {
                    if (!current.chunks.length) {
                        unfinished.push(gap('Event metadata cannot fit bundle budget', range, chunk.events[0]?.locator ?? null));
                        continue;
                    }
                    await finish();
                    if (bundles.length >= limits.bundles_per_round)
                        break;
                    current = { ...initial(), chunks: [chunk], baselines: base ? [base] : [] };
                    if (Buffer.byteLength(canonical(current)) + 1024 > limits.bundle_bytes) {
                        current = null;
                        continue;
                    }
                }
                else
                    current = proposed;
                // Fit evidence metadata without breaking the hard serialized bound. Omitted context is explicitly reported.
                for (const page of requestedBaselines)
                    if (!current.baselines.some(existing => existing.path === page.path)) {
                        const p: ReviewBundle = { ...current, baselines: [...current.baselines, page] };
                        if (Buffer.byteLength(canonical(p)) + 768 <= limits.bundle_bytes)
                            current = p;
                        else if (!current.unfinished.some(g => g.locator === page.path))
                            current.unfinished.push(gap('Explicit page baseline omitted by bundle budget', null, page.path));
                    }
                for (const fact of facts)
                    if (!current.existing_facts.some(f => f.fact_id === fact.fact_id && f.revision === fact.revision)) {
                        const p: ReviewBundle = { ...current, existing_facts: [...current.existing_facts, fact] };
                        if (Buffer.byteLength(canonical(p)) + 768 <= limits.bundle_bytes)
                            current = p;
                    }
                for (const c of coverage)
                    if (!current.coverage.some(x => x.coverage_id === c.coverage_id)) {
                        const p: ReviewBundle = { ...current, coverage: [...current.coverage, c] };
                        if (Buffer.byteLength(canonical(p)) + 768 <= limits.bundle_bytes)
                            current = p;
                    }
                for (const g of unfinished) {
                    const p: ReviewBundle = { ...current, unfinished: [...current.unfinished, g] };
                    if (Buffer.byteLength(canonical(p)) + 256 <= limits.bundle_bytes)
                        current = p;
                }
                if (current.coverage.length < coverage.length || current.existing_facts.length < facts.length) {
                    const p: ReviewBundle = { ...current, unfinished: [...current.unfinished, gap('Coverage or existing fact context omitted by bundle byte budget', range)] };
                    if (Buffer.byteLength(canonical(p)) + 128 <= limits.bundle_bytes)
                        current = p;
                }
            }
            await finish();
            return bundles;
        };
    const prepareWithOutcomes = async (request: PrepareRequest): Promise<PreparationResult> => {
        if (request.max_bundles !== undefined && (!Number.isSafeInteger(request.max_bundles) || request.max_bundles < 1 || request.max_bundles > config.limits.bundles_per_round)) throw new Error('Invalid per-round max_bundles');
        if (request.source !== undefined && (!request.source.trim() || request.kind !== 'daily')) throw new Error('Source filter requires daily review');
        if (request.kind !== 'daily') return { schema_version: 1, bundles: await prepareDaily(request), providers: [] };
        let sources: string[];
        if (request.replay_id) {
            const replay = await store.getSemanticReplay(request.replay_id);
            if (!replay) throw new Error('Unknown semantic replay');
            if (request.source && request.source !== replay.payload.source) throw new Error('Replay source differs from frozen work');
            sources = [replay.payload.source as string];
        } else if (request.source) sources = [request.source];
        else {
            const range = requestRange(request, config);
            sources = [...new Set([...store.reviewProviders(range, request.lane), ...(await store.listCoverage(range)).filter(c => c.lane === request.lane).map(c => c.provider)])];
            if (!sources.length) sources = [...new Set(config.providers.filter(p => p.enabled).map(p => p.provider))];
            if (!sources.length) sources = ['unknown'];
        }
        const maximum = request.max_bundles ?? config.limits.bundles_per_round;
        const queues = new Map<string, ReviewBundle[]>(), providers: PreparationResult['providers'] = [];
        for (const source of sources) {
            try {
                const bundles = await prepareDaily({ ...request, source, max_bundles: maximum }, false);
                queues.set(source, bundles);
                const pendingRange = request.replay_id ? (await store.getSemanticReplay(request.replay_id))!.payload.range as TimeRange : requestRange(request, config);
                const localPending = store.metadataScopeGaps(pendingRange, source).length || store.sourcePendingGaps(pendingRange, source).length;
                providers.push({ schema_version: 1, provider: source, stage: 'prepare', execution_status: localPending || bundles.some(b => b.unfinished.length) ? 'partial' : 'complete', reason: localPending ? 'Local source identity or scope work remains pending' : null, bundle_ids: [] });
            } catch (error: any) {
                if (error?.code?.startsWith('ERR_SQLITE') || error?.code?.startsWith('SQLITE_') || ['ENOSPC', 'EIO', 'EROFS'].includes(error?.code)) throw error;
                providers.push({ schema_version: 1, provider: source, stage: 'prepare', execution_status: 'unavailable', reason: String(error), bundle_ids: [] });
            }
        }
        const bundles: ReviewBundle[] = [];
        const earliest = (bundle: ReviewBundle) => bundle.chunks.flatMap(c => c.events).map(e => e.utc_time.value ?? '9999').sort()[0] ?? '9999';
        // Every pending provider gets a head before the remaining budget follows time.
        const heads = [...queues.entries()].filter(([, q]) => q.length).sort((a, b) => earliest(a[1][0]).localeCompare(earliest(b[1][0])));
        for (const [, queue] of heads) if (bundles.length < maximum) bundles.push(queue.shift()!);
        while (bundles.length < maximum) {
            const pending = [...queues.values()].filter(q => q.length).sort((a, b) => earliest(a[0]).localeCompare(earliest(b[0])));
            if (!pending.length) break;
            bundles.push(pending[0].shift()!);
        }
        for (const bundle of bundles) await store.saveBundle(bundle);
        for (const provider of providers) {
            provider.bundle_ids = bundles.filter(b => b.source === provider.provider).map(b => b.bundle_id);
            if (queues.get(provider.provider)?.length) { provider.execution_status = 'partial'; provider.reason = 'Additional provider material deferred by total round budget'; }
        }
        return { schema_version: 1, bundles, providers };
    };
    return {
        prepareWithOutcomes,
        async prepare(request: PrepareRequest) { return (await prepareWithOutcomes(request)).bundles; },
        async accept(result: ReviewResult) {
            const bundle = await store.getBundle(result.bundle_id);
            if (!bundle)
                throw new Error('Unknown review bundle');
            validateReviewResult(result);
            return store.commitReview(result);
        }
    };
}
