import type { DatabaseSync } from 'node:sqlite';
import type { ReviewResult, ReviewCommit, ReviewBundle, FactRevision, FactRef, JournalPatch, SourceEvent, Lane, SourceCoverage, WorkItem, FactArtifact } from '../contracts/types.ts';
import { validateReviewResult } from '../contracts/validation.ts';
import { accumulateMonthly, accumulateWeekly, type SemanticPage } from '../analytics/pages.ts';
import { validateAnalysisAgainstInput } from '../analytics/validation.ts';
import { canonical, digest } from '../analytics/serialization.ts';
import { utc, normalized, rangeCheck, version, unique, refKey, factWeek, weekFor } from './domain.ts';
import type { AnalyticsRepository } from './analytics.ts';
import type { SemanticReplayRepository } from './replay.ts';
import { queueAcceptedJournalWork } from './journal.ts';
import { monthlyChunksCompleteSql, factMaterialProgress, completeMonthlyConclusion, assertCurrentMonthlyConclusion } from './monthly-status.ts';
import { validateUnitDispositions,unreadMedia,evidenceEvent,eventForSpan,exactReviewUnit,overlaps } from './unit-dispositions.ts';
interface SemanticStore {
    db: DatabaseSync;
    options: {
        onTransactionStep?: (step: string) => void;
        now?: () => Date;
    };
    journalTimezone: string;
    transaction<T>(operation: () => T): T;
    effective(): FactRevision[];
    allocateId(namespace: string): string;
    putWork(item: WorkItem): void;
    markUnit(event: SourceEvent, kind: string, lane: Lane): void;
    coverageReview(coverage: SourceCoverage, kind: string, explicitEmpty: boolean): SourceCoverage;
    analyticsHistoryRepository(): AnalyticsRepository;
    markFactMaterialRead(id: string, refs: FactRef[]): void;
    replayRepository(): SemanticReplayRepository;
    markReplayUnit(event: SourceEvent, workId: string): void;
    sourceAllowed(event: SourceEvent): boolean;
    assertReviewBundleReadable(id: string): void;
    currentJournalPresentPaths?: Set<string>;
    wikiLockHeld?: boolean;
}
const parse = <T>(row: any): T => JSON.parse(row.json);
export async function commitSemanticReview(store: SemanticStore, result: ReviewResult): Promise<ReviewCommit> {
    version(result);
    utc(result.created_at);
    return store.transaction(() => {
        const content = canonical({ ...result, result_id: null, created_at: null });
        const old = store.db.prepare('SELECT content,commit_json FROM results WHERE bundle_id=? OR id=?').get(result.bundle_id, result.result_id) as any;
        if (old) {
            if (old.content !== content)
                throw new Error('Review result/bundle identity conflict');
            return { ...JSON.parse(old.commit_json), reused: true };
        }
        store.assertReviewBundleReadable(result.bundle_id);
        const row = store.db.prepare('SELECT json FROM bundles WHERE id=?').get(result.bundle_id);
        if (!row)
            throw new Error('Unknown review bundle');
        const bundle = parse<ReviewBundle>(row);
        if (result.source !== undefined && result.source !== bundle.source) throw new Error('Review result source differs from its prepared bundle');
        const providers = new Set(bundle.chunks.flatMap(chunk => [...chunk.events, ...chunk.context_events]).map(event => event.source.provider));

        if (bundle.source === 'wechat' || providers.has('wechat')) store.replayRepository().validateSource();
        if (bundle.replay) {
            if (bundle.kind !== 'daily') throw new Error('Semantic replay requires daily original event material');
            store.replayRepository().validate(bundle.replay, bundle.cutoff);
            for (const event of bundle.chunks.flatMap(chunk => chunk.events)) {
                const sourceId = (event.context.review_slice as any)?.source_event_id ?? event.event_id;
                if (!store.replayRepository().contains(bundle.replay.work_id, sourceId))
                    throw new Error('Replay event outside frozen source scope');
            }
        }
        if (bundle.kind === 'daily' && (providers.size > 1 || (bundle.source && [...providers].some(provider => provider !== bundle.source))))
            throw new Error('Daily bundle must contain one provider; prepare a fresh bundle');
        for (const event of bundle.chunks.flatMap(chunk => [...chunk.events, ...chunk.context_events])) {
            const id = (event.context.review_slice as any)?.source_event_id ?? event.event_id;
            if (!store.sourceAllowed(event)) throw new Error('Prepared WeChat source scope changed; prepare a fresh bundle');
            const current = store.db.prepare('SELECT classification,json FROM events WHERE id=?').get(id) as any;
            if (current && !store.sourceAllowed(JSON.parse(current.json))) throw new Error('Prepared WeChat source scope changed; prepare a fresh bundle');

            if (current && current.classification !== 'main')
                throw new Error('Prepared source classification changed; prepare a fresh bundle');
        }
        validateReviewResult(result);
        const primarySpans=validateUnitDispositions(bundle,result,store.db);
        const dispositionHeld=primarySpans.held;
        const completedSemantic = result.chunks.some(chunk => chunk.status === 'complete');
        const completeMonthlyMaterial = bundle.chunks.length > 0 && bundle.chunks.every(chunk => result.chunks.some(review => review.chunk_id === chunk.chunk_id && review.status === 'complete'));
        let priorWorkConclusion:import('../contracts/types.ts').MonthlyReviewResult|null=null;
        if (bundle.monthly_context?.work_only) {
            const context=bundle.monthly_context,page=context.facts_page;
            const snapshot=page && store.db.prepare("SELECT json_extract(json,'$.kind') AS kind,json_extract(json,'$.period') AS period,json_extract(json,'$.cutoff') AS cutoff FROM fact_material_snapshots WHERE id=?").get(page.snapshot_id) as {kind:string;period:string;cutoff:string}|undefined;
            const proof=page && factMaterialProgress(store.db,page.snapshot_id);
            if (!page || !snapshot || snapshot.kind!=='monthly' || snapshot.period!==context.month || snapshot.period!==bundle.period || snapshot.cutoff!==bundle.cutoff || page.cutoff!==snapshot.cutoff || !proof || page.total!==proof.total || page.offset!==proof.total || proof.first_unread_offset!==null || proof.pending_archive_context_count!==0)
                throw new Error('Work-only monthly scope requires exact completed frozen facts and no pending archive context');
            if (context.facts.length || context.manual_baselines.length || context.archive_contexts?.length || context.archive_context_page || bundle.existing_facts.length || bundle.baselines.length || bundle.chunks.some(chunk=>chunk.events.length||chunk.context_events.length) || result.candidates.length || result.pages.length || !result.monthly_review)
                throw new Error('Work-only monthly cannot introduce facts, source/page/archive material or new semantic candidates');
            if (!context.prepared_work_ids?.length || context.prepared_work_ids.length>32 || new Set(context.prepared_work_ids).size!==context.prepared_work_ids.length) throw new Error('Work-only monthly requires one bounded unique frozen work page');
            for (const id of context.prepared_work_ids??[]) if (!store.db.prepare("SELECT 1 FROM fact_material_snapshots s,json_each(s.json,'$.work_ids') frozen WHERE s.id=? AND frozen.value=?").get(page.snapshot_id,id)) throw new Error('Work-only prepared ID outside original frozen snapshot');
            assertCurrentMonthlyConclusion(store.db,page.snapshot_id);
            priorWorkConclusion=completeMonthlyConclusion(store.db,page.snapshot_id);
            if (!priorWorkConclusion) throw new Error('Work-only monthly requires prior accepted complete conclusion');
        }
        if (bundle.analysis_context && completedSemantic && !result.analysis)
            throw new Error('Completed weekly review requires typed analysis');
        if (bundle.monthly_context && completedSemantic && !result.monthly_review)
            throw new Error('Completed monthly review requires typed monthly_review');
        if (result.analysis) {
            if (bundle.kind !== 'weekly' || !bundle.analysis_context)
                throw new Error('Weekly analysis requires a prepared analysis_context');
            validateAnalysisAgainstInput(result.analysis, bundle.analysis_context);
        }
        if (result.monthly_review) {
            const review = result.monthly_review;
            const context = bundle.monthly_context;
            if (bundle.kind !== 'monthly' || !context)
                throw new Error('Monthly review requires a prepared monthly_context');
            version(review);
            if (review.month !== context.month || typeof review.summary !== 'string' || !review.summary.trim() || typeof review.supplement_text !== 'string' || !['complete', 'partial', 'unknown'].includes(review.coverage_status))
                throw new Error('Invalid monthly review');
            if (context.coverage_status !== 'complete' && review.coverage_status === 'complete')
                throw new Error('Monthly review cannot upgrade incomplete coverage');
            if (!Array.isArray(review.fact_refs) || review.fact_refs.some(ref => !context.facts.some(fact => refKey(fact) === refKey(ref))))
                throw new Error('Monthly review references facts outside prepared context');
            if (!completeMonthlyMaterial && ((review.completed_work_ids?.length ?? 0) || (review.completed_archive_context_ids?.length ?? 0)))
                throw new Error('Monthly work completion requires every prepared semantic chunk explicitly complete');
            if (review.completed_work_ids) {
                unique(review.completed_work_ids, 'completed monthly work IDs');
                if (review.completed_work_ids.some(id => !context.prepared_work_ids?.includes(id)))
                    throw new Error('Completed monthly work ID outside prepared context');
            }
            if (review.completed_archive_context_ids) {
                unique(review.completed_archive_context_ids, 'completed archive context IDs');
                if (review.completed_archive_context_ids.some(id => !context.archive_contexts?.some(item => item.work_id === id && item.excerpt_reason === null)))
                    throw new Error('Completed archive context must be fully displayed in this prepared page');
            }
        }
        unique(result.chunks.map(c => c.chunk_id), 'reviewed chunks');
        unique(result.candidates.map(c => c.candidate_id), 'candidate IDs');
        unique(result.pages.map(p => p.suggestion_id), 'page suggestions');
        const chunks = new Map(bundle.chunks.map(c => [c.chunk_id, c]));
        const reviews = new Map(result.chunks.map(c => [c.chunk_id, c]));
        for (const reviewed of result.chunks) {
            version(reviewed);
            const chunk = chunks.get(reviewed.chunk_id);
            if (!chunk)
                throw new Error('Unknown reviewed chunk');
            unique(reviewed.reviewed_event_ids, 'reviewed events');
            const ids = new Set(chunk.events.map(e => e.event_id));
            if (reviewed.reviewed_event_ids.some(id => !ids.has(id)))
                throw new Error('Reviewed event outside chunk');
            if (reviewed.status === 'complete' && reviewed.reviewed_event_ids.length !== ids.size)
                throw new Error('Complete chunk omits events');
            if (reviewed.status === 'deferred' && reviewed.reviewed_event_ids.length)
                throw new Error('Deferred chunk claims reviewed events');
            const candidates = result.candidates.filter(c => c.chunk_id === reviewed.chunk_id);
            if (reviewed.status === 'complete' && !candidates.length && !reviewed.zero_facts)
                throw new Error('Complete zero-fact review must be explicit');
            if (reviewed.zero_facts && candidates.length)
                throw new Error('zero_facts contradicts candidates');
        }
        const availableTargets = new Set(bundle.existing_facts.map(refKey));
        const liveTargets = new Set(bundle.monthly_context?.work_only ? [] : bundle.kind==='daily'?bundle.existing_facts.filter(fact=>fact.action!=='retract'&&!!store.db.prepare(`SELECT 1 FROM facts f WHERE f.id=? AND f.revision=? AND NOT EXISTS(SELECT 1 FROM facts later WHERE later.id=f.id AND later.revision>f.revision) AND NOT EXISTS(SELECT 1 FROM fact_targets t WHERE t.target_id=f.id AND t.target_revision>=f.revision)`).get(fact.fact_id,fact.revision)).map(refKey):store.effective().map(refKey));
        const failed = new Set<string>();
        for(const chunk of bundle.chunks)if(chunk.events.some(event=>dispositionHeld.has(event.event_id)))failed.add(chunk.chunk_id);
        const finalizedEvents = new Set<string>();
        const facts: FactRevision[] = [];
        const refs = new Map<string, FactRef[]>();
        for (const candidate of result.candidates) {
            version(candidate);
            const chunk = chunks.get(candidate.chunk_id);
            const review = reviews.get(candidate.chunk_id);
            if (!chunk || !review || review.status === 'deferred')
                throw new Error('Candidate outside reviewed chunk');
            const reviewed = new Set(review.reviewed_event_ids);
            const eventMap = new Map(chunk.events.map(e => [e.event_id, e]));
            if(bundle.kind==='daily')for(const ref of candidate.event_refs)eventMap.set(ref.event_id,evidenceEvent(bundle,candidate.chunk_id,ref));
            for(const event of chunk.events) {
                const original=(event.context.review_slice as any)?.source_event_id;
                if(typeof original==='string'&&chunk.events.filter(unit=>(unit.context.review_slice as any)?.source_event_id===original||unit.event_id===original).length===1)eventMap.set(original,event);
            }
            const derivedRefs = new Set(bundle.existing_facts.flatMap(f => f.event_refs.map(canonical)));
            const derived = bundle.kind !== 'daily' && ['inference', 'recommendation'].includes(candidate.kind);
            if (candidate.event_refs.some(ref => !((eventMap.has(ref.event_id) && reviewed.has(eventMap.get(ref.event_id)!.event_id)) || (derived && derivedRefs.has(canonical(ref))))))
                throw new Error('Candidate uses unreviewed/context event');
            if (bundle.kind !== 'daily' && candidate.disposition === 'add' && !derived)
                throw new Error('Weekly/monthly cannot allocate duplicate direct facts');
            if (!candidate.event_refs.length && candidate.disposition === 'add')
                throw new Error('New fact requires event evidence');
            const targetKeys = candidate.target_refs.map(refKey);
            unique(targetKeys, 'target refs');
            if (candidate.disposition === 'add' && targetKeys.length)
                throw new Error('Add cannot replace targets');
            if (candidate.occurred_at.value)
                utc(candidate.occurred_at.value);
            let reason: string | null = null;
            const declaredCorrections=result.journal_dispositions?.filter(decision=>decision.candidate_id===candidate.candidate_id&&decision.baseline_assessment?.relation==='correction')??[];
            // A new assertion may correct only unstructured journal text when no FactRef
            // is supplied and every correction journal target is explicitly deferred.
            // Any fact context remains conservatively unresolved; no same-topic inference.
            if(candidate.disposition==='add'&&declaredCorrections.length&&!(bundle.existing_facts.length===0&&targetKeys.length===0&&declaredCorrections.every(decision=>decision.disposition==='defer')))
                reason='Declared correction cannot be add with supplied fact context or automatic journal closure; repair exact replace/retract refs or explicitly defer the source candidate';
            if(candidate.event_refs.some(ref=>{const event=eventMap.get(ref.event_id);return event&&unreadMedia(event);}))reason='Unread media evidence remains pending; it cannot create a fact or complete a unit';
            const evidenceKind = bundle.replay ? 'replay:' + bundle.replay.work_id : 'daily';
            if (bundle.kind === 'daily' && candidate.disposition === 'add' && candidate.event_refs.some(ref => (store.db.prepare('SELECT start_byte,end_byte FROM reviewed_spans WHERE kind=? AND source_id=?').all(evidenceKind,ref.event_id) as any[]).some(span=>overlaps({...span,schema_version:1,event_id:ref.event_id},{schema_version:1,event_id:ref.event_id,start_byte:ref.start_byte!,end_byte:ref.end_byte!}))))
                reason = 'Evidence already semantically reviewed; prepare again with existing facts';
            if (!candidate.subject.trim() || candidate.attribution?.subject_known === false)
                reason = 'Unknown fact subject';
            if (candidate.disposition !== 'add' && (!targetKeys.length || targetKeys.some(key => !availableTargets.has(key) || !liveTargets.has(key))))
                reason = 'Unresolved or stale target reference';
            if (reason) {
                failed.add(candidate.chunk_id);
                store.putWork({ schema_version: 1, work_id: store.allocateId('work'), kind: 'review_candidate', lane: bundle.lane, state: 'pending', payload: { bundle_id: bundle.bundle_id, candidate }, reason, migration_key: null, updated_at: result.created_at });
                continue;
            }
            if (candidate.disposition === 'keep') {
                refs.set(candidate.candidate_id, candidate.target_refs);
                continue;
            }
            const single = candidate.target_refs.length === 1 ? candidate.target_refs[0] : null;
            const factId = single && candidate.disposition !== 'add' ? single.fact_id : store.allocateId('fact');
            const max = store.db.prepare('SELECT MAX(revision) AS revision FROM facts WHERE id=?').get(factId) as any;
            const eventRefs = candidate.event_refs.map(ref => { const event = eventMap.get(ref.event_id); const sourceId = (event?.context.review_slice as any)?.source_event_id; return { ...ref, event_id: typeof sourceId === 'string' ? sourceId : ref.event_id }; });
            const projection = structuredClone(candidate.analytics_projection ?? { schema_version: 1 as const, value: null, reason: 'Analytics projection not supplied' });
            if (projection.value)
                projection.value.event_refs = projection.value.event_refs.map(ref => {
                    const index = candidate.event_refs.findIndex(original => canonical(original) === canonical(ref));
                    if (index < 0)
                        throw new Error('Analytics projection evidence outside fact evidence');
                    return { ...ref, event_id: eventRefs[index].event_id };
                });
            if (projection.value?.verification) {
                const verification = projection.value.verification;
                version(verification);
                utc(verification.verified_at);
                if (verification.basis !== 'user_explicit_verification' || !verification.name?.trim() || !verification.value?.trim() || verification.subject !== candidate.subject || !verification.event_refs.length)
                    throw new Error('Invalid explicit verification');
                verification.event_refs = verification.event_refs.map(ref => {
                    if(!candidate.event_refs.some(original=>canonical(original)===canonical(ref)) || !projection.value!.event_refs.some(original=>canonical(original)===canonical(ref)))throw new Error('Verification requires exact fact/projection evidence span');
                    const event = eventMap.get(ref.event_id);
                    if (!event || event.role !== 'user' || !event.utc_time.value || normalized(event.utc_time.value) !== normalized(verification.verified_at))
                        throw new Error('Verification requires a user event at the actual verification time');
                    const original = (event.context.review_slice as any)?.source_event_id;
                    return { ...ref, event_id: original ?? ref.event_id };
                });
            }
            const attribution = derived ? { ...candidate.attribution, derived_from: bundle.existing_facts.filter(f => f.event_refs.some(r => candidate.event_refs.some(c => canonical(c) === canonical(r)))).map(f => ({ schema_version: 1, fact_id: f.fact_id, revision: f.revision })) } : candidate.attribution;
            const fact: FactRevision = { schema_version: 1, fact_id: factId, revision: (max.revision ?? 0) + 1, event_refs: eventRefs, content: candidate.content, subject: candidate.subject, occurred_at: candidate.occurred_at, journal_date: candidate.journal_date, kind: candidate.kind, analytics_projection: projection, action: candidate.disposition === 'add' ? 'assert' : candidate.disposition, target_refs: candidate.target_refs, scope: candidate.scope, attribution, recorded_at: result.created_at };
            store.db.prepare('INSERT INTO facts VALUES(?,?,?,?)').run(fact.fact_id, fact.revision, canonical(fact), normalized(fact.recorded_at));
            facts.push(fact);
            refs.set(candidate.candidate_id, [{ schema_version: 1, fact_id: fact.fact_id, revision: fact.revision }]);
            for (const key of targetKeys)
                liveTargets.delete(key);
            liveTargets.add(refKey(fact));
        }
        store.options.onTransactionStep?.('review_facts');
        for (const review of result.chunks) {
            for (const id of review.reviewed_event_ids) {
                const event=chunks.get(review.chunk_id)!.events.find(e=>e.event_id===id)!;
                const spans=bundle.kind==='daily'?(primarySpans.final.get(id)??[]):[exactReviewUnit(event)];
                for(const span of spans) {
                    // A failed candidate holds only its own evidence interval.
                    const rejected=result.candidates.filter(candidate=>candidate.chunk_id===review.chunk_id && !refs.has(candidate.candidate_id)).flatMap(candidate=>candidate.event_refs);
                    if(rejected.some(ref=>ref.start_byte!==undefined&&ref.end_byte!==undefined&&overlaps(span,{schema_version:1,event_id:ref.event_id,start_byte:ref.start_byte,end_byte:ref.end_byte})))continue;
                    const unit=eventForSpan(event,span);
                    finalizedEvents.add(id);
                    if(bundle.replay)store.markReplayUnit(unit,bundle.replay.work_id);else store.markUnit(unit,bundle.kind,bundle.lane);
                }
            }
            if (review.status === 'complete' && chunks.get(review.chunk_id)!.events.length === 0)
                store.db.prepare('INSERT OR IGNORE INTO reviewed_units VALUES(?,?,?)').run(bundle.kind, bundle.lane, review.chunk_id);
            store.db.prepare('UPDATE chunks SET state=? WHERE id=?').run(failed.has(review.chunk_id) ? 'partial' : review.status, review.chunk_id);
        }
        const semanticContext = bundle.analysis_context ?? bundle.monthly_context;
        if (!bundle.monthly_context?.work_only && semanticContext?.facts_page && (bundle.monthly_context ? completeMonthlyMaterial : completedSemantic) && (result.analysis || result.monthly_review))
            store.markFactMaterialRead(semanticContext.facts_page.snapshot_id, semanticContext.facts.map(fact => 'fact_ref' in fact ? fact.fact_ref : { schema_version: 1, fact_id: fact.fact_id, revision: fact.revision }));
        store.options.onTransactionStep?.('review_chunks');
        if (bundle.replay && !failed.size && result.chunks.length && result.chunks.every(chunk => chunk.status === 'complete'))
            store.replayRepository().finish(bundle.replay.work_id, result.created_at);
        const patches: JournalPatch[] = [];
        for (const page of result.pages) {
            version(page);
            if (page.candidate_ids.some(id => !result.candidates.some(c => c.candidate_id === id)))
                throw new Error('Page references unknown candidate');
            if (page.candidate_ids.some(id => !refs.has(id))) {
                store.putWork({ schema_version: 1, work_id: store.allocateId('work'), kind: 'journal_suggestion', lane: bundle.lane, state: 'pending', payload: { bundle_id: bundle.bundle_id, page }, reason: 'Page depends on unresolved candidate', migration_key: null, updated_at: result.created_at });
                continue;
            }
            const baseline = bundle.baselines.find(b => b.path === page.path);
            if (!baseline || baseline.digest !== page.baseline_digest)
                throw new Error('Page baseline outside bundle');
            if (page.mode === 'replace' && !page.old_text)
                throw new Error('Exact replacement requires old_text');
            if (baseline.context_excerpt && page.mode === 'replace' && !baseline.content?.includes(page.old_text!))
                throw new Error('Excerpt baseline allows only exact replacement visible in supplied excerpt');
            const patch: JournalPatch = { schema_version: 1, operation_id: store.allocateId('operation'), date: page.date, path: page.path, baseline_digest: page.baseline_digest, mode: page.mode, old_text: page.old_text, new_text: page.new_text, fact_refs: page.candidate_ids.flatMap(id => refs.get(id) ?? []) };
            store.db.prepare('INSERT INTO patches VALUES(?,?,?,NULL)').run(patch.operation_id, canonical(patch), 'pending');
            patches.push(patch);
        }
        store.options.onTransactionStep?.('review_patches');
        queueAcceptedJournalWork(store.db, bundle, result, facts, patches, refs, item => store.putWork(item), store.journalTimezone, store.currentJournalPresentPaths,store.wikiLockHeld);
        const batchId = store.allocateId('batch');
        const sourceChunks = bundle.chunks.filter(chunk => !chunk.chunk_id.startsWith('pages:'));
        const explicitEmpty = sourceChunks.length > 0 && sourceChunks.every(chunk => chunk.events.length === 0 && reviews.get(chunk.chunk_id)?.status === 'complete' && reviews.get(chunk.chunk_id)?.zero_facts === true);
        const boundedEmpty = explicitEmpty && bundle.review_range !== undefined && Date.parse(bundle.review_range.to) - Date.parse(bundle.review_range.from) <= 32 * 86400000 && normalized(bundle.review_range.to) <= normalized(bundle.cutoff);
        const reviewedCoverage = bundle.kind === 'daily' ? bundle.coverage.map(c => store.coverageReview(c, bundle.kind, boundedEmpty && normalized(c.query_range.from) >= normalized(bundle.review_range!.from) && normalized(c.query_range.to) <= normalized(bundle.review_range!.to))) : structuredClone(bundle.analysis_context?.coverage ?? bundle.monthly_context?.coverage ?? bundle.coverage);
        if (bundle.kind === 'daily')
            for (const coverage of reviewedCoverage)
                store.db.prepare('UPDATE coverage SET json=? WHERE id=?').run(canonical(coverage), coverage.coverage_id);
        const artifact: FactArtifact = { schema_version: 1, batch_id: batchId, created_at: result.created_at, facts, coverage: reviewedCoverage, affected_dates: [...new Set(facts.flatMap(f => f.journal_date.value ? [f.journal_date.value] : []))].sort(), affected_weeks: [] };
        const pageContext = bundle.analysis_context ?? bundle.monthly_context;
        if (bundle.monthly_context?.work_only && priorWorkConclusion) {
            // Work continuation acknowledges exact frozen IDs; its raw note is retained
            // in ReviewResult but never becomes another accumulated semantic conclusion.
            artifact.monthly_review={...structuredClone(priorWorkConclusion),completed_work_ids:[...new Set([...(priorWorkConclusion.completed_work_ids??[]),...(result.monthly_review?.completed_work_ids??[])])]};
        }
        else if (pageContext?.facts_page && (result.analysis || (result.monthly_review && completeMonthlyMaterial))) {
            const value = result.analysis ?? result.monthly_review!;
            // The machine-produced monthly target changes after publishing. It is not a new source material page.
            const automaticPath = `wiki/personal/journals/reviews/回顾_${bundle.period?.replace('-', '_')}.md`;
            const sources = bundle.kind === 'monthly' ? bundle.monthly_context!.manual_baselines.filter(page => page.path !== automaticPath).map(page => ({ path: page.path, digest: page.digest, content: page.content })) : [];
            const materialId = (bundle.kind === 'monthly' ? 'monthly-complete:' : '') + digest(canonical({ offset: pageContext.facts_page.offset, sources, archives: bundle.monthly_context?.archive_contexts?.map(item => ({ work_id: item.work_id, original_digest: item.original_digest, content_excerpt: item.content_excerpt })), archive_page: bundle.monthly_context?.archive_context_page }));
            // Earlier draft rows stay immutable. Only proven complete accepted monthly pages
            // contribute to final aggregation; new complete pages have a distinct identity.
            const provenMonthly = (alias:string) => `EXISTS(SELECT 1 FROM results r JOIN bundles b ON b.id=r.bundle_id WHERE b.kind='monthly' AND json_extract(b.json,'$.monthly_context.facts_page.snapshot_id')=${alias}.snapshot_id AND json_extract(b.json,'$.monthly_context.facts_page.offset')=${alias}.offset AND json_extract(r.json,'$.monthly_review')=${alias}.json AND ${monthlyChunksCompleteSql('b','r')})`;
            const priorComplete = bundle.kind === 'monthly' ? store.db.prepare(`SELECT p.json FROM semantic_material_pages p WHERE p.snapshot_id=? AND p.material_id=? AND ${provenMonthly('p')}`).get(pageContext.facts_page.snapshot_id,materialId.slice('monthly-complete:'.length)) as {json:string}|undefined : undefined;
            const oldPage = priorComplete ?? store.db.prepare('SELECT json FROM semantic_material_pages WHERE snapshot_id=? AND material_id=?').get(pageContext.facts_page.snapshot_id, materialId) as any;
            if (oldPage && oldPage.json !== canonical(value))
                throw new Error('Accepted material page semantic content conflict');
            if (!priorComplete) store.db.prepare('INSERT OR IGNORE INTO semantic_material_pages VALUES(?,?,?,?,?)').run(pageContext.facts_page.snapshot_id, materialId, pageContext.facts_page.offset, bundle.kind, canonical(value));
            const completeFilter = bundle.kind === 'monthly' ? ` AND (substr(p.material_id,1,17)='monthly-complete:' OR (NOT EXISTS(SELECT 1 FROM semantic_material_pages final WHERE final.snapshot_id=p.snapshot_id AND final.material_id='monthly-complete:'||p.material_id) AND ${provenMonthly('p')}))` : '';
            const pages = store.db.prepare(`SELECT p.offset,p.json FROM semantic_material_pages p WHERE p.snapshot_id=? AND p.kind=?${completeFilter} ORDER BY p.offset,p.rowid`).all(pageContext.facts_page.snapshot_id, bundle.kind).map((row: any) => ({ offset: row.offset, result: JSON.parse(row.json) }));
            // Preserve accepted pages from the earlier new schema without rewriting their immutable conclusions.
            const legacyFilter = bundle.kind === 'monthly' ? ` AND ${provenMonthly('p')}` : '';
            const legacyPages = store.db.prepare(`SELECT p.offset,p.json FROM semantic_pages p WHERE p.snapshot_id=? AND p.kind=?${legacyFilter} ORDER BY p.offset`).all(pageContext.facts_page.snapshot_id, bundle.kind).map((row: any) => ({ offset: row.offset, result: JSON.parse(row.json) }));
            pages.unshift(...legacyPages.filter(page => !pages.some(current => current.offset === page.offset && canonical(current.result) === canonical(page.result))));
            if (result.analysis)
                artifact.analysis = accumulateWeekly(pages, result.analysis);
            if (result.monthly_review)
                artifact.monthly_review = accumulateMonthly(pages);
        }
        else {
            if (result.analysis)
                artifact.analysis = structuredClone(result.analysis);
            if (result.monthly_review)
                artifact.monthly_review = structuredClone(result.monthly_review);
        }
        if (artifact.analysis)
            store.analyticsHistoryRepository().reserveAnalysis(artifact.analysis);
        // Corrections can move dates; downstream recomputes both original and replacement periods.
        const affectedFacts = [...facts];
        for (const fact of facts)
            for (const target of fact.target_refs) {
                const targetRow = store.db.prepare('SELECT json FROM facts WHERE id=? AND revision=?').get(target.fact_id, target.revision);
                if (targetRow) {
                    const oldFact = parse<FactRevision>(targetRow);
                    affectedFacts.push(oldFact);
                    const date = oldFact.journal_date.value;
                    if (date && !artifact.affected_dates.includes(date))
                        artifact.affected_dates.push(date);
                }
            }
        const weeks = new Set(affectedFacts.flatMap(f => factWeek(f) ? [factWeek(f)!] : []));
        const dates = new Set(artifact.affected_dates);
        if (bundle.kind === 'daily') {
            // Capture coverage describes what may exist, not what this result read.
            for (const review of result.chunks)
                for (const id of review.reviewed_event_ids.filter(id => finalizedEvents.has(id))) {
                    const event = chunks.get(review.chunk_id)!.events.find(event => event.event_id === id)!;
                    if (event.journal_date.value) dates.add(event.journal_date.value);
                    if (event.utc_time.value) weeks.add(weekFor(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(event.utc_time.value))));
                }
            if (explicitEmpty && bundle.review_range) {
                version(bundle.review_range);
                rangeCheck(bundle.review_range);
                const span = Date.parse(bundle.review_range.to) - Date.parse(bundle.review_range.from);
                if (span <= 32 * 86400000 && normalized(bundle.review_range.to) <= normalized(bundle.cutoff)) {
                    const zone = bundle.review_timezone ?? store.journalTimezone;
                    const local = (time: number, timezone: string) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(time));
                    // Use exclusive UTC upper bound; preserve the prepared historical journal zone.
                    let day = local(Date.parse(bundle.review_range.from), zone);
                    const last = local(Date.parse(bundle.review_range.to) - 1, zone);
                    while (day <= last) {
                        dates.add(day);
                        const next = new Date(day + 'T12:00:00Z');
                        next.setUTCDate(next.getUTCDate() + 1);
                        day = next.toISOString().slice(0, 10);
                    }
                    let week = weekFor(local(Date.parse(bundle.review_range.from), 'Europe/Amsterdam'));
                    const lastWeek = weekFor(local(Date.parse(bundle.review_range.to) - 1, 'Europe/Amsterdam'));
                    while (week <= lastWeek) {
                        weeks.add(week);
                        const next = new Date(week + 'T12:00:00Z');
                        next.setUTCDate(next.getUTCDate() + 7);
                        week = next.toISOString().slice(0, 10);
                    }
                } else {
                    store.putWork({ schema_version: 1, work_id: 'empty-review-period:' + batchId, kind: 'review_period', lane: bundle.lane, state: 'pending', payload: { batch_id: batchId, bundle_id: bundle.bundle_id, range: bundle.review_range }, reason: 'Explicit empty review period exceeds bounded 32-day scope or cutoff; no derived periods scheduled', migration_key: null, updated_at: result.created_at });
                }
            }
        }
        artifact.affected_dates = [...dates].sort();
        artifact.affected_weeks = [...weeks].sort();
        artifact.affected_months = [...new Set([...artifact.affected_dates.map(day => day.slice(0, 7)), ...(result.monthly_review ? [result.monthly_review.month] : [])])].sort();
        store.db.prepare('INSERT INTO outbox VALUES(?,?,?,NULL)').run(batchId, canonical(artifact), 'pending');
        store.options.onTransactionStep?.('review_outbox');
        const commit: ReviewCommit = { schema_version: 1, result_id: result.result_id, batch_id: batchId, reused: false, facts, patches };
        store.db.prepare('INSERT INTO results VALUES(?,?,?,?,?)').run(result.result_id, result.bundle_id, canonical(result), content, canonical(commit));
        const acceptedAt=(store.options.now?.() ?? new Date()).toISOString();
        store.db.prepare('INSERT INTO acceptance_times VALUES(?,?)').run(result.result_id,normalized(acceptedAt));
        store.db.prepare('INSERT INTO publication_acceptance_order(batch_id) VALUES(?)').run(batchId);
        store.options.onTransactionStep?.('review_result');
        return commit;
    });
}
