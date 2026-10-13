import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, copyFile, stat, chmod, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { BookkeepingConfig, Store, CollectionBatch, SourceCheckpoint, Lane, EventQuery, SourceEvent, TimeRange, SourceCoverage, ReviewBundle, ReviewChunk, ReviewResult, ReviewCommit, FactRevision, FactRef, FactQuery, JournalPatch, FileStatus, OutboxEntry, FactArtifact, ConsumerAck, FileIntent, WorkItem, LegacyImportBatch, LegacyImportResult } from '../contracts/types.ts';
import { planMetadataBatchRecovery, applyMetadataBatchRecovery, type MetadataBatchRecoveryPlan, type RestoredMetadataOperation } from './metadata-recovery.ts';
import {reassessmentPlan,applyReassessment} from './journal-reassessment.ts';
import {inventoryReviewRisks,type ReviewRiskRequest} from './review-risk-inventory.ts';
import { fileSha256 } from './file-hash.ts';
import { initializeSchema } from './schema.ts';
import { foldFacts } from './facts.ts';
import { validateReviewResult } from '../contracts/validation.ts';
import { commitSemanticReview } from './semantic-commit.ts';
export { canonical, digest } from '../analytics/serialization.ts';
import { canonical, digest } from '../analytics/serialization.ts';
import { AnalyticsRepository, type AnalyticsPort } from './analytics.ts';
import { outboxPage, filePage, recoveryCursor } from './publication-pages.ts';
import { monthlySemanticStatus, factMaterialProgress, monthlyPreparationBundleId, remainingFrozenWorkIds, hasCompleteMonthlyConclusion, assertCurrentMonthlyConclusion } from './monthly-status.ts';
const parse = <T>(row: any): T => JSON.parse(row.json);
export { weekFor } from './domain.ts';
import { refKey, utc, normalized, rangeCheck, version, unique, enrichEvent, factWeek, weekFor } from './domain.ts';
import { correctCodexClassification, type ClassificationCorrection } from './codex-automation.ts';
import type { RawFragment } from '../contracts/types.ts';
import type { SemanticReplayRequest } from '../contracts/types.ts';
import { SemanticReplayRepository } from './replay.ts';
import { ReviewReadExclusions, readAllowedSql, materialReadAllowedSql } from './read-exclusions.ts';
import { WechatReviewScope, scopeSql, scopeValueSql, conversationTypeSql, pendingScopeSql, senderSql } from './wechat-scope.ts';
import { canonicalJournalPath, commitJournalResolution, journalConflicts, supersedeOperation, updateJournalWork, queueAcceptedJournalWork, journalPayload, terminalizeJournalOperation } from './journal.ts';
import type { JournalResolution, JournalResolutionCommit, FileOutcome } from '../contracts/types.ts';
import { acquireWikiLock, assertWikiLockHeld, type WikiLock } from '../publish/lock.ts';
import { readWikiTarget } from '../publish/files.ts';
import { refreshStaleConfirmationFacts,ensureConfirmation,validateConfirmation,getConfirmation,decideConfirmation } from './journal-confirmation.ts';
import type { JournalConfirmationRequest,JournalUserDecision } from '../contracts/types.ts';
export interface StoreOptions {
    onTransactionStep?: (step: string) => void;
    reviewConfig?: BookkeepingConfig;
    now?: () => Date;
}
export interface AcceptedDailyInventoryRequest {from:string;to:string;after_result_id?:string;limit?:number;include_unknown_acceptance?:boolean}
export interface AcceptedDailyInventoryItem {result_id:string;accepted_at:import('../contracts/types.ts').UnknownValue<string>;result_created_at:string;acceptance_time_basis:'store_transaction_clock'|'unknown_legacy_result_time';window_membership:'included'|'unknown';bundle:ReviewBundle;result:ReviewResult;commit:ReviewCommit;facts:FactRevision[];targets:FactRevision[];patches:{patch:JournalPatch;status:string;reason:string|null}[];conflicts:FileOutcome[]}
export interface AcceptedDailyInventory {schema_version:1;items:AcceptedDailyInventoryItem[];next_result_id:string|null}
export interface JournalRecoveryRequest {schema_version:1;result_ids:string[];created_at:string}
export class SqliteStore implements Store {
    readonly db: DatabaseSync;
    private analyticsRepositoryInstance?: AnalyticsRepository;
    analyticsPort(): AnalyticsPort { return this.analyticsRepositoryInstance ??= new AnalyticsRepository(this.db); }
    analyticsHistoryRepository(): AnalyticsRepository { this.analyticsPort(); return this.analyticsRepositoryInstance!; }
    readonly path: string;
    readonly reviewScope: WechatReviewScope;
    readonly readExclusions: ReviewReadExclusions;
    private readonly options: StoreOptions;
    private readonly journalTimezone: string;
    constructor(path: string, options: StoreOptions = {}, journalTimezone = 'Europe/Amsterdam') {
        this.path = path;
        this.options = options;
        this.journalTimezone = journalTimezone;
        this.db = new DatabaseSync(path);
        this.db.function('utc_key', value => typeof value === 'string' ? normalized(value) : null);
        this.reviewScope = new WechatReviewScope(options.reviewConfig);
        this.readExclusions = new ReviewReadExclusions(options.reviewConfig);
        this.db.function('review_read_allowed', id => this.readExclusions.allowed(id) ? 1 : 0);
        this.db.function('review_scope_allowed', (provider, account, conversation, group) => this.reviewScope.allowed(provider, account, conversation, group) ? 1 : 0);
        this.db.function('review_scope_pending', (provider, account, conversation, type, role, verified, sender) => this.reviewScope.pendingReason(provider, account, conversation, type, role, verified, sender));
        initializeSchema(this.db);
        try { this.readExclusions.validateExists(this.db); } catch (error) { this.db.close(); throw error; }
        if ((this.db.prepare("SELECT value FROM metadata WHERE key='schema'").get() as any).value !== '1')
            throw new Error('Unsupported database schema');
        this.analyticsRepositoryInstance = new AnalyticsRepository(this.db);
    }
    close() { this.db.close(); }
    private async confirmationLock(lock:WikiLock):Promise<BookkeepingConfig> {
        const config=this.options.reviewConfig;
        if(!config || lock.root!==await realpath(config.wiki_root))throw new Error('Journal confirmation requires the configured Wiki writer lock');
        await assertWikiLockHeld(lock);return config;
    }
    async ensureJournalConfirmation(request:JournalConfirmationRequest,lock:WikiLock) {
        const config=await this.confirmationLock(lock),operation=request.intent??request.patch;
        if(!operation)throw new Error('Confirmation requires exact intent or patch');
        const current=await readWikiTarget(config.wiki_root,operation.path);
        if(current.digest!==request.current_baseline_digest)throw new Error('Journal proposal current baseline changed under lock');
        if(request.intent && request.intent.baseline_digest!==current.digest)return this.transaction(()=>validateConfirmation(this.db,request.intent!,current.digest,(this.options.now?.()??new Date()).toISOString()));
        if(request.intent && (request.intent.desired_bytes_base64===null || digest(Buffer.from(request.intent.desired_bytes_base64,'base64'))!==request.intent.desired_digest || digest(request.new_text)!==request.intent.desired_digest || (current.digest==='absent'?request.old_text!=='':digest(request.old_text)!==current.digest)))throw new Error('Journal proposal must contain complete exact current and desired bytes');
        return this.transaction(()=>ensureConfirmation(this.db,request,(this.options.now?.()??new Date()).toISOString()));
    }
    async validateJournalConfirmation(intent:FileIntent,lock:WikiLock) {
        const config=await this.confirmationLock(lock),current=await readWikiTarget(config.wiki_root,intent.path);
        return this.transaction(()=>validateConfirmation(this.db,intent,current.digest,(this.options.now?.()??new Date()).toISOString()));
    }
    async getJournalConfirmation(id:string) { return this.transaction(()=>{refreshStaleConfirmationFacts(this.db,(this.options.now?.()??new Date()).toISOString());return getConfirmation(this.db,id);}); }
    async decideJournalConfirmation(decision:JournalUserDecision,lock:WikiLock) {
        const config=await this.confirmationLock(lock),proposal=getConfirmation(this.db,decision.proposal_id);
        if(!proposal)throw new Error('Unknown journal confirmation proposal');
        const current=await readWikiTarget(config.wiki_root,proposal.path);
        return this.transaction(()=>decideConfirmation(this.db,decision,current.digest,(this.options.now?.()??new Date()).toISOString()));
    }
    async planMetadataBatchRecovery(batchId: string, beforePath: string) { return planMetadataBatchRecovery({ db: this.db, path: this.path, transaction: fn => this.transaction(fn), putWork: item => this.putWork(item) }, batchId, beforePath); }
    async applyMetadataBatchRecovery(plan: MetadataBatchRecoveryPlan, beforePath: string, restored: RestoredMetadataOperation[], at: string) { return applyMetadataBatchRecovery({ db: this.db, path: this.path, transaction: fn => this.transaction(fn), putWork: item => this.putWork(item) }, plan, beforePath, restored, at); }
    private get replayRepository(): SemanticReplayRepository { return new SemanticReplayRepository(this.db, () => this.reviewScope.validate(), (range, source, eventIds) => this.metadataScopeGaps(range, source, eventIds).length > 0 || this.reviewReadExclusions(range, source).some(item => item.unreviewed && (eventIds === undefined || eventIds.includes(item.event_id)))); }
    async requestSemanticReplay(request: SemanticReplayRequest): Promise<WorkItem> { return this.transaction(() => this.replayRepository.request(request)); }
    async getSemanticReplay(id: string): Promise<WorkItem | null> { return this.replayRepository.get(id); }
    getReplayEvents(id: string, limit: number, skipUnits?: import('../contracts/types.ts').ReviewUnit[]): SourceEvent[] { return this.reconcileCodexPage(this.replayRepository.events(id, limit,this.skippedSources('replay:'+id,'history',skipUnits))).filter(event => event.classification === 'main').map(event => this.reviewScope.enrich(event)); }
    getReplayFacts(id: string,events?:SourceEvent[]): FactRevision[] {
        const item = this.replayRepository.get(id);
        if (!item) throw new Error('Unknown semantic replay');
        return this.getScopedReviewFacts(events??this.getReplayEvents(id,320),item.payload.cutoff as string).facts;
    }
    allocateId(namespace: string): string {
        if (!/^[a-z][a-z0-9_-]*$/i.test(namespace))
            throw new Error('Invalid ID namespace');
        return namespace + ':' + randomUUID();
    }
    private transaction<T>(fn: () => T): T {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const result = fn();
            this.options.onTransactionStep?.('before_commit');
            this.db.exec('COMMIT');
            return result;
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
    private immutable(table: string, id: string, value: unknown, sql?: string, params?: any[]) {
        const json = canonical(value);
        const old = this.db.prepare(`SELECT json FROM ${table} WHERE id=?`).get(id) as any;
        if (old) {
            if (old.json !== json)
                throw new Error(`Immutable ${table} identity conflict: ${id}`);
            return;
        }
        this.db.prepare(sql ?? `INSERT INTO ${table}(id,json) VALUES(?,?)`).run(...(params ?? [id, json]));
    }
    private fragmentReadBlocked(event: SourceEvent): boolean {
        return this.readExclusions.fragmentBlocked(this.db, event.fragment_ref);
    }
    private sourceFragment(event: SourceEvent): RawFragment | null {
        if (!this.readExclusions.eventAllowed(event)) throw new Error('Source event read excluded');
        if (this.fragmentReadBlocked(event)) return null;
        const row = event.fragment_ref && this.db.prepare('SELECT json FROM fragments WHERE id=?').get(event.fragment_ref);
        return row ? parse<RawFragment>(row) : null;
    }
    private resolveCodexEvent(event: SourceEvent, peers: SourceEvent[] = []): ClassificationCorrection {
        if (!this.readExclusions.eventAllowed(event) || event.source.provider !== 'codex' || !['main', 'unknown'].includes(event.classification))
            return { event, reason: null };
        const sameSource = (other: SourceEvent) => other.role === 'user' && other.physical_order < event.physical_order
            && other.source.provider === event.source.provider && other.source.account_id === event.source.account_id
            && other.source.conversation_id === event.source.conversation_id && other.locator === event.locator
            && other.generation === event.generation;
        let anchor: SourceEvent | null = null;
        if (event.role === 'assistant') {
            const row = this.db.prepare(`SELECT id,ordering,CASE WHEN review_read_allowed(id)=1 THEN json ELSE NULL END AS json FROM events WHERE json_extract(json,'$.source.provider')='codex' AND json_extract(json,'$.source.account_id')=? AND json_extract(json,'$.source.conversation_id')=? AND json_extract(json,'$.locator')=? AND json_extract(json,'$.generation')=? AND json_extract(json,'$.role')='user' AND ordering<? ORDER BY ordering DESC,id DESC LIMIT 1`)
                .get(event.source.account_id, event.source.conversation_id, event.locator, event.generation, event.physical_order);
            const nearest = row as { id: string; ordering: string; json: string | null } | undefined;
            let boundary = nearest?.ordering ?? null, blocked = !!nearest && nearest.json === null;
            anchor = nearest?.json ? parse<SourceEvent>(nearest) : null;
            for (const peer of peers)
                if (sameSource(peer) && (boundary === null || peer.physical_order > boundary)) {
                    boundary = peer.physical_order; blocked = !this.readExclusions.eventAllowed(peer); anchor = blocked ? null : peer;
                }
            if (blocked) return { event: { ...event, classification: 'unknown' }, reason: 'Nearest Codex user anchor is read excluded; assistant attribution remains pending' };
        }
        if (this.fragmentReadBlocked(event) || (anchor && this.fragmentReadBlocked(anchor))) return { event: { ...event, classification: 'unknown' }, reason: 'Codex original fragment is read excluded; classification remains pending' };
        return correctCodexClassification(event, this.sourceFragment(event), anchor, anchor ? this.sourceFragment(anchor) : null);
    }
    private persistCodexCorrection(previous: SourceEvent, correction: ClassificationCorrection): void {
        // Read exclusions are operational withholding, never source reclassification.
        if (correction.reason?.includes('read excluded')) return;
        if (canonical(previous) !== canonical(correction.event))
            this.db.prepare('UPDATE events SET json=?,classification=? WHERE id=?').run(canonical(correction.event), correction.event.classification, previous.event_id);
        if (correction.reason)
            this.putWork({ schema_version: 1, work_id: 'codex-turn:' + digest(previous.event_id), kind: 'event_classification', lane: 'live', state: 'pending', payload: { event_id: previous.event_id }, reason: correction.reason, migration_key: null, updated_at: new Date().toISOString() });
        else if (correction.event.classification === 'automation') {
            const work = this.db.prepare('SELECT json FROM work WHERE id=?').get('codex-turn:' + digest(previous.event_id));
            if (work) {
                const item = parse<WorkItem>(work);
                this.putWork({ ...item, state: 'complete' });
            }
        }
    }
    // Only the bounded SQL page selected by a caller is reconciled. Original
    // fragments, accepted results and fact revisions are never rewritten.
    private reconcileCodexPage(events: SourceEvent[]): SourceEvent[] {
        if (!events.some(event => event.source.provider === 'codex' && ['main', 'unknown'].includes(event.classification))) return events;
        return this.transaction(() => events.map(event => {
            const correction = this.resolveCodexEvent(event);
            this.persistCodexCorrection(event, correction);
            return correction.event;
        }));
    }
    private reconcilePreparedSource(event: SourceEvent): void {
        const id = (event.context.review_slice as any)?.source_event_id ?? event.event_id;
        const row = this.db.prepare(`SELECT json FROM events WHERE id=? AND ${readAllowedSql()}`).get(id);
        if (row) this.reconcileCodexPage([parse<SourceEvent>(row)]);
    }
    getClassificationGaps(range: TimeRange,eventIds?:string[]): { reason: string; locator: string | null }[] {
        rangeCheck(range);
        const selected=eventIds===undefined?'':' AND e.id IN (SELECT value FROM json_each(?))';
        return this.db.prepare(`SELECT COALESCE(json_extract(w.json,'$.reason'),'Codex source turn unresolved') AS reason,json_extract(e.json,'$.locator') AS locator FROM work w JOIN events e ON json_extract(w.json,'$.payload.event_id')=e.id WHERE w.state='pending' AND w.kind='event_classification' AND e.time>=? AND e.time<?${selected} ORDER BY w.rowid LIMIT 32`)
            .all(normalized(range.from),normalized(range.to),...(eventIds===undefined?[]:[canonical(eventIds)])) as {reason:string;locator:string|null}[];
    }
    async saveCollection(batch: CollectionBatch): Promise<void> {
        version(batch);
        unique(batch.events.map(e => e.event_id), 'event IDs');
        this.transaction(() => {
            const previous = this.db.prepare('SELECT json FROM collections WHERE id=?').get(batch.batch_id) as any;
            if (previous) {
                const retained = JSON.parse(previous.json);
                const previousDigest = retained.format === 'collection-identity-v1' ? retained.content_hash : digest(canonical(retained));
                if (previousDigest !== digest(canonical(batch)))
                    throw new Error('Collection batch identity conflict');
                return;
            }
            for (const fragment of batch.fragments) {
                version(fragment);
                if (digest(Buffer.from(fragment.bytes_base64, 'base64')) !== fragment.sha256)
                    throw new Error('Fragment digest mismatch');
                this.immutable('fragments', fragment.fragment_id, fragment);
            }
            this.options.onTransactionStep?.('collection_fragments');
            for (const captured of batch.events) {
                const correction = this.resolveCodexEvent(captured, batch.events);
                const event = correction.event;
                version(event);
                if (event.utc_time.value)
                    utc(event.utc_time.value);
                if (event.fragment_ref && !this.db.prepare('SELECT id FROM fragments WHERE id=?').get(event.fragment_ref))
                    throw new Error('Missing event fragment');
                const old = this.db.prepare('SELECT json FROM events WHERE id=?').get(event.event_id) as any;
                if (old) {
                    try {
                        const previousEvent = parse<SourceEvent>(old);
                        const previousCorrection = this.resolveCodexEvent(previousEvent, batch.events);
                        const enriched = enrichEvent(previousCorrection.event, event);
                        this.db.prepare('UPDATE events SET json=?,time=?,classification=? WHERE id=?').run(canonical(enriched), enriched.utc_time.value ? normalized(enriched.utc_time.value) : null, enriched.classification, event.event_id);
                        if (enriched.utc_time.value && enriched.journal_date.value && enriched.classification !== 'unknown' && !(enriched.source.provider === 'wechat' && enriched.role === 'unknown')) {
                            const work = this.db.prepare('SELECT json FROM work WHERE id=?').get('event-gap:' + digest(event.event_id));
                            if (work) {
                                const item = parse<WorkItem>(work);
                                this.db.prepare("UPDATE work SET state='complete',json=? WHERE id=?").run(canonical({ ...item, state: 'complete' }), item.work_id);
                            }
                        }
                    }
                    catch (error) {
                        this.putWork({ schema_version: 1, work_id: 'event-conflict:' + digest(canonical(event)), kind: 'event_conflict', lane: batch.coverage.some(c => c.lane === 'live') ? 'live' : 'history', state: 'pending', payload: { event_id: event.event_id, incoming: event }, reason: String(error), migration_key: null, updated_at: new Date().toISOString() });
                        continue;
                    }
                }
                else
                    this.db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(event.event_id, canonical(event), event.utc_time.value ? normalized(event.utc_time.value) : null, event.classification, event.physical_order);
                this.persistCodexCorrection(event, correction);
                const lanes = batch.coverage.filter(c => c.provider === event.source.provider && c.account_id === event.source.account_id && (!c.conversation_id || c.conversation_id === event.source.conversation_id)).map(c => c.lane);
                for (const lane of new Set(lanes.length ? lanes : batch.checkpoints.map(c => c.lane)))
                    this.db.prepare('INSERT OR IGNORE INTO event_lanes VALUES(?,?)').run(event.event_id, lane);
                if (!event.utc_time.value || !event.journal_date.value || event.classification === 'unknown' || (event.source.provider === 'wechat' && event.role === 'unknown')) {
                    const workId = 'event-gap:' + digest(event.event_id);
                    const retained = this.db.prepare('SELECT json FROM work WHERE id=?').get(workId);
                    // This work belongs to the stable source event, not a capture lane.
                    // Keep its original lane; putWork still checks kind and exact payload.
                    const lane = retained ? parse<WorkItem>(retained).lane : lanes.includes('live') ? 'live' : 'history';
                    this.putWork({ schema_version: 1, work_id: workId, kind: 'event_identity_time', lane, state: 'pending', payload: { event_id: event.event_id }, reason: 'Event identity/time/journal date needs resolution', migration_key: null, updated_at: new Date().toISOString() });
                }
            }
            this.options.onTransactionStep?.('collection_events');
            for (const coverage of batch.coverage) {
                version(coverage);
                rangeCheck(coverage.query_range);
                utc(coverage.cutoff);
                const current = this.coverageReview(coverage, 'daily', false);
                this.db.prepare('INSERT INTO coverage VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json,from_time=excluded.from_time,to_time=excluded.to_time,lane=excluded.lane').run(coverage.coverage_id, canonical(current), normalized(coverage.query_range.from), normalized(coverage.query_range.to), coverage.lane);
            }
            for (const checkpoint of batch.checkpoints) {
                version(checkpoint);
                utc(checkpoint.updated_at);
                const old = this.db.prepare('SELECT json FROM checkpoints WHERE id=?').get(checkpoint.checkpoint_id) as any;
                if (old && (parse<SourceCheckpoint>(old).provider !== checkpoint.provider || parse<SourceCheckpoint>(old).lane !== checkpoint.lane))
                    throw new Error('Checkpoint lane identity conflict');
                this.db.prepare('INSERT INTO checkpoints VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(checkpoint.checkpoint_id, canonical(checkpoint), checkpoint.provider, checkpoint.lane);
                const actual=typeof checkpoint.cursor.last_read_at==='string' ? checkpoint.cursor.last_read_at : batch.events.some(e=>e.source.provider===checkpoint.provider) || batch.fragments.length>0 ? checkpoint.updated_at : null;
                if(actual) {
                    utc(actual);
                    const accounts=new Set([...batch.coverage.filter(c=>c.provider===checkpoint.provider).map(c=>c.account_id),...batch.events.filter(e=>e.source.provider===checkpoint.provider).map(e=>e.source.account_id)]);
                    if(typeof checkpoint.cursor.account_id==='string') {accounts.clear();accounts.add(checkpoint.cursor.account_id);}
                    for(const account of accounts) this.db.prepare('INSERT INTO source_reads VALUES(?,?,?) ON CONFLICT(provider,account_id) DO UPDATE SET last_read_at=MAX(last_read_at,excluded.last_read_at)').run(checkpoint.provider,account,normalized(actual));
                }
            }
            this.immutable('collections', batch.batch_id, { schema_version: 1, format: 'collection-identity-v1', content_hash: digest(canonical(batch)), event_ids: batch.events.map(event => event.event_id), fragment_refs: batch.fragments.map(fragment => ({ fragment_id: fragment.fragment_id, sha256: fragment.sha256 })), coverage_ids: batch.coverage.map(item => item.coverage_id), checkpoint_ids: batch.checkpoints.map(item => item.checkpoint_id) });
            this.options.onTransactionStep?.('collection_checkpoints');
        });
    }
    async getCheckpoints(provider: string, lane: Lane): Promise<SourceCheckpoint[]> { return this.db.prepare('SELECT json FROM checkpoints WHERE provider=? AND lane=? ORDER BY id').all(provider, lane).map(parse<SourceCheckpoint>); }
    async listEvents(query: EventQuery): Promise<SourceEvent[]> {
        rangeCheck(query.range);
        const limit = query.limit ?? 1000;
        if (!Number.isSafeInteger(limit) || limit < 1)
            throw new Error('Invalid event limit');
        const params: any[] = [normalized(query.range.from), normalized(query.range.to)];
        let clause = readAllowedSql() + ' AND time>=? AND time<? AND ' + scopeSql();
        if (query.source) { clause += " AND json_extract(json,'$.source.provider')=?"; params.push(query.source); }
        if (!query.include_context)
            clause += " AND classification='main' AND COALESCE(json_extract(json,'$.context.context_only'),0)!=1";
        if (query.lane) {
            clause += ' AND EXISTS(SELECT 1 FROM event_lanes l WHERE l.event_id=events.id AND l.lane=?)';
            params.push(query.lane);
        }
        if (query.after) {
            const cursor = this.db.prepare('SELECT time,ordering,id FROM events WHERE id=?').get(query.after) as any;
            if (!cursor)
                throw new Error('Unknown event cursor');
            clause += ' AND (time,ordering,id)>(?,?,?)';
            params.push(cursor.time, cursor.ordering, cursor.id);
        }
        params.push(limit);
        const events = this.db.prepare(`SELECT json FROM events WHERE ${clause} ORDER BY time,ordering,id LIMIT ?`).all(...params).map(parse<SourceEvent>);
        return this.reconcileCodexPage(events).filter(event => query.include_context || event.classification === 'main');
    }
    async listCoverage(range: TimeRange): Promise<SourceCoverage[]> {
        rangeCheck(range);
        return this.db.prepare('SELECT json FROM coverage WHERE from_time<? AND to_time>? ORDER BY id').all(normalized(range.to), normalized(range.from)).map(parse<SourceCoverage>);
    }
    async saveBundle(bundle: ReviewBundle): Promise<void> {
        version(bundle);
        utc(bundle.cutoff);
        unique(bundle.chunks.map(c => c.chunk_id), 'chunk IDs');
        this.transaction(() => {
            this.immutable('bundles', bundle.bundle_id, bundle, 'INSERT INTO bundles VALUES(?,?,?,?,?,?)', [bundle.bundle_id, canonical(bundle), bundle.kind, bundle.lane, bundle.period, bundle.cutoff]);
            for (const chunk of bundle.chunks) {
                version(chunk);
                unique(chunk.events.map(e => e.event_id), 'chunk events');
                const times = chunk.events.flatMap(e => e.utc_time.value ? [normalized(e.utc_time.value)] : []).sort();
                this.immutable('chunks', chunk.chunk_id, chunk, 'INSERT INTO chunks(id,json,kind,lane,from_time,to_time) VALUES(?,?,?,?,?,?)', [chunk.chunk_id, canonical(chunk), bundle.kind, bundle.lane, times[0] ?? null, times.at(-1) ?? null]);
            }
        });
    }
    reviewReadExclusions(range?: TimeRange, source?: string): {schema_version:1;event_id:string;reason:string;provider:string;account_id:string;unreviewed:boolean}[] {
        if (range) rangeCheck(range);
        const items: {schema_version:1;event_id:string;reason:string;provider:string;account_id:string;unreviewed:boolean}[] = [];
        for (const [id, reason] of this.readExclusions.reasons) {
            const row = this.db.prepare(`SELECT json_extract(e.json,'$.source.provider') AS provider,json_extract(e.json,'$.source.account_id') AS account_id,e.time,
                NOT EXISTS(SELECT 1 FROM reviewed_sources r WHERE r.kind='daily' AND r.source_id=e.id) AS unreviewed FROM events e WHERE e.id=?`).get(id) as any;
            if (!row) throw new Error('Review read exclusion references nonexistent event');
            if (source && row.provider !== source) continue;
            if (range && row.time !== null && (row.time < normalized(range.from) || row.time >= normalized(range.to))) continue;
            items.push({schema_version:1,event_id:id,reason,provider:row.provider,account_id:row.account_id,unreviewed:!!row.unreviewed});
        }
        return items;
    }
    private assertMaterialReadAllowed(id: string): void {
        for (const field of ['events', 'context_events']) {
            const excluded = this.db.prepare(`SELECT 1 FROM bundles b,json_each(b.json,'$.chunks') c,json_each(c.value,?) e WHERE b.id=? AND NOT (${materialReadAllowedSql('e.value')}) LIMIT 1`).get('$.' + field, id);
            if (excluded) throw new Error('Prepared source event read excluded; prepare a fresh bundle');
        }
    }
    assertReviewBundleReadable(id: string): void {
        // Material exposure is always gated, including accepted stale bundles.
        // Immutable commit reuse returns before this guard and loads no bundle.
        this.assertMaterialReadAllowed(id);
    }
    async getBundle(id: string): Promise<ReviewBundle | null> {
        this.assertMaterialReadAllowed(id);
        if (!this.db.prepare('SELECT 1 FROM results WHERE bundle_id=?').get(id))
            for (const field of ['events', 'context_events']) {
                const excluded = this.db.prepare(`SELECT 1 FROM bundles b,json_each(b.json,'$.chunks') c,json_each(c.value,?) e WHERE b.id=? AND NOT (${scopeValueSql('e.value')}) LIMIT 1`).get('$.' + field, id);
                if (excluded) throw new Error('Prepared WeChat source scope changed; prepare a fresh bundle');
            }
        const row = this.db.prepare('SELECT json FROM bundles WHERE id=?').get(id); return row ? parse(row) : null;
    }
    async listPendingChunks(range: TimeRange, lane: Lane): Promise<ReviewChunk[]> {
        rangeCheck(range);
        return this.db.prepare(`SELECT json FROM chunks WHERE lane=? AND state!='complete' AND (from_time IS NULL OR (from_time<? AND to_time>=?)) AND NOT EXISTS(SELECT 1 FROM json_each(chunks.json,'$.events') e WHERE NOT (${scopeValueSql('e.value')}) OR NOT (${materialReadAllowedSql('e.value')})) AND NOT EXISTS(SELECT 1 FROM json_each(chunks.json,'$.context_events') e WHERE NOT (${scopeValueSql('e.value')}) OR NOT (${materialReadAllowedSql('e.value')})) ORDER BY id`).all(lane, normalized(range.to), normalized(range.from)).map(parse<ReviewChunk>);
    }
    getReviewedUnits(kind: string, lane: Lane): Set<string> { return new Set(this.db.prepare('SELECT event_id FROM reviewed_units WHERE kind=?' + (kind === 'daily' ? '' : ' AND lane=?')).all(kind, ...(kind === 'daily' ? [] : [lane])).map((r: any) => r.event_id)); }
    /** Only marks for the selected raw candidate page are decoded. */
    getReviewMarks(kind:string,lane:Lane,eventIds:string[]):{units:Set<string>;spans:Map<string,{start_byte:number;end_byte:number}[]>} {
        const ids=canonical([...new Set(eventIds)]),daily=kind==='daily';
        const units=new Set<string>(this.db.prepare('SELECT event_id FROM reviewed_units WHERE kind=?'+(daily?'':' AND lane=?')+' AND event_id IN (SELECT value FROM json_each(?))').all(kind,...(daily?[]:[lane]),ids).map((row:any)=>row.event_id));
        const spans=new Map<string,{start_byte:number;end_byte:number}[]>();
        for(const row of this.db.prepare('SELECT source_id,start_byte,end_byte FROM reviewed_spans WHERE kind=?'+(daily?'':' AND lane=?')+' AND source_id IN (SELECT value FROM json_each(?)) ORDER BY source_id,start_byte,end_byte').all(kind,...(daily?[]:[lane]),ids) as any[]) {
            const values=spans.get(row.source_id)??[];values.push({start_byte:row.start_byte,end_byte:row.end_byte});spans.set(row.source_id,values);
        }
        return {units,spans};
    }
    getReviewedSpans(kind: string, lane: Lane, sourceId: string): {
        start_byte: number;
        end_byte: number;
    }[] {
        return this.db.prepare('SELECT DISTINCT start_byte,end_byte FROM reviewed_spans WHERE kind=? AND source_id=?' + (kind === 'daily' ? '' : ' AND lane=?') + ' ORDER BY start_byte,end_byte').all(kind, sourceId, ...(kind === 'daily' ? [] : [lane])).map((row:any)=>({start_byte:row.start_byte,end_byte:row.end_byte}));
    }
    validateSkipUnits(units: import('../contracts/types.ts').ReviewUnit[] | undefined): void {
        if (units === undefined) return;
        if (!Array.isArray(units)) throw new Error('skip_units must be an array');
        for (const unit of units) {
            version(unit);
            if (typeof unit.event_id !== 'string' || !unit.event_id.trim() || !Number.isSafeInteger(unit.start_byte) || !Number.isSafeInteger(unit.end_byte) || unit.start_byte < 0 || unit.end_byte < unit.start_byte) throw new Error('Invalid skip_units bounds');
            if (!this.db.prepare('SELECT 1 FROM events WHERE id=?').get(unit.event_id)) throw new Error('skip_units references nonexistent source event');
            if (!this.readExclusions.allowed(unit.event_id)) continue;
            const row = this.db.prepare('SELECT json FROM events WHERE id=?').get(unit.event_id);
            if (!row) throw new Error('skip_units references nonexistent source event');
            const bytes = Buffer.from(parse<SourceEvent>(row).body ?? '');
            const {start_byte:start,end_byte:end} = unit;
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || (end === start && bytes.length !== 0) || end > bytes.length || (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) || (end < bytes.length && (bytes[end]! & 0xc0) === 0x80)) throw new Error('Invalid skip_units UTF-8 bounds');
        }
    }
    private skippedSources(kind:string,lane:Lane,units:import('../contracts/types.ts').ReviewUnit[]=[]):string[] {
        const ids=[...new Set(units.map(unit=>unit.event_id))],skipped:string[]=[];
        for(const id of ids) {
            if (!this.readExclusions.allowed(id)) { skipped.push(id); continue; }
            const row=this.db.prepare('SELECT json FROM events WHERE id=?').get(id);if(!row) throw new Error('skip_units references nonexistent source event');
            const total=Buffer.byteLength(parse<SourceEvent>(row).body ?? '');
            const spans=[...this.getReviewedSpans(kind,lane,id),...units.filter(unit=>unit.event_id===id)].sort((a,b)=>a.start_byte-b.start_byte || a.end_byte-b.end_byte);
            let frontier=0;for(const span of spans) {if(span.start_byte>frontier)break;frontier=Math.max(frontier,span.end_byte);}
            if(frontier>=total)skipped.push(id);
        }
        return skipped;
    }
    async getReviewableEvents(query: EventQuery, kind: string, skipUnits?:import('../contracts/types.ts').ReviewUnit[]): Promise<SourceEvent[]> {
        let after: {time:string;ordering:string;id:string}|undefined;
        if (query.after) {
            const row = this.db.prepare('SELECT time,ordering,id FROM events WHERE id=?').get(query.after) as any;
            if (!row?.time) throw new Error('Unknown review event cursor');
            after = row;
        }
        return this.getReviewCandidatePage(query, kind, skipUnits, after).events;
    }
    getReviewCandidatePage(query: EventQuery, kind: string, skipUnits?:import('../contracts/types.ts').ReviewUnit[], after?:{time:string;ordering:string;id:string}): {events:SourceEvent[];positions:{time:string;ordering:string;id:string}[];rows:number;last:{time:string;ordering:string;id:string}|null;exhausted:boolean} {
        rangeCheck(query.range);
        const limit = query.limit ?? 1000;
        if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid event limit');
        const args: any[] = [normalized(query.range.from), normalized(query.range.to)];
        const lane = query.lane ? ' AND EXISTS(SELECT 1 FROM event_lanes l WHERE l.event_id=e.id AND l.lane=?)' : '';
        if (query.lane) args.push(query.lane);
        args.push(kind);
        const progressLane = kind === 'daily' ? '' : ' AND r.lane=?';
        if (kind !== 'daily') args.push(query.lane);
        const source = query.source ? " AND json_extract(e.json,'$.source.provider')=?" : '';
        if (query.source) args.push(query.source);
        const excluded=this.skippedSources(kind,query.lane ?? 'live',skipUnits);
        const skip=excluded.length ? ' AND e.id NOT IN (SELECT value FROM json_each(?))' : '';
        if(excluded.length) args.push(canonical(excluded));
        const continuation = after ? ' AND (e.time,e.ordering,e.id)>(?,?,?)' : '';
        if (after) args.push(after.time, after.ordering, after.id);
        args.push(limit);
        const rows = this.db.prepare(`SELECT e.json,e.time,e.ordering,e.id FROM events e WHERE ${readAllowedSql('e')} AND e.time>=? AND e.time<? AND e.classification='main' AND COALESCE(json_extract(e.json,'$.context.context_only'),0)!=1 AND COALESCE(json_extract(e.json,'$.context.incomplete_turn'),0)!=1 AND (json_extract(e.json,'$.role')='user' OR COALESCE(json_extract(e.json,'$.context.turn_complete'),1)!=0)${lane} AND NOT EXISTS(SELECT 1 FROM reviewed_sources r WHERE r.source_id=e.id AND r.kind=?${progressLane}) AND ${scopeSql('e')} AND ${senderSql('e')}${source}${skip}${continuation} ORDER BY e.time,e.ordering,e.id LIMIT ?`).all(...args) as {json:string;time:string;ordering:string;id:string}[];
        const positions = rows.map(({time,ordering,id})=>({time,ordering,id}));
        return {events:this.reconcileCodexPage(rows.map(parse<SourceEvent>)).filter(event => event.classification === 'main').map(event => this.reviewScope.enrich(event)),positions,rows:rows.length,last:positions.at(-1) ?? null,exhausted:rows.length<limit};
    }
    reviewProviders(range: TimeRange, lane?: Lane): string[] {
        rangeCheck(range);
        return this.db.prepare(`SELECT DISTINCT json_extract(e.json,'$.source.provider') AS provider FROM events e WHERE e.time>=? AND e.time<?${lane ? ' AND EXISTS(SELECT 1 FROM event_lanes l WHERE l.event_id=e.id AND l.lane=?)' : ''} ORDER BY provider`).all(normalized(range.from), normalized(range.to), ...(lane ? [lane] : [])).map((row: any) => row.provider);
    }
    sourcePendingGaps(range: TimeRange, source?: string,eventIds?:string[]): { reason: string; locator: string | null }[] {
        const args: any[] = [normalized(range.from), normalized(range.to)];
        const provider = source ? " AND json_extract(e.json,'$.source.provider')=?" : '';
        if (source) args.push(source);
        const selected=eventIds===undefined?'':' AND e.id IN (SELECT value FROM json_each(?))';
        if(eventIds!==undefined)args.push(canonical(eventIds));
        const work=this.db.prepare(`SELECT json_extract(w.json,'$.reason') AS reason,json_extract(e.json,'$.locator') AS locator FROM work w JOIN events e ON json_extract(w.json,'$.payload.event_id')=e.id WHERE w.state='pending' AND w.kind IN ('event_conflict','event_identity_time') AND e.time>=? AND e.time<?${provider}${selected} AND ${scopeSql('e')} ORDER BY w.rowid LIMIT 32`).all(...args);
        const incomplete=this.db.prepare(`SELECT 'Incomplete source turn requires subsequent context' AS reason,json_extract(e.json,'$.locator') AS locator FROM events e WHERE e.time>=? AND e.time<?${provider}${selected} AND e.classification='main' AND ${scopeSql('e')} AND (COALESCE(json_extract(e.json,'$.context.incomplete_turn'),0)=1 OR (json_extract(e.json,'$.role')!='user' AND json_extract(e.json,'$.context.turn_complete')=0)) AND NOT EXISTS(SELECT 1 FROM reviewed_sources r WHERE r.kind='daily' AND r.source_id=e.id) ORDER BY e.time,e.ordering,e.id LIMIT 32`).all(...args);
        return [...work,...incomplete] as {reason:string;locator:string|null}[];
    }
    metadataScopeGaps(range: TimeRange, source: string, eventIds?: string[]): { reason: string; locator: string | null }[] {
        if (source !== 'wechat') return [];
        const reason = pendingScopeSql('e');
        const selected = eventIds === undefined ? '' : ' AND e.id IN (SELECT value FROM json_each(?))';
        return this.db.prepare(`SELECT ${reason} AS reason,json_extract(e.json,'$.locator') AS locator FROM events e WHERE e.time>=? AND e.time<? AND json_extract(e.json,'$.source.provider')=? AND ${reason} IS NOT NULL${selected} ORDER BY e.time,e.ordering,e.id LIMIT 32`).all(normalized(range.from), normalized(range.to), source, ...(eventIds === undefined ? [] : [canonical(eventIds)])) as any;
    }
    filterReviewFacts(facts: FactRevision[]): FactRevision[] {
        // Primary events are isolated by provider. Accepted facts remain shared
        // dedup context, including legacy/archive facts with no available raw ref.
        return facts.filter(fact => fact.event_refs.every(ref => {
            if (!this.readExclusions.allowed(ref.event_id)) return false;
            const row = this.db.prepare(`SELECT json_extract(e.json,'$.source.provider') AS provider,json_extract(e.json,'$.source.account_id') AS account,json_extract(e.json,'$.source.conversation_id') AS conversation,${conversationTypeSql('e.json')} AS type FROM events e WHERE e.id=?`).get(ref.event_id) as any;
            return !row || !this.reviewScope.excludesFactGroup(row.provider, row.account, row.conversation, row.type);
        }));
    }
    getScopedReviewFacts(events:SourceEvent[],cutoff:string,limit=320):{facts:FactRevision[];omitted:boolean} {
        utc(cutoff);
        const eventIds=canonical([...new Set(events.map(event=>(event.context.review_slice as any)?.source_event_id??event.event_id))]);
        const dates=canonical([...new Set(events.flatMap(event=>event.journal_date.value?[-1,0,1].map(offset=>{const day=new Date(event.journal_date.value!+'T12:00:00Z');day.setUTCDate(day.getUTCDate()+offset);return day.toISOString().slice(0,10);}):[]))]);
        // Start with the actual supplied units/dates, then follow only their
        // revision identities and explicit correction edges. Never fold history.
        const rows=this.db.prepare(`WITH RECURSIVE related(id,revision) AS (
          SELECT f.id,f.revision FROM facts f WHERE f.recorded_at<=? AND (json_extract(f.json,'$.journal_date.value') IN (SELECT value FROM json_each(?)) OR EXISTS(SELECT 1 FROM fact_event_refs r WHERE r.fact_id=f.id AND r.revision=f.revision AND r.event_id IN (SELECT value FROM json_each(?))))
          UNION SELECT next.id,next.revision FROM related prior JOIN facts next ON next.id=prior.id WHERE next.recorded_at<=?
          UNION SELECT t.fact_id,t.revision FROM related prior JOIN fact_targets t ON t.target_id=prior.id AND t.target_revision=prior.revision JOIN facts next ON next.id=t.fact_id AND next.revision=t.revision WHERE next.recorded_at<=?
          UNION SELECT t.target_id,t.target_revision FROM related prior JOIN fact_targets t ON t.fact_id=prior.id AND t.revision=prior.revision JOIN facts target ON target.id=t.target_id AND target.revision=t.target_revision WHERE target.recorded_at<=?
        ) SELECT f.json FROM related r JOIN facts f ON f.id=r.id AND f.revision=r.revision
          WHERE json_extract(f.json,'$.action')!='retract'
          AND NOT EXISTS(SELECT 1 FROM fact_event_refs er WHERE er.fact_id=f.id AND er.revision=f.revision AND review_read_allowed(er.event_id)!=1)
          AND NOT EXISTS(SELECT 1 FROM fact_event_refs er JOIN events e ON e.id=er.event_id WHERE er.fact_id=f.id AND er.revision=f.revision AND json_extract(e.json,'$.source.provider')='wechat' AND ${conversationTypeSql('e.json')}='group' AND review_scope_allowed(json_extract(e.json,'$.source.provider'),json_extract(e.json,'$.source.account_id'),json_extract(e.json,'$.source.conversation_id'),1)!=1)
          AND NOT EXISTS(SELECT 1 FROM facts later WHERE later.id=f.id AND later.revision>f.revision AND later.recorded_at<=?)
          AND NOT EXISTS(SELECT 1 FROM fact_targets t JOIN facts correction ON correction.id=t.fact_id AND correction.revision=t.revision WHERE t.target_id=f.id AND t.target_revision>=f.revision AND correction.recorded_at<=?)
          ORDER BY f.id,f.revision LIMIT ?`).all(normalized(cutoff),dates,eventIds,...Array(5).fill(normalized(cutoff)),limit+1).map(parse<FactRevision>);
        return {facts:this.filterReviewFacts(rows.slice(0,limit)),omitted:rows.length>limit};
    }
    getExplicitReviewFacts(refs:FactRef[],cutoff:string):FactRevision[] {
        utc(cutoff);unique(refs.map(refKey),'explicit context fact refs');if(refs.length>32)throw new Error('Explicit context fact refs exceed 32');
        for(const ref of refs) {
            const row=this.db.prepare(`SELECT json_extract(f.json,'$.event_refs') AS event_refs FROM facts f WHERE f.id=? AND f.revision=? AND f.recorded_at<=?
              AND json_extract(f.json,'$.action')!='retract'
              AND NOT EXISTS(SELECT 1 FROM facts later WHERE later.id=f.id AND later.revision>f.revision AND later.recorded_at<=?)
              AND NOT EXISTS(SELECT 1 FROM fact_targets t JOIN facts correction ON correction.id=t.fact_id AND correction.revision=t.revision WHERE t.target_id=f.id AND t.target_revision>=f.revision AND correction.recorded_at<=?)`).get(ref.fact_id,ref.revision,...Array(3).fill(normalized(cutoff))) as {event_refs:string}|undefined;
            if(!row)throw new Error('Explicit context fact revision unavailable or not effective at frozen cutoff');
            for(const source of JSON.parse(row.event_refs??'[]')) {
                if(!this.readExclusions.allowed(source.event_id))throw new Error('Explicit context fact references a read-excluded source');
                const event=this.db.prepare(`SELECT json_extract(json,'$.source.provider') AS provider,json_extract(json,'$.source.account_id') AS account,json_extract(json,'$.source.conversation_id') AS conversation,${conversationTypeSql('json')} AS type FROM events WHERE id=?`).get(source.event_id) as any;
                if(event&&this.reviewScope.excludesFactGroup(event.provider,event.account,event.conversation,event.type))throw new Error('Explicit context fact references an excluded source scope');
            }
        }
        return this.lookupFactRevisions(refs);
    }
    async listReviewCoverage(events:SourceEvent[],range:TimeRange,source:string|undefined,lane:Lane):Promise<SourceCoverage[]> {
        const accounts=canonical([...new Set(events.map(event=>event.source.account_id))]),conversations=canonical([...new Set(events.map(event=>event.source.conversation_id))]);
        return this.db.prepare(`SELECT json FROM coverage WHERE from_time<? AND to_time>? AND lane=? AND (? IS NULL OR json_extract(json,'$.provider')=?) AND json_extract(json,'$.account_id') IN (SELECT value FROM json_each(?)) AND (json_extract(json,'$.conversation_id') IS NULL OR json_extract(json,'$.conversation_id') IN (SELECT value FROM json_each(?))) ORDER BY id LIMIT 64`).all(normalized(range.to),normalized(range.from),lane,source??null,source??null,accounts,conversations).map(parse<SourceCoverage>);
    }
    getContextEvents(event: SourceEvent,cutoff?:string): SourceEvent[] {
        if (!this.readExclusions.eventAllowed(event) || !event.utc_time.value || !this.reviewScope.eventAllowed(event))
            return [];
        const originalId = (event.context.review_slice as any)?.source_event_id ?? event.event_id;
        const group = this.reviewScope.isGroupEvent(event);
        if (group) {
            const anchor = Date.parse(event.utc_time.value);
            const events = this.db.prepare(`SELECT json FROM events WHERE ${readAllowedSql()} AND json_extract(json,'$.source.provider')=? AND json_extract(json,'$.source.account_id')=? AND json_extract(json,'$.source.conversation_id')=? AND time>=? AND time<=? AND id!=? AND classification='main' AND ${scopeSql()} AND ${senderSql()} ORDER BY ABS(julianday(time)-julianday(?)),time,ordering,id LIMIT 12`)
                .all(event.source.provider, event.source.account_id, event.source.conversation_id, normalized(new Date(anchor - 20 * 60000).toISOString()), normalized(new Date(Math.min(anchor + 20 * 60000,cutoff?Date.parse(cutoff)-1:Infinity)).toISOString()), originalId, normalized(event.utc_time.value))
                .map(parse<SourceEvent>).sort((a, b) => normalized(a.utc_time.value!).localeCompare(normalized(b.utc_time.value!)) || a.physical_order.localeCompare(b.physical_order));
            return this.reconcileCodexPage(events).filter(event => event.classification === 'main').map(event => this.reviewScope.enrich(event));
        }
        const events = this.db.prepare(`SELECT json FROM events WHERE ${readAllowedSql()} AND json_extract(json,'$.source.provider')=? AND json_extract(json,'$.source.account_id')=? AND json_extract(json,'$.source.conversation_id')=? AND (time,ordering,id)<(?,?,?) AND id!=? AND classification='main' AND ${scopeSql()} AND ${senderSql()} ORDER BY time DESC,ordering DESC,id DESC LIMIT 3`)
            .all(event.source.provider, event.source.account_id, event.source.conversation_id, normalized(event.utc_time.value), event.physical_order, originalId, originalId).map(parse<SourceEvent>).reverse();
        return this.reconcileCodexPage(events).filter(event => event.classification === 'main').map(event => this.reviewScope.enrich(event));
    }
    resolveJournalPath(date:string,cutoff:string,timezone=this.journalTimezone):string {return canonicalJournalPath(this.db,date,cutoff,timezone);}
    getSelectedReviewEvents(ids:string[]):SourceEvent[] {
        if(ids.some(id=>!this.readExclusions.allowed(id)))throw new Error('Selected preparation material is read excluded; prepare accessible material again');
        const rows=this.db.prepare(`SELECT json FROM events WHERE id IN (SELECT value FROM json_each(?)) AND ${readAllowedSql()} AND ${scopeSql()} AND ${senderSql()}`).all(canonical(ids)).map(parse<SourceEvent>);
        if(rows.length!==new Set(ids).size)throw new Error('Selected preparation material scope changed; prepare again');
        const events=this.reconcileCodexPage(rows).filter(event=>event.classification==='main').map(event=>this.reviewScope.enrich(event));
        const byId=new Map(events.map(event=>[event.event_id,event]));return ids.flatMap(id=>byId.has(id)?[byId.get(id)!]:[]);
    }
    isContextTruncated(event: SourceEvent): boolean {
        if (!this.readExclusions.eventAllowed(event) || !this.reviewScope.eventAllowed(event) || !event.utc_time.value || !this.reviewScope.isGroupEvent(event))
            return false;
        const anchor = Date.parse(event.utc_time.value), originalId = (event.context.review_slice as any)?.source_event_id ?? event.event_id;
        const row = this.db.prepare(`SELECT COUNT(*) AS count FROM events WHERE ${readAllowedSql()} AND json_extract(json,'$.source.provider')=? AND json_extract(json,'$.source.account_id')=? AND json_extract(json,'$.source.conversation_id')=? AND time>=? AND time<=? AND id!=? AND classification='main' AND ${scopeSql()} AND ${senderSql()}`).get(event.source.provider, event.source.account_id, event.source.conversation_id, normalized(new Date(anchor - 20 * 60000).toISOString()), normalized(new Date(anchor + 20 * 60000).toISOString()), originalId) as any;
        return row.count > 12;
    }
    private markUnit(event: SourceEvent, kind: string, lane: Lane, mirror = true) {
        if (kind === 'daily' && mirror)
            this.markUnit(event, kind, lane === 'live' ? 'history' : 'live', false);
        const slice = event.context.review_slice as any;
        const sourceId = slice?.source_event_id ?? event.event_id;
        const start = slice?.start_byte ?? 0;
        const end = slice?.end_byte ?? Buffer.byteLength(event.body ?? '');
        const total = slice?.total_bytes ?? end;
        this.db.prepare('INSERT OR IGNORE INTO reviewed_units VALUES(?,?,?)').run(kind, lane, event.event_id);
        this.db.prepare('INSERT OR IGNORE INTO reviewed_spans VALUES(?,?,?,?,?,?)').run(kind, lane, sourceId, start, end, total);
        const spans = this.db.prepare('SELECT start_byte,end_byte,total_bytes FROM reviewed_spans WHERE kind=? AND lane=? AND source_id=? ORDER BY start_byte,end_byte').all(kind, lane, sourceId) as any[];
        let frontier = 0;
        for (const span of spans) {
            if (span.start_byte > frontier)
                break;
            frontier = Math.max(frontier, span.end_byte);
        }
        if (frontier >= total)
            this.db.prepare('INSERT OR IGNORE INTO reviewed_sources VALUES(?,?,?)').run(kind, lane, sourceId);
    }
    private coverageReview(coverage: SourceCoverage, kind: string, explicitEmpty: boolean): SourceCoverage {
        const events = this.db.prepare(`SELECT e.id FROM events e WHERE json_extract(e.json,'$.source.provider')=? AND json_extract(e.json,'$.source.account_id')=? AND (? IS NULL OR json_extract(e.json,'$.source.conversation_id')=?) AND (${scopeSql('e')} OR ${pendingScopeSql('e')} IS NOT NULL) AND e.classification IN ('main','unknown') AND COALESCE(json_extract(e.json,'$.context.context_only'),0)!=1 AND (e.time IS NULL OR (e.time>=? AND e.time<?)) AND EXISTS(SELECT 1 FROM event_lanes l WHERE l.event_id=e.id AND l.lane=?)`).all(coverage.provider, coverage.account_id, coverage.conversation_id, coverage.conversation_id, normalized(coverage.query_range.from), normalized(coverage.query_range.to), coverage.lane) as any[];
        const done = events.filter(e => this.db.prepare('SELECT 1 FROM reviewed_sources WHERE kind=? AND lane=? AND source_id=?').get(kind, coverage.lane, e.id)).length;
        const any = events.some(e => this.db.prepare('SELECT 1 FROM reviewed_spans WHERE kind=? AND lane=? AND source_id=? LIMIT 1').get(kind, coverage.lane, e.id));
        const status = events.length ? done === events.length ? 'complete' : (done || any) ? 'partial' : 'pending' : explicitEmpty && coverage.capture_status === 'complete' && !coverage.gaps.length ? 'complete' : 'pending';
        return { ...coverage, review_status: status };
    }
    freezeArchiveWork(snapshotId: string, ids: string[]): string[] {
        return this.transaction(() => {
            const row = this.db.prepare('SELECT json FROM archive_material_work WHERE snapshot_id=?').get(snapshotId) as any;
            if (row) return JSON.parse(row.json);
            this.db.prepare('INSERT INTO archive_material_work VALUES(?,?)').run(snapshotId, canonical(ids));
            return ids;
        });
    }
    freezeFactMaterial(kind: 'weekly' | 'monthly', period: string, cutoff: string, refs: FactRef[], work_ids: string[] = [], context_work_ids: string[] = []): string { utc(cutoff); const value = { schema_version: 1, kind, period, cutoff, refs, work_ids, context_work_ids }; const id = 'fact-material:' + digest(canonical(value)); this.immutable('fact_material_snapshots', id, value); return id; }
    getFactMaterial(id: string): {
        kind: 'weekly' | 'monthly';
        period: string;
        cutoff: string;
        refs: FactRef[];
        work_ids?: string[];
    } | null { const row = this.db.prepare('SELECT json FROM fact_material_snapshots WHERE id=?').get(id); return row ? parse(row) : null; }
    getFactMaterialReads(id: string): Set<string> { return new Set(this.db.prepare('SELECT fact_id,revision FROM fact_material_reads WHERE snapshot_id=?').all(id).map((row: any) => row.fact_id + ':' + row.revision)); }
    remainingFrozenWorkIds(ids:string[]):string[] {return remainingFrozenWorkIds(this.db,ids);}
    async hasCompleteMonthlyConclusion(snapshot_id:string):Promise<boolean> {return hasCompleteMonthlyConclusion(this.db,snapshot_id);}
    assertCurrentMonthlyConclusion(snapshot_id:string):void {assertCurrentMonthlyConclusion(this.db,snapshot_id);}
    monthlyPreparationBundleId(base_id:string):string {return monthlyPreparationBundleId(this.db,base_id);}
    async factMaterialProgress(snapshot_id:string) {return factMaterialProgress(this.db,snapshot_id);}
    markFactMaterialRead(id: string, refs: FactRef[]): void { const snapshot = this.getFactMaterial(id); if (!snapshot || refs.some(ref => !snapshot.refs.some(item => refKey(item) === refKey(ref))))
        throw new Error('Read fact outside frozen material snapshot'); for (const ref of refs)
        this.db.prepare('INSERT OR IGNORE INTO fact_material_reads VALUES(?,?,?)').run(id, ref.fact_id, ref.revision); }
    effectiveFactRefsAt(cutoff: string): FactRef[] { utc(cutoff); return this.effective(cutoff).map(fact => ({ schema_version: 1, fact_id: fact.fact_id, revision: fact.revision })); }
    effectiveFactsForJournalDate(date:string):FactRevision[] { return this.effective().filter(fact=>fact.journal_date.value===date); }
    journalRetirementFacts(ref:FactRef):FactRevision[] {
        return this.db.prepare("WITH RECURSIVE retirement(id,revision) AS (SELECT ?,? UNION SELECT f.id,f.revision FROM facts f,json_each(f.json,'$.target_refs') target JOIN retirement prior ON json_extract(target.value,'$.fact_id')=prior.id AND json_extract(target.value,'$.revision')=prior.revision) SELECT f.json FROM retirement r JOIN facts f ON f.id=r.id AND f.revision=r.revision WHERE (f.id,f.revision)!=(?,?) LIMIT 1000").all(ref.fact_id,ref.revision,ref.fact_id,ref.revision).map(parse<FactRevision>);
    }
    lookupFactRevisions(refs: FactRef[]): FactRevision[] { return refs.flatMap(ref => { const row = this.db.prepare('SELECT json FROM facts WHERE id=? AND revision=?').get(ref.fact_id, ref.revision); return row ? [parse<FactRevision>(row)] : []; }); }
    async getReviewResult(id: string): Promise<ReviewResult | null> { const row = this.db.prepare('SELECT json FROM results WHERE id=?').get(id); return row ? parse(row) : null; }
    async getPublicationBatchOrder(batch_id:string):Promise<number|null> {
        const row=this.db.prepare("SELECT CASE WHEN a.ordinal BETWEEN 1 AND 9007199254740991 THEN a.ordinal ELSE NULL END AS ordinal FROM publication_acceptance_order a JOIN outbox o ON o.id=a.batch_id WHERE a.batch_id=? AND (SELECT COUNT(*) FROM results r WHERE (CASE WHEN json_valid(r.commit_json) THEN json_extract(r.commit_json,'$.batch_id') ELSE NULL END)=a.batch_id AND CASE WHEN json_valid(r.commit_json) THEN json_extract(r.commit_json,'$.schema_version')=1 AND json_extract(r.commit_json,'$.result_id')=r.id AND json_extract(r.commit_json,'$.batch_id')=a.batch_id ELSE 0 END)=1 AND (SELECT COUNT(*) FROM results claims WHERE (CASE WHEN json_valid(claims.commit_json) THEN json_extract(claims.commit_json,'$.batch_id') ELSE NULL END)=a.batch_id)=1").get(batch_id) as {ordinal:number|null}|undefined;
        return row && Number.isSafeInteger(row.ordinal) && row.ordinal!==null && row.ordinal>0 ? row.ordinal : null;
    }
    async acceptedReviewIdentity(bundle_id:string):Promise<{schema_version:1;result_id:string;batch_id:string}|null> {
        const row=this.db.prepare("SELECT id AS result_id,json_extract(commit_json,'$.batch_id') AS batch_id FROM results WHERE bundle_id=?").get(bundle_id) as {result_id:string;batch_id:string}|undefined;
        return row?{schema_version:1,...row}:null;
    }
    async acceptedJournalResolutionIdentity(journal_bundle_id:string):Promise<{schema_version:1;resolution_id:string}|null> {
        const row=this.db.prepare('SELECT id AS resolution_id FROM journal_resolutions WHERE bundle_id=?').get(journal_bundle_id) as {resolution_id:string}|undefined;
        return row?{schema_version:1,...row}:null;
    }
    private effective(asOf?: string): FactRevision[] {
        const rows = this.db.prepare('SELECT json FROM facts WHERE recorded_at<=? ORDER BY recorded_at,rowid').all(asOf ? normalized(asOf) : '9999-12-31T23:59:59.999Z').map(parse<FactRevision>);
        return foldFacts(rows);
    }
    async commitReview(result: ReviewResult): Promise<ReviewCommit> {
        const accepted = this.db.prepare('SELECT 1 FROM results WHERE bundle_id=? OR id=?').get(result.bundle_id,result.result_id);
        const bundle = accepted ? null : await this.getBundle(result.bundle_id);
        // Reconcile the bounded prepared material before entering the semantic
        // transaction. Already accepted results keep their original reuse path.
        if (bundle && !this.db.prepare('SELECT 1 FROM results WHERE bundle_id=?').get(bundle.bundle_id))
            for (const event of bundle.chunks.flatMap(chunk => [...chunk.events, ...chunk.context_events]))
                this.reconcilePreparedSource(event);
        let lock:WikiLock|null=null,currentJournalPresentPaths:Set<string>|undefined;
        try {
        if(bundle && !this.db.prepare('SELECT 1 FROM results WHERE bundle_id=?').get(bundle.bundle_id) && result.journal_dispositions?.some(d=>['already_present','not_needed'].includes(d.disposition))) {
            currentJournalPresentPaths=new Set();
            if(this.options.reviewConfig) {
                try { lock=await acquireWikiLock(this.options.reviewConfig.wiki_root); } catch { /* A file-stage failure never revokes accepted source facts. */ }
                if(lock) for(const decision of result.journal_dispositions.filter(d=>['already_present','not_needed'].includes(d.disposition))) {
                    try {
                        const baseline=bundle.baselines.find(b=>b.path===decision.path);
                        const current=await readWikiTarget(this.options.reviewConfig.wiki_root,decision.path);
                        if(current.digest===baseline?.digest) currentJournalPresentPaths.add(decision.path);
                    } catch { /* Unreadable/unsafe page remains explicit journal debt. */ }
                }
            }
        }
        return await commitSemanticReview({ assertReviewBundleReadable: id => this.assertReviewBundleReadable(id), db: this.db, options: this.options, journalTimezone: this.journalTimezone, currentJournalPresentPaths, wikiLockHeld:lock!==null, transaction: fn => this.transaction(fn), effective: () => this.effective(), allocateId: namespace => this.allocateId(namespace), putWork: item => this.putWork(item), markUnit: (event, kind, lane) => this.markUnit(event, kind, lane), coverageReview: (coverage, kind, empty) => this.coverageReview(coverage, kind, empty), analyticsHistoryRepository: () => this.analyticsHistoryRepository(), markFactMaterialRead: (id, refs) => this.markFactMaterialRead(id, refs), replayRepository: () => this.replayRepository, sourceAllowed: event => this.readExclusions.eventAllowed(event) && this.reviewScope.eventAllowed(event), markReplayUnit: (event, id) => {
            this.markUnit(event, 'replay:' + id, 'history', false);
            const sourceId = (event.context.review_slice as any)?.source_event_id ?? event.event_id;
            if (!this.db.prepare("SELECT 1 FROM reviewed_sources WHERE kind='daily' AND source_id=? LIMIT 1").get(sourceId))
                this.markUnit(event, 'daily', 'history');
        } }, result); } finally { await lock?.release(); }
    }
    async commitJournalResolution(resolution: JournalResolution): Promise<JournalResolutionCommit> {
        let lock:WikiLock|null=null;
        const reused=this.db.prepare('SELECT 1 FROM journal_resolutions WHERE id=? OR bundle_id=?').get(resolution.resolution_id,resolution.journal_bundle_id);
        try {
            if(!reused && (resolution.dispositions.some(d=>['already_present','not_needed'].includes(d.disposition)) || resolution.pages.some(p=>p.supersedes_operation_id))) {
                if(!this.options.reviewConfig) throw new Error('Current journal baseline validation requires review config');
                lock=await acquireWikiLock(this.options.reviewConfig.wiki_root);if(!lock) throw new Error('Journal evidence validation pending: Wiki writer lock unavailable');
                const row=this.db.prepare('SELECT json FROM journal_bundles WHERE id=?').get(resolution.journal_bundle_id);
                if(!row) throw new Error('Unknown journal work bundle');
                const bundle=JSON.parse(row.json as string) as import('../contracts/types.ts').JournalWorkBundle;
                for(const decision of resolution.dispositions.filter(d=>['already_present','not_needed'].includes(d.disposition))) {
                    const item=bundle.work.find(w=>w.work_id===decision.work_id),path=item?.payload.path;
                    if(typeof path!=='string') throw new Error('Journal disposition outside frozen work');
                    const current=await readWikiTarget(this.options.reviewConfig.wiki_root,path);
                    if(current.digest!==bundle.baselines.find(b=>b.path===path)?.digest) throw new Error('Current journal baseline changed; prepare again');
                }
            }
            return commitJournalResolution({db:this.db,config:this.options.reviewConfig,wikiLockHeld:lock!==null,transaction:fn=>this.transaction(fn),effective:()=>this.effective(),allocateId:namespace=>this.allocateId(namespace)},resolution);
        } finally { await lock?.release(); }
    }
    inventoryReviewRisks(request:ReviewRiskRequest) {return Promise.resolve(inventoryReviewRisks(this.db,request));}
    async reassessJournalPublication(request:import('../contracts/types.ts').JournalReassessmentRequest):Promise<import('../contracts/types.ts').JournalReassessmentReceipt> {
        version(request);utc(request.created_at);
        if(!Array.isArray(request.work_ids)||request.work_ids.length<1||request.work_ids.length>100)throw new Error('Reassessment requires 1–100 selected IDs');
        let lock:WikiLock|null=null;
        try {
            if(request.mode==='apply'&&this.options.reviewConfig)lock=await acquireWikiLock(this.options.reviewConfig.wiki_root);
            const targetDigests=new Map<string,string>();
            for(const id of request.work_ids){const row=this.db.prepare("SELECT json_extract(json,'$.payload.path') AS path FROM work WHERE id=? AND kind='journal_publication'").get(id) as {path:string}|undefined;if(row&&this.options.reviewConfig)try{targetDigests.set(row.path,(await readWikiTarget(this.options.reviewConfig.wiki_root,row.path)).digest);}catch{/* Unavailable exact target remains ineligible. */}}
            return this.transaction(()=>{const plan=reassessmentPlan(this.db,request,targetDigests);return request.mode==='preview'?plan.receipt:applyReassessment(this.db,request,plan,item=>this.putWork(item));});
        }finally{await lock?.release();}
    }
    async inventoryAcceptedDaily(request:AcceptedDailyInventoryRequest):Promise<AcceptedDailyInventory> {
        rangeCheck({schema_version:1,from:request.from,to:request.to});
        const limit=request.limit ?? 20; if(!Number.isSafeInteger(limit)||limit<1||limit>100) throw new Error('Accepted daily inventory limit must be 1–100');
        if(request.after_result_id && !this.db.prepare('SELECT 1 FROM results WHERE id=?').get(request.after_result_id)) throw new Error('Unknown accepted daily inventory cursor');
        const selected=this.db.prepare("SELECT r.id AS result_id,b.id AS bundle_id FROM results r JOIN bundles b ON b.id=r.bundle_id LEFT JOIN acceptance_times t ON t.result_id=r.id WHERE b.kind='daily' AND ((t.accepted_at>=? AND t.accepted_at<?) OR (?=1 AND t.accepted_at IS NULL)) AND r.rowid>COALESCE((SELECT rowid FROM results WHERE id=?),0) ORDER BY r.rowid LIMIT ?").all(normalized(request.from),normalized(request.to),request.include_unknown_acceptance===false?0:1,request.after_result_id ?? null,limit+1) as {result_id:string;bundle_id:string}[];
        for(const item of selected) this.assertMaterialReadAllowed(item.bundle_id);
        const rows=this.db.prepare("SELECT r.id,r.json,r.commit_json,b.json AS bundle_json,t.accepted_at FROM results r JOIN bundles b ON b.id=r.bundle_id LEFT JOIN acceptance_times t ON t.result_id=r.id WHERE r.id IN (SELECT value FROM json_each(?)) ORDER BY r.rowid").all(canonical(selected.map(item=>item.result_id))) as any[];
        const conflicts=await this.listJournalConflicts();
        const items=rows.slice(0,limit).map(row=>{
            const result=JSON.parse(row.json) as ReviewResult,commit=JSON.parse(row.commit_json) as ReviewCommit;
            const facts=this.lookupFactRevisions(commit.facts),targets=this.lookupFactRevisions(facts.flatMap(f=>f.target_refs));
            const patches=commit.patches.map(patch=>{const state=this.db.prepare('SELECT status,reason FROM patches WHERE id=?').get(patch.operation_id) as any;return {patch,status:state?.status ?? 'missing',reason:state?.reason ?? null};});
            return {result_id:row.id,accepted_at:{schema_version:1 as const,value:row.accepted_at ?? null,reason:row.accepted_at?null:'Legacy accepted result has no measured transaction acceptance time'},result_created_at:result.created_at,acceptance_time_basis:row.accepted_at?'store_transaction_clock' as const:'unknown_legacy_result_time' as const,window_membership:row.accepted_at?'included' as const:'unknown' as const,bundle:JSON.parse(row.bundle_json),result,commit,facts,targets,patches,conflicts:conflicts.filter(c=>commit.patches.some(p=>p.operation_id===c.operation_id))};
        });
        return {schema_version:1,items,next_result_id:rows.length>limit?items.at(-1)!.result_id:null};
    }
    async recoverJournalPublication(request:JournalRecoveryRequest):Promise<{schema_version:1;result_ids:string[];work_ids:string[]}> {
        version(request);utc(request.created_at);unique(request.result_ids,'journal recovery result IDs');
        if(!request.result_ids.length || request.result_ids.length>100) throw new Error('Journal recovery requires 1–100 explicit accepted results');
        return this.transaction(()=>{
            const ids:string[]=[];
            for(const id of request.result_ids) {
                const metadata=this.db.prepare("SELECT b.id AS bundle_id FROM results r JOIN bundles b ON b.id=r.bundle_id WHERE r.id=? AND b.kind='daily'").get(id) as {bundle_id:string}|undefined;
                if(!metadata) throw new Error('Journal recovery requires an existing accepted daily result');
                this.assertMaterialReadAllowed(metadata.bundle_id);
            }
            for(const id of request.result_ids) {
                const row=this.db.prepare("SELECT r.json,r.commit_json,b.json AS bundle_json FROM results r JOIN bundles b ON b.id=r.bundle_id WHERE r.id=? AND b.kind='daily'").get(id) as any;
                if(!row) throw new Error('Journal recovery requires an existing accepted daily result');
                const result=JSON.parse(row.json) as ReviewResult,commit=JSON.parse(row.commit_json) as ReviewCommit,bundle=JSON.parse(row.bundle_json) as ReviewBundle;
                const refs=new Map<string,FactRef[]>(),remaining=[...commit.facts];
                for(const candidate of result.candidates) {
                    if(candidate.disposition==='keep') {refs.set(candidate.candidate_id,candidate.target_refs);continue;}
                    const index=remaining.findIndex(f=>f.content===candidate.content && f.action===(candidate.disposition==='add'?'assert':candidate.disposition) && canonical(f.target_refs)===canonical(candidate.target_refs));
                    if(index>=0) {const fact=remaining.splice(index,1)[0]!;refs.set(candidate.candidate_id,[{schema_version:1,fact_id:fact.fact_id,revision:fact.revision}]);}
                }
                if(remaining.length) throw new Error('Accepted candidate allocation cannot be reconstructed exactly');
                ids.push(...queueAcceptedJournalWork(this.db,{...bundle,cutoff:request.created_at},result,commit.facts,commit.patches,refs,item=>this.putWork(item),this.journalTimezone));
                for(const patch of commit.patches) {
                    const state=this.db.prepare('SELECT status FROM patches WHERE id=?').get(patch.operation_id) as any;
                    const intent=this.db.prepare('SELECT state FROM intents WHERE id=?').get(patch.operation_id) as any;
                    if(['applied','noop'].includes(state?.status)||intent?.state==='applied') this.closeJournalOperation(patch.operation_id);
                }
            }
            return {schema_version:1,result_ids:[...request.result_ids],work_ids:[...new Set(ids)]};
        });
    }
    async listJournalConflicts(): Promise<FileOutcome[]> { return journalConflicts(this.db); }
    private operationTerminalRef(id:string):string|null { const row=this.db.prepare("SELECT replacement_id AS ref FROM operation_supersessions WHERE original_id=? UNION ALL SELECT 'terminal:'||audit_ref AS ref FROM operation_terminals WHERE original_id=? LIMIT 1").get(id,id) as any;return row?.ref ?? null; }
    async getOperationSupersession(id:string): Promise<string|null> { return this.operationTerminalRef(id); }
    async listPendingPatches(): Promise<JournalPatch[]> { return this.db.prepare("SELECT json FROM patches WHERE status IN ('pending','conflict') AND NOT EXISTS(SELECT 1 FROM operation_supersessions s WHERE s.original_id=patches.id) ORDER BY rowid").all().map(parse<JournalPatch>); }
    async markPatchStatus(id: string, status: FileStatus, reason: string | null = null) {
        if (!['applied', 'noop', 'pending', 'conflict'].includes(status))
            throw new Error('Invalid patch status');
        this.transaction(()=>{
            if (this.operationTerminalRef(id)) throw new Error('Superseded operation is terminal');
            const row = this.db.prepare('UPDATE patches SET status=?,reason=? WHERE id=?').run(status, reason, id);
            if (!row.changes) throw new Error('Unknown patch');
            if (status === 'applied' || status === 'noop') this.closeJournalOperation(id);
        });
    }
    private closeJournalOperation(id:string): void {
        for (const row of this.db.prepare("SELECT json FROM work WHERE kind='journal_publication' AND state!='complete' AND json_extract(json,'$.payload.operation_id')=?").all(id)) {
            const item=parse<WorkItem>(row); updateJournalWork(this.db,{...item,state:'complete',reason:null});
        }
        const intent=this.db.prepare("SELECT json FROM intents WHERE id=? AND state='applied'").get(id);
        if(intent) {
            const applied=parse<FileIntent>(intent);
            for(const row of this.db.prepare("SELECT json FROM work WHERE kind='journal_confirmation' AND state!='complete' AND json_extract(json,'$.payload.proposal.operation_id')=?").all(id)) {
                const item=parse<WorkItem>(row),proposal=item.payload.proposal as import('../contracts/types.ts').JournalConfirmationProposal;
                if(proposal.state==='confirmed'&&proposal.baseline_digest===applied.baseline_digest&&proposal.desired_digest===applied.desired_digest)updateJournalWork(this.db,{...item,state:'complete',reason:'Confirmed exact file intent was published'});
            }
        }
    }
    async readEffectiveFacts(query: FactQuery): Promise<FactRevision[]> {
        rangeCheck(query.range);
        if (query.as_of)
            utc(query.as_of);
        return this.effective(query.as_of).filter(f => { const time = f.occurred_at.value ?? (f.journal_date.value ? f.journal_date.value + 'T12:00:00Z' : null); return time !== null && normalized(time) >= normalized(query.range.from) && normalized(time) < normalized(query.range.to) && (!query.scope?.length || query.scope.some(s => f.scope.includes(s))); });
    }
    async listOutbox(status?: 'pending' | 'ready'): Promise<OutboxEntry[]> { return this.db.prepare('SELECT * FROM outbox' + (status ? ' WHERE status=?' : '') + ' ORDER BY rowid').all(...(status ? [status] : [])).map((r: any) => ({ schema_version: 1, batch_id: r.id, artifact: parse<FactArtifact>(r), status: r.status, export_path: r.export_path })); }
    async getPublicationOutbox(batch_id:string):Promise<OutboxEntry|null> {
        const row=this.db.prepare('SELECT id,json,status,export_path FROM outbox WHERE id=?').get(batch_id) as any;
        return row?{schema_version:1,batch_id:row.id,artifact:parse<FactArtifact>(row),status:row.status,export_path:row.export_path}:null;
    }
    async listPublicationOutbox(request:import('../contracts/types.ts').PublicationOutboxPageRequest) {return outboxPage(this.db,request);}
    async listPublicationFileIntents(request:import('../contracts/types.ts').PublicationFilePageRequest) {return filePage(this.db,request);}
    async getPublicationRecoveryCursor(kind:import('../contracts/types.ts').PublicationRecoveryKind) {return recoveryCursor(this.db,kind);}
    async setPublicationRecoveryCursor(kind:import('../contracts/types.ts').PublicationRecoveryKind,cursor:string|null) {recoveryCursor(this.db,kind,cursor);}
    async monthlySemanticStatus(cutoff:string,as_of?:string) {return monthlySemanticStatus(this.db,cutoff,as_of ?? (this.options.now?.() ?? new Date()).toISOString(),this.options.reviewConfig?.journal_timezone ?? this.journalTimezone);}
    async markExportReady(id: string, path: string) {
        if (!isAbsolute(path))
            throw new Error('Export path must be absolute');
        const old = this.db.prepare('SELECT status,export_path FROM outbox WHERE id=?').get(id) as any;
        if (!old)
            throw new Error('Unknown batch');
        if (old.status === 'ready' && old.export_path !== path)
            throw new Error('Immutable export path conflict');
        this.db.prepare("UPDATE outbox SET status='ready',export_path=? WHERE id=?").run(path, id);
    }
    async listReadyBatches(consumer: string, limit?: number, after_batch_id?: string): Promise<FactArtifact[]> {
        if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
            throw new Error('Ready batch limit must be a positive safe integer');
        return this.db.prepare("SELECT json FROM outbox o WHERE status='ready' AND o.rowid>COALESCE((SELECT rowid FROM outbox WHERE id=?),0) AND NOT EXISTS(SELECT 1 FROM acks a WHERE a.batch_id=o.id AND a.consumer=?) ORDER BY o.rowid LIMIT ?")
            .all(after_batch_id ?? null, consumer, limit ?? -1).map(parse<FactArtifact>);
    }
    async acknowledgeConsumer(ack: ConsumerAck) {
        version(ack);
        utc(ack.acknowledged_at);
        const row = this.db.prepare('SELECT status FROM outbox WHERE id=?').get(ack.batch_id) as any;
        if (row?.status !== 'ready')
            throw new Error('Cannot acknowledge unready batch');
        this.db.prepare('INSERT OR IGNORE INTO acks VALUES(?,?,?)').run(ack.consumer, ack.batch_id, canonical(ack));
    }
    async saveFileIntent(intent: FileIntent) {
        version(intent);
        utc(intent.created_at);
        if ((intent.desired_bytes_base64 === null ? 'absent' : digest(Buffer.from(intent.desired_bytes_base64, 'base64'))) !== intent.desired_digest || (intent.backup_bytes_base64 === null ? 'absent' : digest(Buffer.from(intent.backup_bytes_base64, 'base64'))) !== intent.baseline_digest)
            throw new Error('Intent bytes do not match digests');
        this.transaction(() => {
            if (this.operationTerminalRef(intent.operation_id)) throw new Error('Superseded operation is terminal');
            const row = this.db.prepare('SELECT json FROM intents WHERE id=?').get(intent.operation_id);
            const old = row ? parse<FileIntent>(row) : null;
            if (old) {
                const shape = (v: FileIntent) => ({ ...v, state: null, reason: null });
                if (canonical(shape(old)) !== canonical(shape(intent)))
                    throw new Error('File intent identity conflict');
                return;
            }
            if(intent.supersedes_operation_id) supersedeOperation(this.db,intent.supersedes_operation_id,intent.operation_id,intent.path,intent.created_at);
            this.db.prepare('INSERT INTO intents VALUES(?,?,?)').run(intent.operation_id, canonical(intent), intent.state);
        });
    }
    async getFileIntent(id: string): Promise<FileIntent | null> { const row = this.db.prepare('SELECT json FROM intents WHERE id=?').get(id); return row ? parse(row) : null; }
    async listFileIntents(states?: FileIntent['state'][]): Promise<FileIntent[]> {
        if (states?.length === 0)
            return [];
        return this.db.prepare('SELECT json FROM intents WHERE NOT EXISTS(SELECT 1 FROM operation_supersessions s WHERE s.original_id=intents.id) AND NOT EXISTS(SELECT 1 FROM operation_terminals t WHERE t.original_id=intents.id)' + (states ? ' AND state IN(' + states.map(() => '?').join(',') + ')' : '') + ' ORDER BY rowid').all(...(states ?? [])).map(parse<FileIntent>);
    }
    async updateFileIntent(id: string, state: FileIntent['state'], reason: string | null = null) {
        const intent = await this.getFileIntent(id);
        if (!intent)
            throw new Error('Unknown file intent');
        if (!['prepared', 'applied', 'pending', 'conflict'].includes(state))
            throw new Error('Invalid intent state');
        this.transaction(()=>{
            if (this.operationTerminalRef(id)) throw new Error('Superseded operation is terminal');
            this.db.prepare('UPDATE intents SET json=?,state=? WHERE id=?').run(canonical({ ...intent, state, reason }), state, id);
            if(state==='applied') this.closeJournalOperation(id);
        });
    }
    private putWork(item: WorkItem) {
        version(item);
        utc(item.updated_at);
        const old = this.db.prepare('SELECT json FROM work WHERE id=? OR (migration_key IS NOT NULL AND migration_key=?)').get(item.work_id, item.migration_key) as any;
        if (old) {
            const previous = parse<WorkItem>(old);
            if (previous.kind !== item.kind || previous.lane !== item.lane || canonical(previous.payload) !== canonical(item.payload))
                throw new Error('Work identity conflict');
            return;
        }
        this.db.prepare('INSERT INTO work VALUES(?,?,?,?,?)').run(item.work_id, canonical(item), item.kind, item.state, item.migration_key);
    }
    async enqueueWork(item: WorkItem) { this.putWork(item); }
    async listWork(kind?: string, state?: WorkItem['state']): Promise<WorkItem[]> {
        if(kind===undefined||kind==='journal_publication'||kind==='journal_confirmation')this.transaction(()=>refreshStaleConfirmationFacts(this.db,(this.options.now?.()??new Date()).toISOString()));
        const clauses: string[] = [];
        const args: string[] = [];
        if (kind) {
            clauses.push('kind=?');
            args.push(kind);
        }
        if (state) {
            clauses.push('state=?');
            args.push(state);
        }
        return this.db.prepare('SELECT json FROM work' + (clauses.length ? ' WHERE ' + clauses.join(' AND ') : '') + ' ORDER BY rowid').all(...args).map(parse<WorkItem>);
    }
    async completeJournalDisplay(workIds: string[], publicationOperationId: string, lock: WikiLock): Promise<void> {
        unique(workIds, 'journal display work');
        if (!workIds.length || !publicationOperationId?.trim()) throw new Error('Journal display requires exact work and publication identities');
        const config = this.options.reviewConfig;
        if (!config || lock.root !== await realpath(config.wiki_root)) throw new Error('Journal display requires the configured Wiki writer lock');
        await assertWikiLockHeld(lock);
        const intent = await this.getFileIntent(publicationOperationId);
        if (!intent || intent.state !== 'applied' || intent.desired_bytes_base64 === null || this.operationTerminalRef(publicationOperationId)) throw new Error('Journal display requires an applied publication intent');
        const target = await readWikiTarget(config.wiki_root, intent.path);
        if (target.digest !== intent.desired_digest || digest(Buffer.from(intent.desired_bytes_base64, 'base64')) !== intent.desired_digest) throw new Error('Current journal display differs from applied publication intent');
        await assertWikiLockHeld(lock);
        this.transaction(() => {
            const currentIntent = this.db.prepare('SELECT json,state FROM intents WHERE id=?').get(publicationOperationId);
            if (!currentIntent || currentIntent.state !== 'applied' || currentIntent.json !== canonical(intent) || this.operationTerminalRef(publicationOperationId)) throw new Error('Journal publication intent changed');
            const selected = workIds.map(id => {
                const row = this.db.prepare('SELECT json FROM work WHERE id=?').get(id);
                if (!row) throw new Error('Unknown journal display work');
                const work = parse<WorkItem>(row);
                if (work.kind !== 'journal_publication') throw new Error('Journal display requires exact journal publication work');
                const payload = journalPayload(work);
                const monthly = payload.date ? `wiki/personal/journals/reviews/回顾_${payload.date.slice(0, 7).replace('-', '_')}.md` : null;
                if (!payload.path || !payload.date || (intent.path !== payload.path && intent.path !== monthly) || !intent.fact_refs.some(ref => refKey(ref) === refKey(payload.fact_ref)) || !this.lookupFactRevisions([payload.fact_ref]).length) throw new Error('Applied journal display does not represent the exact work target/revision');
                return work;
            });
            const at = (this.options.now?.() ?? new Date()).toISOString();
            for (const work of selected) {
                if (work.state !== 'complete') updateJournalWork(this.db, { ...work, state: 'complete', payload: { ...work.payload, display_operation_id: publicationOperationId }, reason: 'Verified derived journal display', updated_at: at });
            }
            for (const id of new Set(selected.map(work => journalPayload(work).operation_id).filter((id): id is string => !!id))) terminalizeJournalOperation(this.db, id, publicationOperationId, 'Verified derived display completed every linked exact journal debt', at);
        });
    }
    async completeWork(id: string) {
        const row = this.db.prepare('SELECT json FROM work WHERE id=?').get(id);
        if (!row)
            throw new Error('Unknown work item');
        const work = parse<WorkItem>(row);
        this.db.prepare("UPDATE work SET json=?,state='complete' WHERE id=?").run(canonical({ ...work, state: 'complete' }), id);
    }
    async importLegacy(batch: LegacyImportBatch): Promise<LegacyImportResult> {
        version(batch);
        if (!batch.migration_key)
            throw new Error('Missing migration key');
        return this.transaction(() => {
            const old = this.db.prepare('SELECT * FROM imports WHERE migration_key=?').get(batch.migration_key) as any;
            if (old) {
                if (old.json !== canonical(batch))
                    throw new Error('Legacy migration identity conflict');
                return { ...JSON.parse(old.result_json), reused: true };
            }
            unique(batch.mappings.map(m => m.source_id), 'legacy mapping IDs');
            let unresolved = 0;
            for (const mapping of batch.mappings) {
                version(mapping);
                if (mapping.confidence === 'verified' && !mapping.target_id)
                    throw new Error('Verified mapping requires target');
                const previous = this.db.prepare('SELECT json FROM legacy_mappings WHERE source_id=?').get(mapping.source_id) as any;
                if (previous && previous.json !== canonical(mapping))
                    throw new Error('Legacy mapping conflict');
                this.db.prepare('INSERT OR IGNORE INTO legacy_mappings VALUES(?,?)').run(mapping.source_id, canonical(mapping));
                if (mapping.confidence === 'unresolved')
                    unresolved++;
            }
            const facts: FactRevision[] = [];
            for (const input of batch.facts) {
                version(input);
                utc(input.recorded_at);
                if (input.occurred_at.value)
                    utc(input.occurred_at.value);
                if (!Number.isSafeInteger(input.revision) || input.revision < 1)
                    throw new Error('Invalid fact revision');
                const verified = batch.mappings.some(m => m.confidence === 'verified' && m.target_id === input.fact_id);
                const fact = { ...input, kind: verified ? input.kind : 'legacy_record' as const, attribution: { ...input.attribution, legacy_verified: verified } };
                const previous = this.db.prepare('SELECT json FROM facts WHERE id=? AND revision=?').get(fact.fact_id, fact.revision) as any;
                if (previous && previous.json !== canonical(fact))
                    throw new Error('Legacy fact identity conflict');
                if (!previous) {
                    this.db.prepare('INSERT INTO facts VALUES(?,?,?,?)').run(fact.fact_id, fact.revision, canonical(fact), normalized(fact.recorded_at));
                    facts.push(fact);
                }
            }
            for (const work of batch.work)
                this.putWork(work);
            if (unresolved)
                this.putWork({ schema_version: 1, work_id: this.allocateId('work'), kind: 'legacy_mapping', lane: 'history', state: 'pending', payload: { migration_key: batch.migration_key, mappings: batch.mappings.filter(m => m.confidence === 'unresolved') }, reason: 'Legacy IDs require reconciliation; confirmations must not transfer', migration_key: batch.migration_key + ':mappings', updated_at: new Date().toISOString() });
            const batchId = 'legacy:' + digest(batch.migration_key);
            const dates = [...new Set(facts.flatMap(f => f.journal_date.value ? [f.journal_date.value] : []))].sort();
            const artifact: FactArtifact = { schema_version: 1, batch_id: batchId, created_at: new Date().toISOString(), facts, coverage: [], affected_dates: dates, affected_weeks: [...new Set(dates.map(weekFor))] };
            this.db.prepare('INSERT INTO outbox VALUES(?,?,?,NULL)').run(batchId, canonical(artifact), 'pending');
            const result: LegacyImportResult = { schema_version: 1, migration_key: batch.migration_key, reused: false, imported_facts: facts.length, unresolved };
            this.db.prepare('INSERT INTO imports VALUES(?,?,?)').run(batch.migration_key, canonical(batch), canonical(result));
            return result;
        });
    }
    async status(): Promise<Record<string, unknown>> {
        const counts: Record<string, unknown> = { schema_version: 1 };
        for (const table of ['events', 'facts', 'results', 'outbox', 'patches', 'work'])
            counts[table] = (this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as any).count;
        counts.pending_exports = (this.db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE status='pending'").get() as any).count;
        counts.pending_patches = (this.db.prepare("SELECT COUNT(*) AS count FROM patches WHERE status='pending'").get() as any).count;
        counts.conflicting_patches = (this.db.prepare("SELECT COUNT(*) AS count FROM patches WHERE status='conflict'").get() as any).count;
        counts.journal_publication={pending:(this.db.prepare("SELECT COUNT(*) AS count FROM work WHERE kind='journal_publication' AND state!='complete'").get() as any).count,conflict:(await this.listJournalConflicts()).length,unresolved:(this.db.prepare("SELECT COUNT(*) AS count FROM work WHERE kind='journal_publication' AND state!='complete' AND (state='deferred' OR json_extract(json,'$.payload.disposition') IS NULL)").get() as any).count};
        const reviewDebt = (provider?: string, account?: string) => this.db.prepare(`WITH debt AS (
            SELECT e.time,review_read_allowed(e.id)=0 AS read_excluded,(${scopeSql('e')} OR ${pendingScopeSql('e')} IS NOT NULL) AS in_scope,
                (review_read_allowed(e.id)=1 AND e.classification='main' AND e.time IS NOT NULL AND ${scopeSql('e')} AND COALESCE(${senderSql('e')},0)) AS metadata_ready,
                (COALESCE(json_extract(e.json,'$.context.incomplete_turn'),0)!=1 AND (json_extract(e.json,'$.role')='user' OR COALESCE(json_extract(e.json,'$.context.turn_complete'),1)!=0)) AS turn_ready
            FROM events e WHERE e.classification IN ('main','unknown') AND COALESCE(json_extract(e.json,'$.context.context_only'),0)!=1
                AND NOT EXISTS(SELECT 1 FROM reviewed_sources r WHERE r.kind='daily' AND r.source_id=e.id)
                ${provider === undefined ? '' : "AND json_extract(e.json,'$.source.provider')=? AND json_extract(e.json,'$.source.account_id')=?"}
        ) SELECT COUNT(*) AS retained_unreviewed_events,
            COUNT(CASE WHEN NOT in_scope THEN 1 END) AS excluded_unreviewed_events,
            COUNT(CASE WHEN read_excluded THEN 1 END) AS read_excluded_unreviewed_events,
            COUNT(CASE WHEN in_scope AND NOT read_excluded AND NOT metadata_ready THEN 1 END) AS blocked_metadata_pending,
            COUNT(CASE WHEN metadata_ready AND NOT turn_ready THEN 1 END) AS incomplete_turn_pending,
            COUNT(CASE WHEN metadata_ready AND turn_ready THEN 1 END) AS eligible_pending,
            MIN(CASE WHEN metadata_ready AND turn_ready THEN time END) AS oldest_eligible_unreviewed_at
        FROM debt`).get(...(provider === undefined ? [] : [provider, account ?? null])) as {retained_unreviewed_events:number;excluded_unreviewed_events:number;blocked_metadata_pending:number;incomplete_turn_pending:number;eligible_pending:number;oldest_eligible_unreviewed_at:string|null};
        const {oldest_eligible_unreviewed_at: _oldestEligible, ...review} = reviewDebt();
        counts.review={accepted_results:counts.results,unreviewed_events:review.eligible_pending,...review};
        counts.review_read_exclusions=this.reviewReadExclusions();
        counts.fact={revisions:counts.facts,pending_exports:counts.pending_exports};
        counts.page={pending:counts.pending_patches,conflict:counts.conflicting_patches,applied:(this.db.prepare("SELECT COUNT(*) AS count FROM patches WHERE status IN ('applied','noop')").get() as any).count};
        counts.coverage = this.db.prepare('SELECT json FROM coverage ORDER BY id').all().map(parse<SourceCoverage>);
        const identities=new Map<string,{provider:string;account_id:string;enabled?:boolean}>();
        for(const provider of this.options.reviewConfig?.providers ?? []) identities.set(canonical([provider.provider,provider.account_id]),provider);
        for(const item of counts.coverage as SourceCoverage[]) identities.set(canonical([item.provider,item.account_id]),{...identities.get(canonical([item.provider,item.account_id])),provider:item.provider,account_id:item.account_id});
        counts.sources=[...identities.values()].map(source=>{
            const coverage=(counts.coverage as SourceCoverage[]).filter(c=>c.provider===source.provider && c.account_id===source.account_id).sort((a,b)=>normalized(b.cutoff).localeCompare(normalized(a.cutoff)));
            const latest=new Map<string,SourceCoverage>(); for(const item of coverage) {const key=canonical([item.lane,item.conversation_id]);if(!latest.has(key))latest.set(key,item);}
            const states=[...latest.values()].map(c=>c.capture_status);
            const capture_status=source.enabled===false?'disabled':!states.length?'unknown':states.every(s=>s==='complete')?'complete':states.includes('partial')||states.includes('complete')?'partial':states[0];
            const read=this.db.prepare('SELECT last_read_at FROM source_reads WHERE provider=? AND account_id=?').get(source.provider,source.account_id) as any;
            const {oldest_eligible_unreviewed_at: time, ...sourceReview} = reviewDebt(source.provider, source.account_id);
            const oldest={schema_version:1,value:time,reason:time?null:'No eligible unreviewed event; blocked metadata, incomplete turns and unread capture remain independent'};
            const checkpoints=this.db.prepare("SELECT json FROM checkpoints WHERE provider=? AND json_extract(json,'$.cursor.account_id')=? AND json_extract(json,'$.cursor.manual_capture_scope') IS NULL").all(source.provider,source.account_id).map(parse<SourceCheckpoint>);
            const files=checkpoints.filter(cp=>cp.locator!=='@discovery' && Number.isSafeInteger(cp.cursor.unread_bytes) && (cp.cursor.unread_bytes as number)>=0);
            const newest=new Map<string,SourceCheckpoint>();
            for(const cp of files) {
                const key=String(cp.cursor.identity ?? cp.locator),old=newest.get(key);
                const at=String(cp.cursor.last_read_at ?? cp.updated_at),prior=old?String(old.cursor.last_read_at ?? old.updated_at):null;
                if(!old || normalized(at)>normalized(prior!)) newest.set(key,cp);
            }
            const observed=new Map<string,number>();
            for(const cp of files) {const key=String(cp.cursor.identity ?? cp.locator),selected=newest.get(key)!;if(cp.generation===selected.generation && cp.cursor.source_scope===selected.cursor.source_scope)observed.set(key,Math.max(observed.get(key) ?? 0,cp.cursor.unread_bytes as number));}
            return {schema_version:1,provider:source.provider,account_id:source.account_id,capture_status,last_read_at:read?.last_read_at ?? null,unread:{schema_version:1,value:null,reason:'Total unread bytes are unknown; retained checkpoints do not prove current complete discovery and global source scope'},known_file_unread_bytes:{schema_version:1,value:observed.size?[...observed.values()].reduce((sum,n)=>sum+n,0):null,reason:observed.size?'Last observed unscoped known-file bytes only; latest observed generation/scope per source identity, conservative across lanes, not a global current-source total':'No measured ordinary known-file checkpoint'},review:sourceReview,oldest_unreviewed_at:oldest,oldest_eligible_unreviewed_at:oldest,gaps:[...latest.values()].flatMap(c=>c.gaps)};
        });
        return counts;
    }
    async backup(outputDir: string): Promise<{
        path: string;
        sha256: string;
    }> {
        if (!isAbsolute(outputDir))
            throw new Error('Backup output directory must be absolute');
        await mkdir(outputDir, { recursive: true, mode: 0o700 });
        const path = join(outputDir, 'bookkeeping-' + randomUUID() + '.sqlite');
        this.db.prepare('VACUUM INTO ?').run(path);
        await chmod(path, 0o600);
        return { path, sha256: await fileSha256(path) };
    }
}
export async function createStore(config: BookkeepingConfig, options: StoreOptions = {}): Promise<SqliteStore> {
    if (!isAbsolute(config.data_dir) || !isAbsolute(config.wiki_root))
        throw new Error('data_dir/wiki_root must be absolute');
    await mkdir(config.data_dir, { recursive: true, mode: 0o700 });
    const store = new SqliteStore(join(config.data_dir, 'bookkeeping.sqlite'), { ...options, reviewConfig: config }, config.journal_timezone);
    await chmod(store.path, 0o600);
    return store;
}
/** Restore into a new empty directory, validating the consistent snapshot first. */
export async function restoreStore(input: string, dataDir: string): Promise<{
    path: string;
    sha256: string;
}> {
    if (!isAbsolute(input) || !isAbsolute(dataDir))
        throw new Error('Restore paths must be absolute');
    const source = resolve(input);
    const probe = new DatabaseSync(source, { readOnly: true });
    try {
        const check = probe.prepare('PRAGMA integrity_check').get() as any;
        if (check.integrity_check !== 'ok')
            throw new Error('Backup integrity check failed');
        const schema = probe.prepare("SELECT value FROM metadata WHERE key='schema'").get() as any;
        if (schema?.value !== '1')
            throw new Error('Unsupported backup schema');
    }
    finally {
        probe.close();
    }
    try {
        await stat(dataDir);
        throw new Error('Restore requires a new destination directory');
    }
    catch (error: any) {
        if (error.code !== 'ENOENT')
            throw error;
    }
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const path = join(dataDir, 'bookkeeping.sqlite');
    await copyFile(source, path, 1);
    await chmod(path, 0o600);
    // An immutable batch is identified by its accepted artifact, not by a local
    // projection in the old directory. Consumer acknowledgements and semantic
    // state survive; Publisher must verify/regenerate bytes before ready here.
    const restored = new DatabaseSync(path);
    try {
        restored.exec("PRAGMA synchronous=FULL; BEGIN IMMEDIATE; UPDATE outbox SET status='pending',export_path=NULL; COMMIT;");
    }
    finally { restored.close(); }
    return { path, sha256: await fileSha256(path) };
}
