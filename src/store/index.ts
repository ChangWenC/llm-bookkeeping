import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, copyFile, stat, chmod } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { BookkeepingConfig, Store, CollectionBatch, SourceCheckpoint, Lane, EventQuery, SourceEvent, TimeRange, SourceCoverage, ReviewBundle, ReviewChunk, ReviewResult, ReviewCommit, FactRevision, FactRef, FactQuery, JournalPatch, FileStatus, OutboxEntry, FactArtifact, ConsumerAck, FileIntent, WorkItem, LegacyImportBatch, LegacyImportResult } from '../contracts/types.ts';
import { initializeSchema } from './schema.ts';
import { foldFacts } from './facts.ts';
import { validateReviewResult } from '../contracts/validation.ts';
import { commitSemanticReview } from './semantic-commit.ts';
export { canonical, digest } from '../analytics/serialization.ts';
import { canonical, digest } from '../analytics/serialization.ts';
import { AnalyticsRepository, type AnalyticsPort } from './analytics.ts';
const parse = <T>(row: any): T => JSON.parse(row.json);
export { weekFor } from './domain.ts';
import { refKey, utc, normalized, rangeCheck, version, unique, enrichEvent, factWeek, weekFor } from './domain.ts';
export interface StoreOptions {
    onTransactionStep?: (step: string) => void;
}
export class SqliteStore implements Store {
    readonly db: DatabaseSync;
    private analyticsRepositoryInstance?: AnalyticsRepository;
    analyticsPort(): AnalyticsPort { return this.analyticsRepositoryInstance ??= new AnalyticsRepository(this.db); }
    analyticsHistoryRepository(): AnalyticsRepository { this.analyticsPort(); return this.analyticsRepositoryInstance!; }
    readonly path: string;
    private readonly options: StoreOptions;
    private readonly journalTimezone: string;
    constructor(path: string, options: StoreOptions = {}, journalTimezone = 'Europe/Amsterdam') {
        this.path = path;
        this.options = options;
        this.journalTimezone = journalTimezone;
        this.db = new DatabaseSync(path);
        initializeSchema(this.db);
        if ((this.db.prepare("SELECT value FROM metadata WHERE key='schema'").get() as any).value !== '1')
            throw new Error('Unsupported database schema');
        this.analyticsRepositoryInstance = new AnalyticsRepository(this.db);
    }
    close() { this.db.close(); }
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
            for (const event of batch.events) {
                version(event);
                if (event.utc_time.value)
                    utc(event.utc_time.value);
                if (event.fragment_ref && !this.db.prepare('SELECT id FROM fragments WHERE id=?').get(event.fragment_ref))
                    throw new Error('Missing event fragment');
                const old = this.db.prepare('SELECT json FROM events WHERE id=?').get(event.event_id) as any;
                if (old) {
                    try {
                        const enriched = enrichEvent(parse<SourceEvent>(old), event);
                        this.db.prepare('UPDATE events SET json=?,time=?,classification=? WHERE id=?').run(canonical(enriched), enriched.utc_time.value ? normalized(enriched.utc_time.value) : null, enriched.classification, event.event_id);
                        if (enriched.utc_time.value && enriched.journal_date.value && enriched.classification !== 'unknown') {
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
                const lanes = batch.coverage.filter(c => c.provider === event.source.provider && c.account_id === event.source.account_id && (!c.conversation_id || c.conversation_id === event.source.conversation_id)).map(c => c.lane);
                for (const lane of new Set(lanes.length ? lanes : batch.checkpoints.map(c => c.lane)))
                    this.db.prepare('INSERT OR IGNORE INTO event_lanes VALUES(?,?)').run(event.event_id, lane);
                if (!event.utc_time.value || !event.journal_date.value || event.classification === 'unknown')
                    this.putWork({ schema_version: 1, work_id: 'event-gap:' + digest(event.event_id), kind: 'event_identity_time', lane: lanes.includes('live') ? 'live' : 'history', state: 'pending', payload: { event_id: event.event_id }, reason: 'Event identity/time/journal date needs resolution', migration_key: null, updated_at: new Date().toISOString() });
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
        let clause = 'time>=? AND time<?';
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
        return this.db.prepare(`SELECT json FROM events WHERE ${clause} ORDER BY time,ordering,id LIMIT ?`).all(...params).map(parse<SourceEvent>);
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
    async getBundle(id: string): Promise<ReviewBundle | null> { const row = this.db.prepare('SELECT json FROM bundles WHERE id=?').get(id); return row ? parse(row) : null; }
    async listPendingChunks(range: TimeRange, lane: Lane): Promise<ReviewChunk[]> { rangeCheck(range); return this.db.prepare("SELECT json FROM chunks WHERE lane=? AND state!='complete' AND (from_time IS NULL OR (from_time<? AND to_time>=?)) ORDER BY id").all(lane, normalized(range.to), normalized(range.from)).map(parse<ReviewChunk>); }
    getReviewedUnits(kind: string, lane: Lane): Set<string> { return new Set(this.db.prepare('SELECT event_id FROM reviewed_units WHERE kind=? AND lane=?').all(kind, lane).map((r: any) => r.event_id)); }
    getReviewedSpans(kind: string, lane: Lane, sourceId: string): {
        start_byte: number;
        end_byte: number;
    }[] {
        return this.db.prepare('SELECT start_byte,end_byte FROM reviewed_spans WHERE kind=? AND lane=? AND source_id=? ORDER BY start_byte,end_byte').all(kind, lane, sourceId) as any[];
    }
    async getReviewableEvents(query: EventQuery, kind: string): Promise<SourceEvent[]> {
        rangeCheck(query.range);
        return this.db.prepare("SELECT e.json FROM events e WHERE e.time>=? AND e.time<? AND e.classification='main' AND COALESCE(json_extract(e.json,'$.context.context_only'),0)!=1 AND EXISTS(SELECT 1 FROM event_lanes l WHERE l.event_id=e.id AND l.lane=?) AND NOT EXISTS(SELECT 1 FROM reviewed_sources r WHERE r.source_id=e.id AND r.kind=? AND r.lane=?) ORDER BY e.time,e.ordering,e.id LIMIT ?").all(normalized(query.range.from), normalized(query.range.to), query.lane!, kind, query.lane!, query.limit ?? 1000).map(parse<SourceEvent>);
    }
    getContextEvents(event: SourceEvent): SourceEvent[] {
        if (!event.utc_time.value)
            return [];
        const originalId = (event.context.review_slice as any)?.source_event_id ?? event.event_id;
        const group = event.source.conversation_id?.endsWith('@chatroom') || event.context.is_group === true;
        if (group) {
            const anchor = Date.parse(event.utc_time.value);
            return this.db.prepare("SELECT json FROM events WHERE json_extract(json,'$.source.provider')=? AND json_extract(json,'$.source.account_id')=? AND json_extract(json,'$.source.conversation_id')=? AND time>=? AND time<=? AND id!=? AND classification='main' ORDER BY ABS(julianday(time)-julianday(?)),time,ordering,id LIMIT 12")
                .all(event.source.provider, event.source.account_id, event.source.conversation_id, normalized(new Date(anchor - 20 * 60000).toISOString()), normalized(new Date(anchor + 20 * 60000).toISOString()), originalId, normalized(event.utc_time.value))
                .map(parse<SourceEvent>).sort((a, b) => normalized(a.utc_time.value!).localeCompare(normalized(b.utc_time.value!)) || a.physical_order.localeCompare(b.physical_order));
        }
        return this.db.prepare("SELECT json FROM events WHERE json_extract(json,'$.source.provider')=? AND json_extract(json,'$.source.account_id')=? AND json_extract(json,'$.source.conversation_id')=? AND (time,ordering,id)<(?,?,?) AND id!=? AND classification='main' ORDER BY time DESC,ordering DESC,id DESC LIMIT 3")
            .all(event.source.provider, event.source.account_id, event.source.conversation_id, normalized(event.utc_time.value), event.physical_order, originalId, originalId).map(parse<SourceEvent>).reverse();
    }
    isContextTruncated(event: SourceEvent): boolean {
        if (!event.utc_time.value || !(event.source.conversation_id?.endsWith('@chatroom') || event.context.is_group === true))
            return false;
        const anchor = Date.parse(event.utc_time.value), originalId = (event.context.review_slice as any)?.source_event_id ?? event.event_id;
        const row = this.db.prepare("SELECT COUNT(*) AS count FROM events WHERE json_extract(json,'$.source.provider')=? AND json_extract(json,'$.source.account_id')=? AND json_extract(json,'$.source.conversation_id')=? AND time>=? AND time<=? AND id!=? AND classification='main'").get(event.source.provider, event.source.account_id, event.source.conversation_id, normalized(new Date(anchor - 20 * 60000).toISOString()), normalized(new Date(anchor + 20 * 60000).toISOString()), originalId) as any;
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
        const events = this.db.prepare("SELECT e.id FROM events e WHERE json_extract(e.json,'$.source.provider')=? AND json_extract(e.json,'$.source.account_id')=? AND (? IS NULL OR json_extract(e.json,'$.source.conversation_id')=?) AND e.classification IN ('main','unknown') AND COALESCE(json_extract(e.json,'$.context.context_only'),0)!=1 AND (e.time IS NULL OR (e.time>=? AND e.time<?)) AND EXISTS(SELECT 1 FROM event_lanes l WHERE l.event_id=e.id AND l.lane=?)").all(coverage.provider, coverage.account_id, coverage.conversation_id, coverage.conversation_id, normalized(coverage.query_range.from), normalized(coverage.query_range.to), coverage.lane) as any[];
        const done = events.filter(e => this.db.prepare('SELECT 1 FROM reviewed_sources WHERE kind=? AND lane=? AND source_id=?').get(kind, coverage.lane, e.id)).length;
        const any = events.some(e => this.db.prepare('SELECT 1 FROM reviewed_spans WHERE kind=? AND lane=? AND source_id=? LIMIT 1').get(kind, coverage.lane, e.id));
        const status = events.length ? done === events.length ? 'complete' : (done || any) ? 'partial' : 'pending' : explicitEmpty && coverage.capture_status === 'complete' && !coverage.gaps.length ? 'complete' : 'pending';
        return { ...coverage, review_status: status };
    }
    freezeFactMaterial(kind: 'weekly' | 'monthly', period: string, cutoff: string, refs: FactRef[], work_ids: string[] = []): string { utc(cutoff); const value = { schema_version: 1, kind, period, cutoff, refs, work_ids }; const id = 'fact-material:' + digest(canonical(value)); this.immutable('fact_material_snapshots', id, value); return id; }
    getFactMaterial(id: string): {
        kind: 'weekly' | 'monthly';
        period: string;
        cutoff: string;
        refs: FactRef[];
        work_ids?: string[];
    } | null { const row = this.db.prepare('SELECT json FROM fact_material_snapshots WHERE id=?').get(id); return row ? parse(row) : null; }
    getFactMaterialReads(id: string): Set<string> { return new Set(this.db.prepare('SELECT fact_id,revision FROM fact_material_reads WHERE snapshot_id=?').all(id).map((row: any) => row.fact_id + ':' + row.revision)); }
    markFactMaterialRead(id: string, refs: FactRef[]): void { const snapshot = this.getFactMaterial(id); if (!snapshot || refs.some(ref => !snapshot.refs.some(item => refKey(item) === refKey(ref))))
        throw new Error('Read fact outside frozen material snapshot'); for (const ref of refs)
        this.db.prepare('INSERT OR IGNORE INTO fact_material_reads VALUES(?,?,?)').run(id, ref.fact_id, ref.revision); }
    effectiveFactRefsAt(cutoff: string): FactRef[] { utc(cutoff); return this.effective(cutoff).map(fact => ({ schema_version: 1, fact_id: fact.fact_id, revision: fact.revision })); }
    lookupFactRevisions(refs: FactRef[]): FactRevision[] { return refs.flatMap(ref => { const row = this.db.prepare('SELECT json FROM facts WHERE id=? AND revision=?').get(ref.fact_id, ref.revision); return row ? [parse<FactRevision>(row)] : []; }); }
    async getReviewResult(id: string): Promise<ReviewResult | null> { const row = this.db.prepare('SELECT json FROM results WHERE id=?').get(id); return row ? parse(row) : null; }
    private effective(asOf?: string): FactRevision[] {
        const rows = this.db.prepare('SELECT json FROM facts WHERE recorded_at<=? ORDER BY recorded_at,rowid').all(asOf ? normalized(asOf) : '9999-12-31T23:59:59.999Z').map(parse<FactRevision>);
        return foldFacts(rows);
    }
    async commitReview(result: ReviewResult): Promise<ReviewCommit> {
        return commitSemanticReview({ db: this.db, options: this.options, journalTimezone: this.journalTimezone, transaction: fn => this.transaction(fn), effective: () => this.effective(), allocateId: namespace => this.allocateId(namespace), putWork: item => this.putWork(item), markUnit: (event, kind, lane) => this.markUnit(event, kind, lane), coverageReview: (coverage, kind, empty) => this.coverageReview(coverage, kind, empty), analyticsHistoryRepository: () => this.analyticsHistoryRepository(), markFactMaterialRead: (id, refs) => this.markFactMaterialRead(id, refs) }, result);
    }
    async listPendingPatches(): Promise<JournalPatch[]> { return this.db.prepare("SELECT json FROM patches WHERE status='pending' ORDER BY rowid").all().map(parse<JournalPatch>); }
    async markPatchStatus(id: string, status: FileStatus, reason: string | null = null) {
        if (!['applied', 'noop', 'pending', 'conflict'].includes(status))
            throw new Error('Invalid patch status');
        const row = this.db.prepare('UPDATE patches SET status=?,reason=? WHERE id=?').run(status, reason, id);
        if (!row.changes)
            throw new Error('Unknown patch');
    }
    async readEffectiveFacts(query: FactQuery): Promise<FactRevision[]> {
        rangeCheck(query.range);
        if (query.as_of)
            utc(query.as_of);
        return this.effective(query.as_of).filter(f => { const time = f.occurred_at.value ?? (f.journal_date.value ? f.journal_date.value + 'T12:00:00Z' : null); return time !== null && normalized(time) >= normalized(query.range.from) && normalized(time) < normalized(query.range.to) && (!query.scope?.length || query.scope.some(s => f.scope.includes(s))); });
    }
    async listOutbox(status?: 'pending' | 'ready'): Promise<OutboxEntry[]> { return this.db.prepare('SELECT * FROM outbox' + (status ? ' WHERE status=?' : '') + ' ORDER BY rowid').all(...(status ? [status] : [])).map((r: any) => ({ schema_version: 1, batch_id: r.id, artifact: parse<FactArtifact>(r), status: r.status, export_path: r.export_path })); }
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
    async listReadyBatches(consumer: string): Promise<FactArtifact[]> { return this.db.prepare("SELECT json FROM outbox o WHERE status='ready' AND NOT EXISTS(SELECT 1 FROM acks a WHERE a.batch_id=o.id AND a.consumer=?) ORDER BY rowid").all(consumer).map(parse<FactArtifact>); }
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
            const row = this.db.prepare('SELECT json FROM intents WHERE id=?').get(intent.operation_id);
            const old = row ? parse<FileIntent>(row) : null;
            if (old) {
                const shape = (v: FileIntent) => ({ ...v, state: null, reason: null });
                if (canonical(shape(old)) !== canonical(shape(intent)))
                    throw new Error('File intent identity conflict');
                return;
            }
            this.db.prepare('INSERT INTO intents VALUES(?,?,?)').run(intent.operation_id, canonical(intent), intent.state);
        });
    }
    async getFileIntent(id: string): Promise<FileIntent | null> { const row = this.db.prepare('SELECT json FROM intents WHERE id=?').get(id); return row ? parse(row) : null; }
    async listFileIntents(states?: FileIntent['state'][]): Promise<FileIntent[]> {
        if (states?.length === 0)
            return [];
        return this.db.prepare('SELECT json FROM intents' + (states ? ' WHERE state IN(' + states.map(() => '?').join(',') + ')' : '') + ' ORDER BY rowid').all(...(states ?? [])).map(parse<FileIntent>);
    }
    async updateFileIntent(id: string, state: FileIntent['state'], reason: string | null = null) {
        const intent = await this.getFileIntent(id);
        if (!intent)
            throw new Error('Unknown file intent');
        if (!['prepared', 'applied', 'pending', 'conflict'].includes(state))
            throw new Error('Invalid intent state');
        this.db.prepare('UPDATE intents SET json=?,state=? WHERE id=?').run(canonical({ ...intent, state, reason }), state, id);
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
        counts.coverage = this.db.prepare('SELECT json FROM coverage ORDER BY id').all().map(parse<SourceCoverage>);
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
        return { path, sha256: digest(await readFile(path)) };
    }
}
export async function createStore(config: BookkeepingConfig, options: StoreOptions = {}): Promise<SqliteStore> {
    if (!isAbsolute(config.data_dir) || !isAbsolute(config.wiki_root))
        throw new Error('data_dir/wiki_root must be absolute');
    await mkdir(config.data_dir, { recursive: true, mode: 0o700 });
    const store = new SqliteStore(join(config.data_dir, 'bookkeeping.sqlite'), options, config.journal_timezone);
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
    return { path, sha256: digest(await readFile(path)) };
}
