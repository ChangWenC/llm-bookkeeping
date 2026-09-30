import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, copyFile, stat, chmod } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { BookkeepingConfig, Store, CollectionBatch, SourceCheckpoint, Lane, EventQuery, SourceEvent, TimeRange, SourceCoverage, ReviewBundle, ReviewChunk, ReviewResult, ReviewCommit, FactRevision, FactRef, FactQuery, JournalPatch, FileStatus, OutboxEntry, FactArtifact, ConsumerAck, FileIntent, WorkItem, LegacyImportBatch, LegacyImportResult } from '../contracts/types.ts';
import { validateReviewResult } from '../contracts/validation.ts';

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().filter(k => (value as any)[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonical((value as any)[k])).join(',') + '}';
  return JSON.stringify(value);
}
export function digest(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
const parse = <T>(row: any): T => JSON.parse(row.json);
const refKey = (ref: FactRef) => `${ref.fact_id}:${ref.revision}`;
const utc = (value: string) => { if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('Invalid UTC timestamp: ' + value); };
const normalized = (value: string) => { const match=value.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/);if(!match)throw new Error('Invalid UTC timestamp');return match[1]+'.'+(match[2]??'').padEnd(9,'0')+'Z'; };
const rangeCheck = (range: TimeRange) => { utc(range.from); utc(range.to); if (normalized(range.from) >= normalized(range.to)) throw new Error('Range must be nonempty and half open'); };
const version = (value: any) => { if (value?.schema_version !== 1) throw new Error('Unsupported schema_version'); };
const unique = (ids: string[], label: string) => { if (ids.some(id => !id) || new Set(ids).size !== ids.length) throw new Error('Duplicate or empty ' + label); };
function enrichEvent(previous: SourceEvent, incoming: SourceEvent): SourceEvent {
  const nativeCompatible=previous.source.message_id!==null&&canonical(previous.source)===canonical(incoming.source)&&previous.body===incoming.body&&(!previous.utc_time.value||!incoming.utc_time.value||normalized(previous.utc_time.value)===normalized(incoming.utc_time.value))&&(previous.role===incoming.role||previous.role==='unknown'||incoming.role==='unknown');
  if(nativeCompatible){
    for(const key of ['sender_id','real_sender_id'])if(previous.context[key]!==undefined&&incoming.context[key]!==undefined&&String(previous.context[key])!==String(incoming.context[key]))throw new Error('Conflicting known sender');
    const retainedContext={...previous.context,...incoming.context};
    for(const key of ['identity_verified','media_transcribed'])if(previous.context[key]===true)retainedContext[key]=true;
    if(previous.context.context_only===false||incoming.context.context_only===false)retainedContext.context_only=false;
    const candidate={...incoming,physical_order:previous.physical_order,generation:previous.generation,time_precision:previous.time_precision==='unknown'?incoming.time_precision:previous.time_precision,context:retainedContext};
    if(previous.utc_time.value&&incoming.utc_time.value&&previous.original_time.value!==null)candidate.original_time=previous.original_time;
    if(previous.journal_timezone.value===incoming.journal_timezone.value&&previous.journal_date.value===incoming.journal_date.value)candidate.journal_timezone_basis=previous.journal_timezone_basis;
    if(previous.wire_timezone.value!==null)candidate.wire_timezone=previous.wire_timezone;
    previous={...previous,context:retainedContext};incoming=candidate;
  }
  const merged=structuredClone(previous);
  const nullable=['original_time','utc_time','wire_timezone','journal_timezone','journal_date'] as const;
  for(const key of nullable){const a=previous[key];const b=incoming[key];if(a.value===null&&b.value!==null)(merged as any)[key]=b;else if(b.value!==null&&a.value!==b.value){if(['utc_time','original_time'].includes(key)&&a.value?.endsWith('Z')&&b.value.endsWith('Z')&&normalized(a.value)===normalized(b.value))continue;throw new Error('Conflicting known event '+key);}}
  for(const key of ['message_id','block_id'] as const){if(merged.source[key]===null)merged.source[key]=incoming.source[key];else if(incoming.source[key]!==null&&merged.source[key]!==incoming.source[key])throw new Error('Conflicting native source identity');}
  if(previous.classification==='unknown')merged.classification=incoming.classification;
  if(previous.role==='unknown')merged.role=incoming.role;
  if(previous.time_precision==='unknown')merged.time_precision=incoming.time_precision;
  if(previous.journal_timezone_basis===null)merged.journal_timezone_basis=incoming.journal_timezone_basis;
  if(previous.fragment_ref===null)merged.fragment_ref=incoming.fragment_ref;
  if(previous.context.turn_complete===false&&incoming.context.turn_complete===true)merged.context.turn_complete=true;
  if(previous.context.incomplete_turn===true&&incoming.context.incomplete_turn===false)merged.context.incomplete_turn=false;
  merged.locator=incoming.locator;
  const normalizeComparable=(e:SourceEvent)=>({...e,locator:null,fragment_ref:null,...Object.fromEntries(nullable.map(key=>[key,{...e[key],value:e[key].value&&['utc_time','original_time'].includes(key)&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(e[key].value!)?normalized(e[key].value!):e[key].value}]))});
  // Incoming nulls cannot erase known information. Rebuild its comparison shape with retained values.
  const comparator={...incoming,source:{...incoming.source},context:{...incoming.context}};
  for(const key of nullable)if(incoming[key].value===null)(comparator as any)[key]=merged[key];
  for(const key of ['message_id','block_id'] as const)if(comparator.source[key]===null)comparator.source[key]=merged.source[key];
  if(comparator.classification==='unknown')comparator.classification=merged.classification;
  if(comparator.role==='unknown')comparator.role=merged.role;
  if(comparator.time_precision==='unknown')comparator.time_precision=merged.time_precision;
  if(comparator.journal_timezone_basis===null)comparator.journal_timezone_basis=merged.journal_timezone_basis;
  if(canonical(normalizeComparable(merged))!==canonical(normalizeComparable(comparator)))throw new Error('Conflicting event content/identity');
  return merged;
}
export function weekFor(date: string): string { const d = new Date(date + 'T12:00:00Z'); const dow = d.getUTCDay(); d.setUTCDate(d.getUTCDate() - (dow + 6) % 7); return d.toISOString().slice(0, 10); }
function factWeek(fact: FactRevision): string | null { const time=fact.occurred_at.value; if(!time)return null; const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Amsterdam',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(time));return weekFor(date); }
export interface StoreOptions { /** Synchronous observability hook; also enables deterministic crash testing. */ onTransactionStep?: (step: string) => void }

export class SqliteStore implements Store {
  readonly db: DatabaseSync;
  readonly path: string;
  private readonly options: StoreOptions;
  private readonly journalTimezone: string;
  constructor(path: string, options: StoreOptions = {}, journalTimezone = 'Europe/Amsterdam') {
    this.path = path; this.options = options;
    this.journalTimezone=journalTimezone;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT OR IGNORE INTO metadata VALUES('schema','1');
      CREATE TABLE IF NOT EXISTS collections(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fragments(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,json TEXT NOT NULL,time TEXT,classification TEXT NOT NULL,ordering TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS event_time ON events(time,ordering,id);
      CREATE TABLE IF NOT EXISTS event_lanes(event_id TEXT NOT NULL REFERENCES events(id),lane TEXT NOT NULL,PRIMARY KEY(event_id,lane));
      CREATE TABLE IF NOT EXISTS coverage(id TEXT PRIMARY KEY,json TEXT NOT NULL,from_time TEXT NOT NULL,to_time TEXT NOT NULL,lane TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checkpoints(id TEXT PRIMARY KEY,json TEXT NOT NULL,provider TEXT NOT NULL,lane TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bundles(id TEXT PRIMARY KEY,json TEXT NOT NULL,kind TEXT NOT NULL,lane TEXT NOT NULL,period TEXT,cutoff TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chunks(id TEXT PRIMARY KEY,json TEXT NOT NULL,kind TEXT NOT NULL,lane TEXT NOT NULL,from_time TEXT,to_time TEXT,state TEXT NOT NULL DEFAULT 'pending');
      CREATE TABLE IF NOT EXISTS reviewed_units(kind TEXT NOT NULL,lane TEXT NOT NULL,event_id TEXT NOT NULL,PRIMARY KEY(kind,lane,event_id));
      CREATE TABLE IF NOT EXISTS reviewed_spans(kind TEXT NOT NULL,lane TEXT NOT NULL,source_id TEXT NOT NULL,start_byte INTEGER NOT NULL,end_byte INTEGER NOT NULL,total_bytes INTEGER NOT NULL,PRIMARY KEY(kind,lane,source_id,start_byte,end_byte));
      CREATE TABLE IF NOT EXISTS reviewed_sources(kind TEXT NOT NULL,lane TEXT NOT NULL,source_id TEXT NOT NULL,PRIMARY KEY(kind,lane,source_id));
      CREATE TABLE IF NOT EXISTS results(id TEXT PRIMARY KEY,bundle_id TEXT UNIQUE NOT NULL REFERENCES bundles(id),json TEXT NOT NULL,content TEXT NOT NULL,commit_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS facts(id TEXT NOT NULL,revision INTEGER NOT NULL,json TEXT NOT NULL,recorded_at TEXT NOT NULL,PRIMARY KEY(id,revision));
      CREATE TABLE IF NOT EXISTS patches(id TEXT PRIMARY KEY,json TEXT NOT NULL,status TEXT NOT NULL,reason TEXT);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,json TEXT NOT NULL,status TEXT NOT NULL,export_path TEXT);
      CREATE TABLE IF NOT EXISTS acks(consumer TEXT NOT NULL,batch_id TEXT NOT NULL REFERENCES outbox(id),json TEXT NOT NULL,PRIMARY KEY(consumer,batch_id));
      CREATE TABLE IF NOT EXISTS intents(id TEXT PRIMARY KEY,json TEXT NOT NULL,state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS work(id TEXT PRIMARY KEY,json TEXT NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL,migration_key TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS imports(migration_key TEXT PRIMARY KEY,json TEXT NOT NULL,result_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS legacy_mappings(source_id TEXT PRIMARY KEY,json TEXT NOT NULL);
    `);
    if ((this.db.prepare("SELECT value FROM metadata WHERE key='schema'").get() as any).value !== '1') throw new Error('Unsupported database schema');
  }
  close() { this.db.close(); }
  allocateId(namespace: string): string { if (!/^[a-z][a-z0-9_-]*$/i.test(namespace)) throw new Error('Invalid ID namespace'); return namespace + ':' + randomUUID(); }
  private transaction<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.options.onTransactionStep?.('before_commit'); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  private immutable(table: string, id: string, value: unknown, sql?: string, params?: any[]) {
    const json = canonical(value); const old = this.db.prepare(`SELECT json FROM ${table} WHERE id=?`).get(id) as any;
    if (old) { if (old.json !== json) throw new Error(`Immutable ${table} identity conflict: ${id}`); return; }
    this.db.prepare(sql ?? `INSERT INTO ${table}(id,json) VALUES(?,?)`).run(...(params ?? [id,json]));
  }
  async saveCollection(batch: CollectionBatch): Promise<void> {
    version(batch); unique(batch.events.map(e => e.event_id), 'event IDs');
    this.transaction(() => {
      const previous = this.db.prepare('SELECT json FROM collections WHERE id=?').get(batch.batch_id) as any;
      if (previous) { if (previous.json !== canonical(batch)) throw new Error('Collection batch identity conflict'); return; }
      for (const fragment of batch.fragments) { version(fragment); if (digest(Buffer.from(fragment.bytes_base64,'base64')) !== fragment.sha256) throw new Error('Fragment digest mismatch'); this.immutable('fragments',fragment.fragment_id,fragment); }
      this.options.onTransactionStep?.('collection_fragments');
      for (const event of batch.events) {
        version(event); if (event.utc_time.value) utc(event.utc_time.value);
        if (event.fragment_ref && !this.db.prepare('SELECT id FROM fragments WHERE id=?').get(event.fragment_ref)) throw new Error('Missing event fragment');
        const old = this.db.prepare('SELECT json FROM events WHERE id=?').get(event.event_id) as any;
        if (old) {
          try {const enriched=enrichEvent(parse<SourceEvent>(old),event);this.db.prepare('UPDATE events SET json=?,time=?,classification=? WHERE id=?').run(canonical(enriched),enriched.utc_time.value?normalized(enriched.utc_time.value):null,enriched.classification,event.event_id);if(enriched.utc_time.value&&enriched.journal_date.value&&enriched.classification!=='unknown'){const work=this.db.prepare('SELECT json FROM work WHERE id=?').get('event-gap:'+digest(event.event_id));if(work){const item=parse<WorkItem>(work);this.db.prepare("UPDATE work SET state='complete',json=? WHERE id=?").run(canonical({...item,state:'complete'}),item.work_id);}}}
          catch(error){this.putWork({schema_version:1,work_id:'event-conflict:'+digest(canonical(event)),kind:'event_conflict',lane:batch.coverage.some(c=>c.lane==='live')?'live':'history',state:'pending',payload:{event_id:event.event_id,incoming:event},reason:String(error),migration_key:null,updated_at:new Date().toISOString()});continue;}
        }
        else this.db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(event.event_id,canonical(event),event.utc_time.value ? normalized(event.utc_time.value) : null,event.classification,event.physical_order);
        const lanes = batch.coverage.filter(c => c.provider === event.source.provider && c.account_id === event.source.account_id && (!c.conversation_id || c.conversation_id === event.source.conversation_id)).map(c => c.lane);
        for (const lane of new Set(lanes.length ? lanes : batch.checkpoints.map(c => c.lane))) this.db.prepare('INSERT OR IGNORE INTO event_lanes VALUES(?,?)').run(event.event_id,lane);
        if (!event.utc_time.value || !event.journal_date.value || event.classification==='unknown') this.putWork({schema_version:1,work_id:'event-gap:'+digest(event.event_id),kind:'event_identity_time',lane:lanes.includes('live')?'live':'history',state:'pending',payload:{event_id:event.event_id},reason:'Event identity/time/journal date needs resolution',migration_key:null,updated_at:new Date().toISOString()});
      }
      this.options.onTransactionStep?.('collection_events');
      for (const coverage of batch.coverage) { version(coverage); rangeCheck(coverage.query_range); utc(coverage.cutoff); const current=this.coverageReview(coverage,'daily',false); this.db.prepare('INSERT INTO coverage VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json,from_time=excluded.from_time,to_time=excluded.to_time,lane=excluded.lane').run(coverage.coverage_id,canonical(current),normalized(coverage.query_range.from),normalized(coverage.query_range.to),coverage.lane); }
      for (const checkpoint of batch.checkpoints) { version(checkpoint); utc(checkpoint.updated_at); const old = this.db.prepare('SELECT json FROM checkpoints WHERE id=?').get(checkpoint.checkpoint_id) as any; if (old && (parse<SourceCheckpoint>(old).provider !== checkpoint.provider || parse<SourceCheckpoint>(old).lane !== checkpoint.lane)) throw new Error('Checkpoint lane identity conflict'); this.db.prepare('INSERT INTO checkpoints VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(checkpoint.checkpoint_id,canonical(checkpoint),checkpoint.provider,checkpoint.lane); }
      this.immutable('collections',batch.batch_id,batch); this.options.onTransactionStep?.('collection_checkpoints');
    });
  }
  async getCheckpoints(provider: string, lane: Lane): Promise<SourceCheckpoint[]> { return this.db.prepare('SELECT json FROM checkpoints WHERE provider=? AND lane=? ORDER BY id').all(provider,lane).map(parse<SourceCheckpoint>); }
  async listEvents(query: EventQuery): Promise<SourceEvent[]> {
    rangeCheck(query.range); const limit = query.limit ?? 1000; if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid event limit');
    const params: any[] = [normalized(query.range.from),normalized(query.range.to)]; let clause = 'time>=? AND time<?';
    if (!query.include_context) clause += " AND classification='main' AND COALESCE(json_extract(json,'$.context.context_only'),0)!=1";
    if (query.lane) { clause += ' AND EXISTS(SELECT 1 FROM event_lanes l WHERE l.event_id=events.id AND l.lane=?)'; params.push(query.lane); }
    if (query.after) { const cursor = this.db.prepare('SELECT time,ordering,id FROM events WHERE id=?').get(query.after) as any; if (!cursor) throw new Error('Unknown event cursor'); clause += ' AND (time,ordering,id)>(?,?,?)'; params.push(cursor.time,cursor.ordering,cursor.id); }
    params.push(limit); return this.db.prepare(`SELECT json FROM events WHERE ${clause} ORDER BY time,ordering,id LIMIT ?`).all(...params).map(parse<SourceEvent>);
  }
  async listCoverage(range: TimeRange): Promise<SourceCoverage[]> {
    rangeCheck(range); return this.db.prepare('SELECT json FROM coverage WHERE from_time<? AND to_time>? ORDER BY id').all(normalized(range.to),normalized(range.from)).map(parse<SourceCoverage>);
  }
  async saveBundle(bundle: ReviewBundle): Promise<void> {
    version(bundle); utc(bundle.cutoff); unique(bundle.chunks.map(c => c.chunk_id),'chunk IDs');
    this.transaction(() => {
      this.immutable('bundles',bundle.bundle_id,bundle,'INSERT INTO bundles VALUES(?,?,?,?,?,?)',[bundle.bundle_id,canonical(bundle),bundle.kind,bundle.lane,bundle.period,bundle.cutoff]);
      for (const chunk of bundle.chunks) { version(chunk); unique(chunk.events.map(e => e.event_id),'chunk events'); const times = chunk.events.flatMap(e => e.utc_time.value ? [normalized(e.utc_time.value)] : []).sort(); this.immutable('chunks',chunk.chunk_id,chunk,'INSERT INTO chunks(id,json,kind,lane,from_time,to_time) VALUES(?,?,?,?,?,?)',[chunk.chunk_id,canonical(chunk),bundle.kind,bundle.lane,times[0] ?? null,times.at(-1) ?? null]); }
    });
  }
  async getBundle(id: string): Promise<ReviewBundle | null> { const row = this.db.prepare('SELECT json FROM bundles WHERE id=?').get(id); return row ? parse(row) : null; }
  async listPendingChunks(range: TimeRange, lane: Lane): Promise<ReviewChunk[]> { rangeCheck(range); return this.db.prepare("SELECT json FROM chunks WHERE lane=? AND state!='complete' AND (from_time IS NULL OR (from_time<? AND to_time>=?)) ORDER BY id").all(lane,normalized(range.to),normalized(range.from)).map(parse<ReviewChunk>); }
  getReviewedUnits(kind: string, lane: Lane): Set<string> { return new Set(this.db.prepare('SELECT event_id FROM reviewed_units WHERE kind=? AND lane=?').all(kind,lane).map((r:any) => r.event_id)); }
  getReviewedSpans(kind: string, lane: Lane, sourceId: string): {start_byte:number;end_byte:number}[] {
    return this.db.prepare('SELECT start_byte,end_byte FROM reviewed_spans WHERE kind=? AND lane=? AND source_id=? ORDER BY start_byte,end_byte').all(kind,lane,sourceId) as any[];
  }
  async getReviewableEvents(query: EventQuery, kind: string): Promise<SourceEvent[]> {
    rangeCheck(query.range); return this.db.prepare("SELECT e.json FROM events e WHERE e.time>=? AND e.time<? AND e.classification='main' AND COALESCE(json_extract(e.json,'$.context.context_only'),0)!=1 AND EXISTS(SELECT 1 FROM event_lanes l WHERE l.event_id=e.id AND l.lane=?) AND NOT EXISTS(SELECT 1 FROM reviewed_sources r WHERE r.source_id=e.id AND r.kind=? AND r.lane=?) ORDER BY e.time,e.ordering,e.id LIMIT ?").all(normalized(query.range.from),normalized(query.range.to),query.lane!,kind,query.lane!,query.limit ?? 1000).map(parse<SourceEvent>);
  }
  getContextEvents(event: SourceEvent): SourceEvent[] {
    if (!event.utc_time.value) return [];
    const originalId = (event.context.review_slice as any)?.source_event_id ?? event.event_id;
    const group = event.source.conversation_id?.endsWith('@chatroom') || event.context.is_group === true;
    if (group) {
      const anchor = Date.parse(event.utc_time.value);
      return this.db.prepare("SELECT json FROM events WHERE json_extract(json,'$.source.provider')=? AND json_extract(json,'$.source.account_id')=? AND json_extract(json,'$.source.conversation_id')=? AND time>=? AND time<=? AND id!=? AND classification='main' ORDER BY ABS(julianday(time)-julianday(?)),time,ordering,id LIMIT 12")
        .all(event.source.provider, event.source.account_id, event.source.conversation_id, normalized(new Date(anchor - 20 * 60000).toISOString()), normalized(new Date(anchor + 20 * 60000).toISOString()), originalId, normalized(event.utc_time.value))
        .map(parse<SourceEvent>).sort((a,b) => normalized(a.utc_time.value!).localeCompare(normalized(b.utc_time.value!)) || a.physical_order.localeCompare(b.physical_order));
    }
    return this.db.prepare("SELECT json FROM events WHERE json_extract(json,'$.source.provider')=? AND json_extract(json,'$.source.account_id')=? AND json_extract(json,'$.source.conversation_id')=? AND (time,ordering,id)<(?,?,?) AND id!=? AND classification='main' ORDER BY time DESC,ordering DESC,id DESC LIMIT 3")
      .all(event.source.provider,event.source.account_id,event.source.conversation_id,normalized(event.utc_time.value),event.physical_order,originalId,originalId).map(parse<SourceEvent>).reverse();
  }
  private markUnit(event: SourceEvent, kind: string, lane: Lane, mirror = true) {
    if(kind==='daily' && mirror) this.markUnit(event,kind,lane==='live'?'history':'live',false);
    const slice = event.context.review_slice as any; const sourceId = slice?.source_event_id ?? event.event_id; const start = slice?.start_byte ?? 0; const end = slice?.end_byte ?? Buffer.byteLength(event.body ?? ''); const total = slice?.total_bytes ?? end;
    this.db.prepare('INSERT OR IGNORE INTO reviewed_units VALUES(?,?,?)').run(kind,lane,event.event_id);
    this.db.prepare('INSERT OR IGNORE INTO reviewed_spans VALUES(?,?,?,?,?,?)').run(kind,lane,sourceId,start,end,total);
    const spans = this.db.prepare('SELECT start_byte,end_byte,total_bytes FROM reviewed_spans WHERE kind=? AND lane=? AND source_id=? ORDER BY start_byte,end_byte').all(kind,lane,sourceId) as any[]; let frontier = 0; for (const span of spans) { if (span.start_byte > frontier) break; frontier = Math.max(frontier,span.end_byte); }
    if (frontier >= total) this.db.prepare('INSERT OR IGNORE INTO reviewed_sources VALUES(?,?,?)').run(kind,lane,sourceId);
  }
  private coverageReview(coverage: SourceCoverage, kind: string, explicitEmpty: boolean): SourceCoverage {
    const events = this.db.prepare("SELECT e.id FROM events e WHERE json_extract(e.json,'$.source.provider')=? AND json_extract(e.json,'$.source.account_id')=? AND (? IS NULL OR json_extract(e.json,'$.source.conversation_id')=?) AND e.classification IN ('main','unknown') AND COALESCE(json_extract(e.json,'$.context.context_only'),0)!=1 AND (e.time IS NULL OR (e.time>=? AND e.time<?)) AND EXISTS(SELECT 1 FROM event_lanes l WHERE l.event_id=e.id AND l.lane=?)").all(coverage.provider,coverage.account_id,coverage.conversation_id,coverage.conversation_id,normalized(coverage.query_range.from),normalized(coverage.query_range.to),coverage.lane) as any[];
    const done = events.filter(e => this.db.prepare('SELECT 1 FROM reviewed_sources WHERE kind=? AND lane=? AND source_id=?').get(kind,coverage.lane,e.id)).length;
    const any = events.some(e=>this.db.prepare('SELECT 1 FROM reviewed_spans WHERE kind=? AND lane=? AND source_id=? LIMIT 1').get(kind,coverage.lane,e.id));
    const status = events.length ? done === events.length ? 'complete' : (done || any) ? 'partial' : 'pending' : explicitEmpty && coverage.capture_status === 'complete' && !coverage.gaps.length ? 'complete' : 'pending';
    return {...coverage,review_status:status};
  }
  async getReviewResult(id: string): Promise<ReviewResult | null> { const row = this.db.prepare('SELECT json FROM results WHERE id=?').get(id); return row ? parse(row) : null; }
  private effective(asOf?: string): FactRevision[] {
    const rows = this.db.prepare('SELECT json FROM facts WHERE recorded_at<=? ORDER BY recorded_at,rowid').all(asOf ? normalized(asOf) : '9999-12-31T23:59:59.999Z').map(parse<FactRevision>);
    const live = new Map<string,FactRevision>();
    for (const fact of rows) {
      if (fact.action !== 'assert') for (const target of fact.target_refs) live.delete(refKey(target));
      if (fact.action !== 'retract') live.set(refKey(fact),fact);
    }
    return [...live.values()];
  }
  async commitReview(result: ReviewResult): Promise<ReviewCommit> {
    version(result); utc(result.created_at);
    return this.transaction(() => {
      const content = canonical({...result,result_id:null,created_at:null});
      const old = this.db.prepare('SELECT content,commit_json FROM results WHERE bundle_id=? OR id=?').get(result.bundle_id,result.result_id) as any;
      if (old) { if (old.content !== content) throw new Error('Review result/bundle identity conflict'); return {...JSON.parse(old.commit_json),reused:true}; }
      const row = this.db.prepare('SELECT json FROM bundles WHERE id=?').get(result.bundle_id); if (!row) throw new Error('Unknown review bundle'); const bundle = parse<ReviewBundle>(row);
      validateReviewResult(result);
      unique(result.chunks.map(c => c.chunk_id),'reviewed chunks'); unique(result.candidates.map(c => c.candidate_id),'candidate IDs'); unique(result.pages.map(p => p.suggestion_id),'page suggestions');
      const chunks = new Map(bundle.chunks.map(c => [c.chunk_id,c])); const reviews = new Map(result.chunks.map(c => [c.chunk_id,c]));
      for (const reviewed of result.chunks) {
        version(reviewed); const chunk = chunks.get(reviewed.chunk_id); if (!chunk) throw new Error('Unknown reviewed chunk'); unique(reviewed.reviewed_event_ids,'reviewed events'); const ids = new Set(chunk.events.map(e => e.event_id));
        if (reviewed.reviewed_event_ids.some(id => !ids.has(id))) throw new Error('Reviewed event outside chunk');
        if (reviewed.status === 'complete' && reviewed.reviewed_event_ids.length !== ids.size) throw new Error('Complete chunk omits events');
        if (reviewed.status === 'deferred' && reviewed.reviewed_event_ids.length) throw new Error('Deferred chunk claims reviewed events');
        const candidates = result.candidates.filter(c => c.chunk_id === reviewed.chunk_id);
        if (reviewed.status === 'complete' && !candidates.length && !reviewed.zero_facts) throw new Error('Complete zero-fact review must be explicit');
        if (reviewed.zero_facts && candidates.length) throw new Error('zero_facts contradicts candidates');
      }
      const availableTargets = new Set(bundle.existing_facts.map(refKey)); const liveTargets = new Set(this.effective().map(refKey)); const failed = new Set<string>(); const heldEvents=new Set<string>(); const facts: FactRevision[] = []; const refs = new Map<string,FactRef[]>();
      for (const candidate of result.candidates) {
        version(candidate); const chunk = chunks.get(candidate.chunk_id); const review = reviews.get(candidate.chunk_id); if (!chunk || !review || review.status === 'deferred') throw new Error('Candidate outside reviewed chunk');
        const reviewed = new Set(review.reviewed_event_ids); const eventMap = new Map(chunk.events.map(e => [e.event_id,e]));
        const derivedRefs = new Set(bundle.existing_facts.flatMap(f=>f.event_refs.map(r=>r.event_id)));
        const derived = bundle.kind!=='daily' && ['inference','recommendation'].includes(candidate.kind);
        if (candidate.event_refs.some(ref => !((eventMap.has(ref.event_id) && reviewed.has(ref.event_id)) || (derived && derivedRefs.has(ref.event_id))))) throw new Error('Candidate uses unreviewed/context event');
        if(bundle.kind!=='daily' && candidate.disposition==='add' && !derived) throw new Error('Weekly/monthly cannot allocate duplicate direct facts');
        if (!candidate.event_refs.length && candidate.disposition === 'add') throw new Error('New fact requires event evidence');
        const targetKeys = candidate.target_refs.map(refKey); unique(targetKeys,'target refs');
        if (candidate.disposition === 'add' && targetKeys.length) throw new Error('Add cannot replace targets');
        if (candidate.occurred_at.value) utc(candidate.occurred_at.value);
        let reason: string | null = null;
        if (!candidate.subject.trim() || candidate.attribution?.subject_known === false) reason = 'Unknown fact subject';
        if (candidate.disposition !== 'add' && (!targetKeys.length || targetKeys.some(key => !availableTargets.has(key) || !liveTargets.has(key)))) reason = 'Unresolved or stale target reference';
        if (reason) { failed.add(candidate.chunk_id); candidate.event_refs.forEach(r=>heldEvents.add(r.event_id)); this.putWork({schema_version:1,work_id:this.allocateId('work'),kind:'review_candidate',lane:bundle.lane,state:'pending',payload:{bundle_id:bundle.bundle_id,candidate},reason,migration_key:null,updated_at:result.created_at}); continue; }
        if (candidate.disposition === 'keep') { refs.set(candidate.candidate_id,candidate.target_refs); continue; }
        const single = candidate.target_refs.length === 1 ? candidate.target_refs[0] : null;
        const factId = single && candidate.disposition !== 'add' ? single.fact_id : this.allocateId('fact');
        const max = this.db.prepare('SELECT MAX(revision) AS revision FROM facts WHERE id=?').get(factId) as any;
        const eventRefs = candidate.event_refs.map(ref => { const event = eventMap.get(ref.event_id); const sourceId = (event?.context.review_slice as any)?.source_event_id; return {...ref,event_id:typeof sourceId === 'string' ? sourceId : ref.event_id}; });
        const projection = structuredClone(candidate.analytics_projection ?? {schema_version:1 as const,value:null,reason:'Analytics projection not supplied'});
        if(projection.value) projection.value.event_refs=projection.value.event_refs.map(ref=>{const index=candidate.event_refs.findIndex(original=>original.event_id===ref.event_id);if(index<0)throw new Error('Analytics projection evidence outside fact evidence');return {...ref,event_id:eventRefs[index].event_id};});
        const attribution=derived?{...candidate.attribution,derived_from:bundle.existing_facts.filter(f=>f.event_refs.some(r=>candidate.event_refs.some(c=>c.event_id===r.event_id))).map(f=>({schema_version:1,fact_id:f.fact_id,revision:f.revision}))}:candidate.attribution;
        const fact: FactRevision = {schema_version:1,fact_id:factId,revision:(max.revision ?? 0)+1,event_refs:eventRefs,content:candidate.content,subject:candidate.subject,occurred_at:candidate.occurred_at,journal_date:candidate.journal_date,kind:candidate.kind,analytics_projection:projection,action:candidate.disposition === 'add' ? 'assert' : candidate.disposition,target_refs:candidate.target_refs,scope:candidate.scope,attribution,recorded_at:result.created_at};
        this.db.prepare('INSERT INTO facts VALUES(?,?,?,?)').run(fact.fact_id,fact.revision,canonical(fact),normalized(fact.recorded_at)); facts.push(fact); refs.set(candidate.candidate_id,[{schema_version:1,fact_id:fact.fact_id,revision:fact.revision}]);
        for (const key of targetKeys) liveTargets.delete(key); liveTargets.add(refKey(fact));
      }
      this.options.onTransactionStep?.('review_facts');
      for (const review of result.chunks) {
        for (const id of review.reviewed_event_ids.filter(id=>!heldEvents.has(id))) this.markUnit(chunks.get(review.chunk_id)!.events.find(e => e.event_id === id)!,bundle.kind,bundle.lane);
        if(review.status==='complete' && chunks.get(review.chunk_id)!.events.length===0) this.db.prepare('INSERT OR IGNORE INTO reviewed_units VALUES(?,?,?)').run(bundle.kind,bundle.lane,review.chunk_id);
        this.db.prepare('UPDATE chunks SET state=? WHERE id=?').run(failed.has(review.chunk_id)?'partial':review.status,review.chunk_id);
      }
      this.options.onTransactionStep?.('review_chunks');
      const patches: JournalPatch[] = [];
      for (const page of result.pages) {
        version(page); if (page.candidate_ids.some(id => !result.candidates.some(c => c.candidate_id === id))) throw new Error('Page references unknown candidate');
        if (page.candidate_ids.some(id => !refs.has(id))) { this.putWork({schema_version:1,work_id:this.allocateId('work'),kind:'journal_suggestion',lane:bundle.lane,state:'pending',payload:{bundle_id:bundle.bundle_id,page},reason:'Page depends on unresolved candidate',migration_key:null,updated_at:result.created_at}); continue; }
        const baseline = bundle.baselines.find(b => b.path === page.path); if (!baseline || baseline.digest !== page.baseline_digest) throw new Error('Page baseline outside bundle');
        if (page.mode === 'replace' && !page.old_text) throw new Error('Exact replacement requires old_text');
        const patch: JournalPatch = {schema_version:1,operation_id:this.allocateId('operation'),date:page.date,path:page.path,baseline_digest:page.baseline_digest,mode:page.mode,old_text:page.old_text,new_text:page.new_text,fact_refs:page.candidate_ids.flatMap(id => refs.get(id) ?? [])};
        this.db.prepare('INSERT INTO patches VALUES(?,?,?,NULL)').run(patch.operation_id,canonical(patch),'pending'); patches.push(patch);
      }
      this.options.onTransactionStep?.('review_patches');
      const batchId = this.allocateId('batch'); const explicitEmpty = result.chunks.some(c => c.status === 'complete' && c.zero_facts && chunks.get(c.chunk_id)!.events.length === 0);
      const reviewedCoverage = bundle.coverage.map(c => this.coverageReview(c,bundle.kind,explicitEmpty));
      if (bundle.kind === 'daily') for (const coverage of reviewedCoverage) this.db.prepare('UPDATE coverage SET json=? WHERE id=?').run(canonical(coverage),coverage.coverage_id);
      const artifact: FactArtifact = {schema_version:1,batch_id:batchId,created_at:result.created_at,facts,coverage:reviewedCoverage,affected_dates:[...new Set(facts.flatMap(f => f.journal_date.value ? [f.journal_date.value] : []))].sort(),affected_weeks:[]};
      // Corrections can move dates; downstream recomputes both original and replacement periods.
      const affectedFacts=[...facts];
      for (const fact of facts) for (const target of fact.target_refs) { const targetRow = this.db.prepare('SELECT json FROM facts WHERE id=? AND revision=?').get(target.fact_id,target.revision); if (targetRow) { const oldFact=parse<FactRevision>(targetRow); affectedFacts.push(oldFact);const date = oldFact.journal_date.value; if (date && !artifact.affected_dates.includes(date)) artifact.affected_dates.push(date); } }
      const weeks=new Set(affectedFacts.flatMap(f=>factWeek(f)?[factWeek(f)!]:[]));
      const dates=new Set(artifact.affected_dates);
      for(const c of reviewedCoverage){let day=new Intl.DateTimeFormat('en-CA',{timeZone:this.journalTimezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(c.query_range.from));const last=new Intl.DateTimeFormat('en-CA',{timeZone:this.journalTimezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(Date.parse(c.query_range.to)-1));while(day<=last){dates.add(day);const next=new Date(day+'T12:00:00Z');next.setUTCDate(next.getUTCDate()+1);day=next.toISOString().slice(0,10);}}
      for(const c of reviewedCoverage){let day=weekFor(new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Amsterdam',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(c.query_range.from)));const last=weekFor(new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Amsterdam',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(Date.parse(c.query_range.to)-1)));while(day<=last){weeks.add(day);const next=new Date(day+'T12:00:00Z');next.setUTCDate(next.getUTCDate()+7);day=next.toISOString().slice(0,10);}}
      artifact.affected_dates=[...dates].sort(); artifact.affected_weeks = [...weeks].sort();
      this.db.prepare('INSERT INTO outbox VALUES(?,?,?,NULL)').run(batchId,canonical(artifact),'pending'); this.options.onTransactionStep?.('review_outbox');
      const commit: ReviewCommit = {schema_version:1,result_id:result.result_id,batch_id:batchId,reused:false,facts,patches};
      this.db.prepare('INSERT INTO results VALUES(?,?,?,?,?)').run(result.result_id,result.bundle_id,canonical(result),content,canonical(commit)); this.options.onTransactionStep?.('review_result');
      return commit;
    });
  }
  async listPendingPatches(): Promise<JournalPatch[]> { return this.db.prepare("SELECT json FROM patches WHERE status='pending' ORDER BY rowid").all().map(parse<JournalPatch>); }
  async markPatchStatus(id: string, status: FileStatus, reason: string | null = null) { if (!['applied','noop','pending','conflict'].includes(status)) throw new Error('Invalid patch status'); const r = this.db.prepare('UPDATE patches SET status=?,reason=? WHERE id=?').run(status,reason,id); if (!r.changes) throw new Error('Unknown patch'); }
  async readEffectiveFacts(query: FactQuery): Promise<FactRevision[]> { rangeCheck(query.range); if (query.as_of) utc(query.as_of); return this.effective(query.as_of).filter(f => { const time = f.occurred_at.value ?? (f.journal_date.value ? f.journal_date.value + 'T12:00:00Z' : null); return time !== null && normalized(time) >= normalized(query.range.from) && normalized(time) < normalized(query.range.to) && (!query.scope?.length || query.scope.some(s => f.scope.includes(s))); }); }
  async listOutbox(status?: 'pending' | 'ready'): Promise<OutboxEntry[]> { return this.db.prepare('SELECT * FROM outbox' + (status ? ' WHERE status=?' : '') + ' ORDER BY rowid').all(...(status ? [status] : [])).map((r:any) => ({schema_version:1,batch_id:r.id,artifact:parse<FactArtifact>(r),status:r.status,export_path:r.export_path})); }
  async markExportReady(id: string, path: string) { if (!isAbsolute(path)) throw new Error('Export path must be absolute'); const old = this.db.prepare('SELECT status,export_path FROM outbox WHERE id=?').get(id) as any; if (!old) throw new Error('Unknown batch'); if (old.status === 'ready' && old.export_path !== path) throw new Error('Immutable export path conflict'); this.db.prepare("UPDATE outbox SET status='ready',export_path=? WHERE id=?").run(path,id); }
  async listReadyBatches(consumer: string): Promise<FactArtifact[]> { return this.db.prepare("SELECT json FROM outbox o WHERE status='ready' AND NOT EXISTS(SELECT 1 FROM acks a WHERE a.batch_id=o.id AND a.consumer=?) ORDER BY rowid").all(consumer).map(parse<FactArtifact>); }
  async acknowledgeConsumer(ack: ConsumerAck) { version(ack); utc(ack.acknowledged_at); const row = this.db.prepare('SELECT status FROM outbox WHERE id=?').get(ack.batch_id) as any; if (row?.status !== 'ready') throw new Error('Cannot acknowledge unready batch'); this.db.prepare('INSERT OR IGNORE INTO acks VALUES(?,?,?)').run(ack.consumer,ack.batch_id,canonical(ack)); }
  async saveFileIntent(intent: FileIntent) {
    version(intent); utc(intent.created_at);
    if ((intent.desired_bytes_base64 === null ? 'absent' : digest(Buffer.from(intent.desired_bytes_base64,'base64'))) !== intent.desired_digest || (intent.backup_bytes_base64 === null ? 'absent' : digest(Buffer.from(intent.backup_bytes_base64,'base64'))) !== intent.baseline_digest) throw new Error('Intent bytes do not match digests');
    this.transaction(()=>{const row=this.db.prepare('SELECT json FROM intents WHERE id=?').get(intent.operation_id);const old=row?parse<FileIntent>(row):null; if (old) { const shape = (v:FileIntent) => ({...v,state:null,reason:null}); if (canonical(shape(old)) !== canonical(shape(intent))) throw new Error('File intent identity conflict'); return; } this.db.prepare('INSERT INTO intents VALUES(?,?,?)').run(intent.operation_id,canonical(intent),intent.state);});
  }
  async getFileIntent(id: string): Promise<FileIntent | null> { const row = this.db.prepare('SELECT json FROM intents WHERE id=?').get(id); return row ? parse(row) : null; }
  async listFileIntents(states?: FileIntent['state'][]): Promise<FileIntent[]> { if (states?.length === 0) return []; return this.db.prepare('SELECT json FROM intents' + (states ? ' WHERE state IN(' + states.map(() => '?').join(',') + ')' : '') + ' ORDER BY rowid').all(...(states ?? [])).map(parse<FileIntent>); }
  async updateFileIntent(id: string, state: FileIntent['state'], reason: string | null = null) { const intent = await this.getFileIntent(id); if (!intent) throw new Error('Unknown file intent'); if (!['prepared','applied','pending','conflict'].includes(state)) throw new Error('Invalid intent state'); this.db.prepare('UPDATE intents SET json=?,state=? WHERE id=?').run(canonical({...intent,state,reason}),state,id); }
  private putWork(item: WorkItem) { version(item); utc(item.updated_at); const old = this.db.prepare('SELECT json FROM work WHERE id=? OR (migration_key IS NOT NULL AND migration_key=?)').get(item.work_id,item.migration_key) as any; if (old) { const previous = parse<WorkItem>(old); if (previous.kind !== item.kind || previous.lane !== item.lane || canonical(previous.payload) !== canonical(item.payload)) throw new Error('Work identity conflict'); return; } this.db.prepare('INSERT INTO work VALUES(?,?,?,?,?)').run(item.work_id,canonical(item),item.kind,item.state,item.migration_key); }
  async enqueueWork(item: WorkItem) { this.putWork(item); }
  async listWork(kind?: string, state?: WorkItem['state']): Promise<WorkItem[]> { const clauses: string[] = []; const args: string[] = []; if (kind) {clauses.push('kind=?');args.push(kind);} if (state) {clauses.push('state=?');args.push(state);} return this.db.prepare('SELECT json FROM work' + (clauses.length ? ' WHERE ' + clauses.join(' AND ') : '') + ' ORDER BY rowid').all(...args).map(parse<WorkItem>); }
  async completeWork(id: string) { const row = this.db.prepare('SELECT json FROM work WHERE id=?').get(id); if (!row) throw new Error('Unknown work item'); const work = parse<WorkItem>(row); this.db.prepare("UPDATE work SET json=?,state='complete' WHERE id=?").run(canonical({...work,state:'complete'}),id); }
  async importLegacy(batch: LegacyImportBatch): Promise<LegacyImportResult> {
    version(batch); if (!batch.migration_key) throw new Error('Missing migration key');
    return this.transaction(() => {
      const old = this.db.prepare('SELECT * FROM imports WHERE migration_key=?').get(batch.migration_key) as any; if (old) { if (old.json !== canonical(batch)) throw new Error('Legacy migration identity conflict'); return {...JSON.parse(old.result_json),reused:true}; }
      unique(batch.mappings.map(m => m.source_id),'legacy mapping IDs'); let unresolved = 0;
      for (const mapping of batch.mappings) { version(mapping); if (mapping.confidence === 'verified' && !mapping.target_id) throw new Error('Verified mapping requires target'); const previous = this.db.prepare('SELECT json FROM legacy_mappings WHERE source_id=?').get(mapping.source_id) as any; if (previous && previous.json !== canonical(mapping)) throw new Error('Legacy mapping conflict'); this.db.prepare('INSERT OR IGNORE INTO legacy_mappings VALUES(?,?)').run(mapping.source_id,canonical(mapping)); if (mapping.confidence === 'unresolved') unresolved++; }
      const facts: FactRevision[] = [];
      for (const input of batch.facts) { version(input); utc(input.recorded_at); if (input.occurred_at.value) utc(input.occurred_at.value); if (!Number.isSafeInteger(input.revision) || input.revision < 1) throw new Error('Invalid fact revision'); const verified = batch.mappings.some(m => m.confidence === 'verified' && m.target_id === input.fact_id); const fact = {...input,kind:verified ? input.kind : 'legacy_record' as const,attribution:{...input.attribution,legacy_verified:verified}}; const previous = this.db.prepare('SELECT json FROM facts WHERE id=? AND revision=?').get(fact.fact_id,fact.revision) as any; if (previous && previous.json !== canonical(fact)) throw new Error('Legacy fact identity conflict'); if (!previous) { this.db.prepare('INSERT INTO facts VALUES(?,?,?,?)').run(fact.fact_id,fact.revision,canonical(fact),normalized(fact.recorded_at)); facts.push(fact); } }
      for (const work of batch.work) this.putWork(work);
      if (unresolved) this.putWork({schema_version:1,work_id:this.allocateId('work'),kind:'legacy_mapping',lane:'history',state:'pending',payload:{migration_key:batch.migration_key,mappings:batch.mappings.filter(m => m.confidence === 'unresolved')},reason:'Legacy IDs require reconciliation; confirmations must not transfer',migration_key:batch.migration_key + ':mappings',updated_at:new Date().toISOString()});
      const batchId = 'legacy:' + digest(batch.migration_key); const dates = [...new Set(facts.flatMap(f => f.journal_date.value ? [f.journal_date.value] : []))].sort(); const artifact: FactArtifact = {schema_version:1,batch_id:batchId,created_at:new Date().toISOString(),facts,coverage:[],affected_dates:dates,affected_weeks:[...new Set(dates.map(weekFor))]}; this.db.prepare('INSERT INTO outbox VALUES(?,?,?,NULL)').run(batchId,canonical(artifact),'pending');
      const result: LegacyImportResult = {schema_version:1,migration_key:batch.migration_key,reused:false,imported_facts:facts.length,unresolved}; this.db.prepare('INSERT INTO imports VALUES(?,?,?)').run(batch.migration_key,canonical(batch),canonical(result)); return result;
    });
  }
  async status(): Promise<Record<string,unknown>> { const counts: Record<string,unknown> = {schema_version:1}; for (const table of ['events','facts','results','outbox','patches','work']) counts[table] = (this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as any).count; counts.pending_exports = (this.db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE status='pending'").get() as any).count; counts.pending_patches = (this.db.prepare("SELECT COUNT(*) AS count FROM patches WHERE status='pending'").get() as any).count; counts.coverage = this.db.prepare('SELECT json FROM coverage ORDER BY id').all().map(parse<SourceCoverage>); return counts; }
  async backup(outputDir: string): Promise<{path:string;sha256:string}> { if (!isAbsolute(outputDir)) throw new Error('Backup output directory must be absolute'); await mkdir(outputDir,{recursive:true,mode:0o700}); const path = join(outputDir,'bookkeeping-' + randomUUID() + '.sqlite'); this.db.prepare('VACUUM INTO ?').run(path); await chmod(path,0o600); return {path,sha256:digest(await readFile(path))}; }
}
export async function createStore(config: BookkeepingConfig, options: StoreOptions = {}): Promise<SqliteStore> { if (!isAbsolute(config.data_dir) || !isAbsolute(config.wiki_root)) throw new Error('data_dir/wiki_root must be absolute'); await mkdir(config.data_dir,{recursive:true,mode:0o700}); const store=new SqliteStore(join(config.data_dir,'bookkeeping.sqlite'),options,config.journal_timezone); await chmod(store.path,0o600); return store; }
/** Restore into a new empty directory, validating the consistent snapshot first. */
export async function restoreStore(input: string, dataDir: string): Promise<{path:string;sha256:string}> {
  if (!isAbsolute(input) || !isAbsolute(dataDir)) throw new Error('Restore paths must be absolute');
  const source = resolve(input); const probe = new DatabaseSync(source,{readOnly:true}); try { const check = probe.prepare('PRAGMA integrity_check').get() as any; if (check.integrity_check !== 'ok') throw new Error('Backup integrity check failed'); const schema = probe.prepare("SELECT value FROM metadata WHERE key='schema'").get() as any; if (schema?.value !== '1') throw new Error('Unsupported backup schema'); } finally { probe.close(); }
  try { await stat(dataDir); throw new Error('Restore requires a new destination directory'); } catch (error:any) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(dataDir,{recursive:true,mode:0o700}); const path = join(dataDir,'bookkeeping.sqlite'); await copyFile(source,path,1); await chmod(path,0o600); return {path,sha256:digest(await readFile(path))};
}
