import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { BookkeepingConfig, Reviewer, Store, ReviewBundle, ReviewChunk, SourceEvent, PrepareRequest, ReviewResult, TimeRange, CoverageGap, PageBaseline, PreparationResult, CandidatePreparation, PreparationScope, DeferredReviewUnit, ReviewUnit } from '../contracts/types.ts';
import { SqliteStore, canonical, digest } from '../store/index.ts';
import { validateReviewResult, validateContextFactRefs, utc, date } from '../contracts/validation.ts';
import { prepareWeeklyBundle, prepareMonthlyBundle } from './analysis.ts';
import { readPageBaseline } from './baselines.ts';
import { prepareJournalWork } from './journal.ts';
import { storageFailureCode } from '../storage-errors.ts';
import { loadPreparationCursor, savePreparationCursor, type EventPosition } from '../store/preparation.ts';
import { exactReviewUnit } from '../store/unit-dispositions.ts';
const selectionBasis = (request:PrepareRequest) => request.selection_basis ?? (request.range || request.period ? 'capture_lane' : 'event_time');
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
    else if (request.kind === 'daily') {
        const boundary = new Date(Math.max(Date.parse(config.live_start), Date.parse(request.cutoff) - 48 * 3600000)).toISOString();
        from = request.lane === 'live' ? boundary : '0001-01-01T00:00:00.000Z';
        if (request.lane === 'history') to = boundary;
    }
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
    for (const span of [...reviewedSpans].sort((a,b) => a.start_byte-b.start_byte || a.end_byte-b.end_byte)) {
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
    const prepareDaily = async (request: PrepareRequest, persist = true, candidate?:{value?:CandidatePreparation;partial?:boolean}): Promise<ReviewBundle[]> => {
            const started = performance.now();
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
            const scope:PreparationScope = {schema_version:1,source:request.source!,lane:request.lane,range,cutoff:request.cutoff,selection_basis:selectionBasis(request)};
            if(request.context_fact_refs!==undefined)validateContextFactRefs(request.context_fact_refs);
            const explicitFacts=store.getExplicitReviewFacts(request.context_fact_refs??[],request.cutoff);
            const configDigest = digest(canonical({completion_policy:'primary_spans_v1',config,kind:request.kind,max_bundles:request.max_bundles,page_paths:request.page_paths,context_fact_refs:request.context_fact_refs}));
            const cursor = loadPreparationCursor(store.db,request.candidate_continuation,scope,configDigest,request.skip_units);
            const inputFrontier=digest(canonical(cursor));
            const stages:import('../contracts/types.ts').PreparationStageProgress[]=[];
            if(cursor.pending?.bundle_ids?.length) {
                const unaccepted=[] as ReviewBundle[];
                // Inspect identities and slice bounds before opening saved material. Explicit
                // active deferral must release its head while retaining unskipped peers.
                const activeIds=[] as string[];
                for(const id of cursor.pending.bundle_ids)if(!await store.acceptedReviewIdentity(id))activeIds.push(id);
                const skippedActive=activeIds.some(id=>(store.db.prepare(`SELECT COALESCE(json_extract(e.value,'$.context.review_slice.source_event_id'),json_extract(e.value,'$.event_id')) AS source_id,json_extract(e.value,'$.context.review_slice.start_byte') AS start_byte,json_extract(e.value,'$.context.review_slice.end_byte') AS end_byte FROM bundles b,json_each(b.json,'$.chunks') c,json_each(c.value,'$.events') e WHERE b.id=?`).all(id) as any[]).some(unit=>(request.skip_units??[]).some(skip=>skip.event_id===unit.source_id&&(unit.start_byte===null||skip.start_byte<unit.end_byte&&skip.end_byte>unit.start_byte||skip.start_byte===skip.end_byte&&skip.start_byte===unit.start_byte))));
                if(!skippedActive)for(const id of activeIds){const bundle=await store.getBundle(id);if(bundle){if(bundle.review_requirements?.completion_policy!=='primary_spans_v1')throw new Error('Unaccepted daily material requires fresh primary-span preparation');unaccepted.push(bundle);}}
                if(unaccepted.length) {
                    if(candidate)candidate.value={schema_version:1,state:'ready',scope,continuation:savePreparationCursor(store.db,scope,configDigest,cursor),scanned:{pages:0,rows:0,elapsed_ms:Math.ceil(performance.now()-started)},deferred_units:[],progress:{schema_version:1,phase:'bundle',frontier:inputFrontier,advanced:false,stages:[]}};
                    return unaccepted;
                }
                delete cursor.pending;
            }
            const skipped = [...(request.skip_units ?? []),...cursor.deferred.map(item=>item.unit)];
            const deferred:DeferredReviewUnit[] = [];
            const positions:EventPosition[] = [];
            const events:SourceEvent[] = [];
            let pages=0,rows=0,exhausted=false,after=cursor.after;
            const checkpoint=():ReviewBundle[]=>{
                const frontier=digest(canonical(cursor));
                if(candidate)candidate.value={schema_version:1,state:'more',scope,continuation:savePreparationCursor(store.db,scope,configDigest,{...cursor,deferred:[...cursor.deferred,...deferred],skip_units:request.skip_units??[]}),scanned:{pages,rows,elapsed_ms:Math.ceil(performance.now()-started)},deferred_units:deferred,progress:{schema_version:1,phase:cursor.pending?.phase??'candidates',frontier,advanced:frontier!==inputFrontier,stages}};
                return [];
            };
            if (replayWork) events.push(...store.getReplayEvents(replayWork.work_id,limits.chunk_events*limits.bundles_per_round*4,request.skip_units));
            else if(cursor.pending) {events.push(...store.getSelectedReviewEvents(cursor.pending.event_ids));positions.push(...cursor.pending.positions);exhausted=cursor.pending.exhausted;}
            else while (pages < 5 && performance.now()-started < 5000) {
                const stageStart=performance.now(),page=store.getReviewCandidatePage({range,source:request.source,lane:scope.selection_basis==='capture_lane'?request.lane:undefined,limit:320},request.kind,skipped,after ?? undefined);
                stages.push({schema_version:1,phase:'candidates',rows:page.rows,elapsed_ms:Math.ceil(performance.now()-stageStart)});
                pages++;rows+=page.rows;
                const accessible=page.events.filter(event=>{
                    if(Buffer.byteLength(canonical({...event,body:''}))+1536<=limits.bundle_bytes)return true;
                    deferred.push({schema_version:1,unit:exactReviewUnit(event),reason:'Event metadata cannot fit bundle budget'});return false;
                });
                const selected=accessible.slice(0,limits.chunk_events*limits.bundles_per_round);
                const end=selected.length?page.positions.findIndex(position=>position.id===selected.at(-1)!.event_id)+1:page.positions.length;
                positions.push(...page.positions.slice(0,end));events.push(...selected);
                exhausted=page.exhausted;after=page.last ?? after;
                if(selected.length) {exhausted=exhausted&&selected.length===page.events.length;cursor.pending={positions:[...positions],event_ids:selected.map(event=>event.event_id),exhausted,phase:'facts'};break;}
                cursor.after=after;
                if(exhausted) break;
            }
            if(!replayWork && performance.now()-started>=5000)return checkpoint();
            const marks=store.getReviewMarks(progressKind,progressLane,events.map(event=>event.event_id)),reviewed=marks.units;
            const unitRef=(unit:SourceEvent):ReviewUnit => {
                const slice=unit.context.review_slice as ReviewUnit & {source_event_id:string}|undefined;
                return slice ? {schema_version:1,event_id:slice.source_event_id,start_byte:slice.start_byte,end_byte:slice.end_byte} : {schema_version:1,event_id:unit.event_id,start_byte:0,end_byte:Buffer.byteLength(unit.body ?? '')};
            };
            const deferChunk=(chunk:ReviewChunk,reason:string) => {
                for(const unit of chunk.events) deferred.push({schema_version:1,unit:unitRef(unit),reason});
                unfinished.push(gap(reason,range,chunk.events[0]?.locator ?? null));
            };
            const sourceRemaining=(event:SourceEvent):boolean => {
                if(reviewed.has(event.event_id))return false;
                const spans=[...(marks.spans.get(event.event_id)??[]),...skipped.filter(unit=>unit.event_id===event.event_id),...deferred.filter(item=>item.unit.event_id===event.event_id).map(item=>item.unit)].sort((a,b)=>a.start_byte-b.start_byte || a.end_byte-b.end_byte);
                let frontier=0;for(const span of spans){if(span.start_byte>frontier)break;frontier=Math.max(frontier,span.end_byte);}
                return !spans.length || frontier<Buffer.byteLength(event.body ?? '');
            };
            let effectiveFacts:import('../contracts/types.ts').FactRevision[];
            if(replayWork)effectiveFacts=store.getReplayFacts(replayWork.work_id,events);
            else if(cursor.pending?.fact_refs)effectiveFacts=store.lookupFactRevisions(cursor.pending.fact_refs);
            else {
                const stageStart=performance.now(),selected=store.getScopedReviewFacts(events,request.cutoff);effectiveFacts=selected.facts;
                stages.push({schema_version:1,phase:'facts',rows:selected.facts.length,elapsed_ms:Math.ceil(performance.now()-stageStart)});
                if(cursor.pending){cursor.pending.fact_refs=selected.facts.map(fact=>({schema_version:1,fact_id:fact.fact_id,revision:fact.revision}));cursor.pending.facts_omitted=selected.omitted;cursor.pending.phase='coverage';}
            }
            if(!replayWork && performance.now()-started>=5000)return checkpoint();
            const scopedFacts = store.filterReviewFacts([...new Map([...explicitFacts,...effectiveFacts].map(fact=>[fact.fact_id+':'+fact.revision,fact])).values()]);
            const facts = request.kind === 'daily' ? scopedFacts : effectiveFacts.flatMap(f => {
                const projection = f.analytics_projection?.value;
                if (!projection)
                    return [];
                return [{ ...f, content: projection.summary, scope: projection.scope, subject: projection.subject, event_refs: projection.event_refs, attribution: projection.attribution }];
            });
            const coverageStarted=performance.now(),coverageCached=cursor.pending?.coverage_ids!==undefined;
            const coverage = (cursor.pending?.coverage_ids ? cursor.pending.coverage_ids.flatMap(id=>{const row=store.db.prepare('SELECT json FROM coverage WHERE id=?').get(id);return row?[JSON.parse(row.json as string) as import('../contracts/types.ts').SourceCoverage]:[];}) : await store.listReviewCoverage(events,range,request.source,request.lane)).filter(c => c.conversation_id === null || store.reviewScope.allowed(c.provider, c.account_id, c.conversation_id, undefined));
            if(cursor.pending){cursor.pending.coverage_ids=coverage.map(item=>item.coverage_id);cursor.pending.phase='baselines';}
            if(!coverageCached)stages.push({schema_version:1,phase:'coverage',rows:coverage.length,elapsed_ms:Math.ceil(performance.now()-coverageStarted)});
            if(!replayWork && performance.now()-started>=5000)return checkpoint();
            const unfinished = coverage.flatMap(c => c.gaps);
            if(events.length)unfinished.push(gap('Bounded preparation metadata omitted: fact context is limited to selected units and adjacent dates; coverage is limited to selected conversations and 64 records. This does not certify all related context',range));
            unfinished.push(...deferred.map(item=>gap(item.reason,range,item.unit.event_id)));
            if(cursor.pending?.facts_omitted)unfinished.push(gap('Related fact context exceeds bounded 320-revision page; omitted context remains unknown',range));
            if(coverage.some(item=>item.capture_status!=='complete'))unfinished.push(gap('Capture coverage remains partial or unknown',range));
            const selectedIds=events.map(event=>event.event_id);
            const cachedGaps=(key:string,load:()=>CoverageGap[]):CoverageGap[]=>{
                const old=cursor.pending?.gap_results?.[key];if(old!==undefined)return old;
                const stageStart=performance.now(),value=load();
                if(cursor.pending){cursor.pending.gap_results??={};cursor.pending.gap_results[key]=value;}
                stages.push({schema_version:1,phase:'coverage',rows:value.length,elapsed_ms:Math.ceil(performance.now()-stageStart)});
                return value;
            };
            const diagnosticQueries:[string,()=>CoverageGap[]][]=[
                ['exact_read_exclusions',()=>store.reviewReadExclusions(range,request.source).filter(item=>item.unreviewed).map(item=>gap('Source event read excluded; retained unreviewed: '+item.reason,range,item.event_id))],
                ['classification_scope',()=>!request.source||request.source==='codex'?store.getClassificationGaps(range).map(item=>gap(item.reason,null,item.locator)):[]],
                ['source_pending_scope',()=>store.sourcePendingGaps(range,request.source).map(item=>gap(item.reason,null,item.locator))],
                ['scope',()=>request.source?store.metadataScopeGaps(range,request.source,selectedIds).map(item=>gap(item.reason,null,item.locator)):[]]
            ];
            for(const [key,load]of diagnosticQueries){
                if(!replayWork&&performance.now()-started>=5000)return checkpoint();
                unfinished.push(...cachedGaps(key,load));
                if(!replayWork&&performance.now()-started>=5000)return checkpoint();
            }
            if(events.length)unfinished.push(gap('Known exclusion and bounded scope debt metadata is included; unselected source range was not scanned as review material and remains unknown',range));
            if (request.source === 'wechat') unfinished.push(...store.reviewScope.registryGaps().map(reason => gap(reason, range)));
            if (replayWork) unfinished.push(gap('Explicit semantic replay; only this work’s actual event slices are completed, capture coverage remains independent', range));
            const requestedBaselines: PageBaseline[] = [];
            const cachedBaseline=async(path:string,maxBytes?:number):Promise<PageBaseline>=>{
                const old=cursor.pending?.baselines?.find(page=>page.path===path);if(old)return old;
                const stageStart=performance.now(),page=await readPageBaseline(config,path,maxBytes);
                stages.push({schema_version:1,phase:'baselines',rows:1,elapsed_ms:Math.ceil(performance.now()-stageStart)});
                if(cursor.pending){cursor.pending.baselines??=[];cursor.pending.baselines.push(page);}
                return page;
            };
            if (request.page_paths && (!Array.isArray(request.page_paths) || request.page_paths.some(path => typeof path !== 'string')))
                throw new Error('page_paths must be an array of explicit Wiki paths');
            for (const path of (request.page_paths ?? []).slice(0, 16)) {
                try {
                    if(!replayWork&&performance.now()-started>=5000)return checkpoint();
                    const page = await cachedBaseline(path, Math.max(64, Math.floor(limits.bundle_bytes / 8)));
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
            const primaryPaths=new Set(events.map(event=>targetPath('daily',event,config,request.cutoff)));
            const factDates=[...new Set(facts.flatMap(fact=>fact.journal_date.value?[fact.journal_date.value]:[]))];
            const resolvedPaths:string[]=[];
            for(const date of factDates){
                let path=cursor.pending?.journal_paths?.[date];
                if(path===undefined){
                    if(!replayWork&&performance.now()-started>=5000)return checkpoint();
                    const stageStart=performance.now();path=store.resolveJournalPath(date,request.cutoff,config.journal_timezone);
                    if(cursor.pending){cursor.pending.journal_paths??={};cursor.pending.journal_paths[date]=path;}
                    stages.push({schema_version:1,phase:'baselines',rows:1,elapsed_ms:Math.ceil(performance.now()-stageStart)});
                    if(!replayWork&&performance.now()-started>=5000)return checkpoint();
                }
                resolvedPaths.push(path);
            }
            const oldPaths=[...new Set(resolvedPaths)].filter(path=>!primaryPaths.has(path)&&!requestedBaselines.some(page=>page.path===path));
            for(const path of oldPaths.slice(0,4)) {
                if(!replayWork&&performance.now()-started>=5000)return checkpoint();
                try {const page=await cachedBaseline(path,Math.max(64,Math.floor(limits.bundle_bytes/16)));requestedBaselines.push(page);if(page.context_excerpt)unfinished.push(gap('Related old-date baseline is excerpted: '+page.excerpt_reason,null,path));}
                catch(error){unfinished.push(gap('Related old-date baseline unavailable: '+String(error),null,path));}
            }
            if(oldPaths.length>4)unfinished.push(gap('Related old-date baselines omitted after bounded four-page context allowance; semantic comparison remains partial',range));
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
                const cachedContexts=cursor.pending?.contexts?.[first.event_id];
                const contexts=cachedContexts?store.getSelectedReviewEvents(cachedContexts):store.getContextEvents(first,request.cutoff);
                if(cursor.pending){cursor.pending.contexts??={};cursor.pending.contexts[first.event_id]=contexts.map(context=>context.event_id);}
                for (const context of contexts) {
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
                const chunk: ReviewChunk = { schema_version: 1, chunk_id: 'chunk:' + digest(canonical([request.kind, request.lane, ...(replayWork ? [replayWork.work_id] : []), 'review-primary-spans-v1', pending, contextEvents])), events: pending, context_events: contextEvents, body_bytes: bodyBytes };
                chunks.push(chunk);
                pending = [];
                bodyBytes = 0;
            };
            // Reserve room for baselines, coverage and existing facts rather than filling the round with body bytes alone.
            const units = function* () {
                for (const event of events)
                    for (const unit of slices(event, limits.chunk_body_bytes, [...(marks.spans.get(event.event_id)??[]), ...skipped.filter(unit => unit.event_id === event.event_id)]))
                        if (!reviewed.has(unit.event_id))
                            yield unit;
            };
            for (const unit of units()) {
                if (!replayWork && performance.now()-started >= 5000) {exhausted=false;break;}
                // stop_reason describes assistant generation, not whether a captured human input is complete.
                // Keep the independent explicit incomplete-input marker authoritative for every role.
                if ((unit.role !== 'user' && unit.context.turn_complete === false) || unit.context.incomplete_turn === true) {
                    unfinished.push(gap('Incomplete source turn requires subsequent context', null, unit.locator));
                    continue;
                }
                const bytes = Buffer.byteLength(unit.body ?? '');
                if (pending.length && (pending.length >= limits.chunk_events || bodyBytes + bytes > limits.chunk_body_bytes || Buffer.byteLength(canonical([...pending, unit])) > Math.floor(limits.bundle_bytes / 2) || pending[0].journal_date.value !== unit.journal_date.value))
                    flush();
                if(replayWork && chunks.length>=limits.bundles_per_round){unfinished.push(gap('Unprepared event slices remain',range,unit.locator));break;}
                pending.push(unit);
                bodyBytes += bytes;
                if(chunks.length>=limits.bundles_per_round*2)break;
            }
            flush();
            if(!replayWork&&performance.now()-started>=5000)return checkpoint();
            if (!chunks.length) {
                if (!replayWork && !request.page_paths?.length) {
                    // A deadline can leave selected rows unprocessed. Advance
                    // only the reclassified prefix before the first such row.
                    let safeAfter=cursor.after;
                    const retained=new Set(events.filter(sourceRemaining).map(event=>event.event_id));
                    for(const position of positions){if(retained.has(position.id))break;safeAfter=position;}
                    const state=exhausted&&!retained.size?'exhausted':'more';
                    const value={after:safeAfter,deferred:[...cursor.deferred,...deferred],skip_units:request.skip_units??[]},frontier=digest(canonical(value));
                    if(candidate) candidate.value={schema_version:1,state,scope,continuation:state==='exhausted'?null:savePreparationCursor(store.db,scope,configDigest,value),scanned:{pages,rows,elapsed_ms:Math.ceil(performance.now()-started)},deferred_units:deferred,progress:{schema_version:1,phase:'candidates',frontier,advanced:frontier!==inputFrontier,stages}};
                    if(candidate)candidate.partial=unfinished.length>0;
                    return [];
                }
                // Empty material is an explicit review decision; missing capture remains pending even if zero-facts is accepted.
                const id = (request.page_paths?.length ? 'pages:' : 'empty:') + digest(canonical([request.kind, request.lane, request.source, ...(replayWork ? [replayWork.work_id] : []), range, coverage.map(c => ({ ...c, review_status: null })), facts, requestedBaselines]));
                if (reviewed.has(id))
                    return [];
                chunks.push({ schema_version: 1, chunk_id: id, events: [], context_events: [], body_bytes: 0 });
            }
            const bundles: ReviewBundle[] = [];
            let current: ReviewBundle | null = null;
            const omittedMarker = 'Bounded preparation metadata omitted';
                const initial = (): ReviewBundle => ({ schema_version: 1, review_requirements:{schema_version:1,unit_dispositions:true,inspection_version:2,completion_policy:'primary_spans_v1'}, bundle_id: '', source: request.source, kind: request.kind, lane: request.lane, period: request.period ?? null, cutoff: request.cutoff, ...(request.kind === 'daily' && (request.range !== undefined || request.period !== undefined || Date.parse(range.to) - Date.parse(range.from) <= 32 * 86400000) ? { review_range: range, review_timezone: [...config.journal_timezone_timeline].filter(entry => Date.parse(entry.effective_from) <= Date.parse(request.period ? request.period + 'T12:00:00Z' : range.from)).sort((a, b) => Date.parse(a.effective_from) - Date.parse(b.effective_from)).at(-1)?.timezone ?? config.journal_timezone } : {}), chunks: [], existing_facts: [], baselines: [], coverage: [], unfinished: [gap(omittedMarker, range)],
                ...(replayWork ? { replay: { schema_version: 1 as const, work_id: replayWork.work_id, source: replayWork.payload.source as string, range } } : {}) });
            const finish = async () => {
                if (!current?.chunks.length) {
                    current=null;
                    return;
                }
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
                if (!replayWork && performance.now()-started >= 5000) {exhausted=false;break;}
                if (bundles.length >= limits.bundles_per_round)
                    break;
                if (!current)
                    current = initial();
                const path = targetPath(request.kind, chunk.events[0], config, request.cutoff, request.period);
                let base: PageBaseline | undefined;
                try {
                    base = await cachedBaseline(path);
                }
                catch (error: any) {
                    if (!current.unfinished.some(g => g.locator === path))
                        current.unfinished.push(gap(error.message, null, path));
                }
                const proposed: ReviewBundle = { ...current, chunks: [...current.chunks, chunk], baselines: base && !current.baselines.some(b => b.path === path) ? [...current.baselines, base] : current.baselines };
                if (Buffer.byteLength(canonical(proposed)) + 1024 > limits.bundle_bytes) {
                    if (!current.chunks.length) {
                        deferChunk(chunk,'Event metadata cannot fit bundle budget');
                        current=null;
                        continue;
                    }
                    await finish();
                    if (bundles.length >= limits.bundles_per_round)
                        break;
                    current = { ...initial(), chunks: [chunk], baselines: base ? [base] : [] };
                    if (Buffer.byteLength(canonical(current)) + 1024 > limits.bundle_bytes) {
                        deferChunk(chunk,'Event metadata cannot fit bundle budget');
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
            if(!replayWork&&performance.now()-started>=5000)return checkpoint();
            await finish();
            if(candidate && !replayWork) {
                const remaining = new Set(events.filter(sourceRemaining).map(event=>event.event_id));
                let safeAfter=cursor.after;
                for(const position of positions) {if(remaining.has(position.id))break;safeAfter=position;}
                const nextDeferred=[...cursor.deferred,...deferred].filter(item=>!safeAfter || !positions.some(position=>position.id===item.unit.event_id && (position.time<safeAfter.time || position.time===safeAfter.time && (position.ordering<safeAfter.ordering || position.ordering===safeAfter.ordering && position.id<=safeAfter.id))));
                const state=bundles.length?'ready':exhausted?'exhausted':'more';
                const value={after:safeAfter,deferred:nextDeferred,skip_units:request.skip_units ?? [],...(bundles.length&&cursor.pending?{pending:{...cursor.pending,phase:'bundle' as const,bundle_ids:bundles.map(bundle=>bundle.bundle_id)}}:{})};
                const frontier=digest(canonical(value));
                candidate.value={schema_version:1,state,scope,continuation:state==='exhausted'?null:savePreparationCursor(store.db,scope,configDigest,value),scanned:{pages,rows,elapsed_ms:Math.ceil(performance.now()-started)},deferred_units:deferred,progress:{schema_version:1,phase:bundles.length?'bundle':cursor.pending?.phase??'candidates',frontier,advanced:frontier!==inputFrontier,stages}};
                candidate.partial=unfinished.length>0;
            }
            return bundles;
        };
    const prepareWithOutcomes = async (request: PrepareRequest): Promise<PreparationResult> => {
        if (request.work_only!==undefined && typeof request.work_only!=='boolean') throw new Error('Invalid work_only flag');
        if (request.work_only && request.kind!=='monthly') throw new Error('work_only requires monthly preparation');
        if (request.work_only && (request.skip_units?.length || request.source || request.candidate_continuation || request.range || request.replay_id)) throw new Error('work_only cannot request source/context material');
        if(request.context_fact_refs!==undefined && request.kind!=='daily')throw new Error('Explicit fact context requires daily preparation');
        store.validateSkipUnits(request.skip_units);
        if(request.selection_basis!==undefined && !['event_time','capture_lane'].includes(request.selection_basis)) throw new Error('Invalid review selection basis');
        if(request.candidate_continuation && (request.kind!=='daily' || request.replay_id || !request.source)) throw new Error('Preparation continuation requires explicit daily source and cannot combine replay');
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
            sources = [...new Set([...store.reviewProviders(range, selectionBasis(request)==='capture_lane'?request.lane:undefined), ...(await store.listCoverage(range)).filter(c => c.lane === request.lane).map(c => c.provider)])];
            if (!sources.length) sources = [...new Set(config.providers.filter(p => p.enabled).map(p => p.provider))];
            if (!sources.length) sources = ['unknown'];
        }
        const maximum = request.max_bundles ?? config.limits.bundles_per_round;
        const queues = new Map<string, ReviewBundle[]>(), providers: PreparationResult['providers'] = [];
        for (const source of sources) {
            try {
                const candidate:{value?:CandidatePreparation;partial?:boolean}={};
                const bundles = await prepareDaily({ ...request, source, max_bundles: maximum }, false,candidate);
                queues.set(source, bundles);
                const pendingRange = request.replay_id ? (await store.getSemanticReplay(request.replay_id))!.payload.range as TimeRange : requestRange(request, config);
                const boundedDiagnostic=candidate.value?.state==='more'||bundles.some(bundle=>bundle.chunks.some(chunk=>chunk.events.length>0));
                const readExcluded = boundedDiagnostic?bundles.some(bundle=>bundle.unfinished.some(item=>item.reason.startsWith('Source event read excluded;'))):store.reviewReadExclusions(pendingRange, source).some(item => item.unreviewed);
                const localPending = boundedDiagnostic || readExcluded || store.metadataScopeGaps(pendingRange, source).length || store.sourcePendingGaps(pendingRange, source).length;
                providers.push({ schema_version: 1, provider: source, stage: 'prepare', execution_status: localPending || candidate.partial || candidate.value?.state==='more' || candidate.value?.deferred_units.length || bundles.some(b => b.unfinished.length) ? 'partial' : 'complete', reason: readExcluded ? 'Exact source event read exclusion retains unreviewed debt' : boundedDiagnostic ? 'Bounded preparation retains unscanned source range as unknown' : localPending ? 'Local source identity or scope work remains pending' : candidate.value?.state==='more' ? 'Bounded candidate scan continuation remains' : candidate.value?.deferred_units.length ? 'Oversized source units deferred; retained unreviewed' : candidate.partial?'Capture or material gaps retain pending debt':null, bundle_ids: [],...(candidate.value?{preparation:candidate.value}:{}) });
            } catch (error: any) {
                if (storageFailureCode(error,'source_read')) throw error;
                if(error?.code==='BOOKKEEPING_PREPARATION_CURSOR_INVALID') throw error;
                const scope:PreparationScope={schema_version:1,source,lane:request.lane,range:request.replay_id?(await store.getSemanticReplay(request.replay_id))!.payload.range as TimeRange:requestRange(request,config),cutoff:request.cutoff,selection_basis:selectionBasis(request)};
                providers.push({ schema_version: 1, provider: source, stage: 'prepare', execution_status: 'unavailable', reason: String(error), bundle_ids: [],preparation:{schema_version:1,state:'unavailable',scope,continuation:null,scanned:{pages:0,rows:0,elapsed_ms:0},deferred_units:[]} });
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
        prepareJournalWork: request => prepareJournalWork(store,config,request),
        prepareWithOutcomes,
        async prepare(request: PrepareRequest) { return (await prepareWithOutcomes(request)).bundles; },
        async accept(result: ReviewResult) {
            validateReviewResult(result);
            return store.commitReview(result);
        }
    };
}
