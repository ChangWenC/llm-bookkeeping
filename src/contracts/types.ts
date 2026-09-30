/** Public ports: schema_version 1. IDs are opaque strings; every timestamp is UTC ISO ending Z. */
export const SCHEMA_VERSION = 1 as const;
export type SchemaVersion = typeof SCHEMA_VERSION;
export interface Versioned { schema_version: SchemaVersion }
export type Lane = 'live' | 'history';
export type ReviewKind = 'daily' | 'weekly' | 'monthly';
export type CaptureStatus = 'complete' | 'partial' | 'unavailable' | 'disabled' | 'unknown';
export type ReviewStatus = 'complete' | 'partial' | 'pending' | 'not_applicable';
export type FactKind = 'fact' | 'inference' | 'recommendation' | 'legacy_record';
export interface UnknownValue<T> extends Versioned { value: T | null; reason: string | null }
export interface TimeRange extends Versioned { from: string; to: string }
export interface EventRef extends Versioned { event_id: string; block_id?: string | null }
export interface FactRef extends Versioned { fact_id: string; revision: number }
export interface SourceIdentity extends Versioned {
  provider: string; account_id: string; conversation_id: string; message_id: string | null; block_id: string | null;
}
export interface SourceEvent extends Versioned {
  event_id: string; source: SourceIdentity; role: string; kind: string; channel: string | null;
  body: string | null; fragment_ref: string | null; physical_order: string;
  original_time: UnknownValue<string>; time_precision: 'second' | 'millisecond' | 'microsecond' | 'day' | 'unknown';
  utc_time: UnknownValue<string>; wire_timezone: UnknownValue<string>;
  journal_timezone: UnknownValue<string>; journal_timezone_basis: string | null;
  journal_date: UnknownValue<string>; classification: 'main' | 'subagent' | 'automation' | 'unknown';
  context: Record<string, unknown>; locator: string; generation: string;
}
export interface CoverageGap extends Versioned { range: TimeRange | null; reason: string; locator: string | null; resumable: boolean }
export interface SourceCoverage extends Versioned {
  coverage_id: string; provider: string; account_id: string; conversation_id: string | null; lane: Lane;
  query_range: TimeRange; cutoff: string; read_ranges: TimeRange[]; gaps: CoverageGap[];
  capture_status: CaptureStatus; review_status: ReviewStatus;
}
export interface SourceCheckpoint extends Versioned {
  checkpoint_id: string; provider: string; lane: Lane; locator: string; generation: string;
  cursor: Record<string, unknown>; updated_at: string;
}
export interface RawFragment extends Versioned { fragment_id: string; locator: string; bytes_base64: string; sha256: string }
export interface CollectionBatch extends Versioned {
  batch_id: string; events: SourceEvent[]; fragments: RawFragment[]; coverage: SourceCoverage[]; checkpoints: SourceCheckpoint[];
}
export interface PageBaseline extends Versioned { path: string; digest: string; content: string | null }
export interface ReviewChunk extends Versioned {
  chunk_id: string; events: SourceEvent[]; context_events: SourceEvent[]; body_bytes: number;
}
export interface ReviewBundle extends Versioned {
  bundle_id: string; kind: ReviewKind; lane: Lane; period: string | null; cutoff: string;
  chunks: ReviewChunk[]; existing_facts: FactRevision[]; baselines: PageBaseline[];
  coverage: SourceCoverage[]; unfinished: CoverageGap[];
}
/** Model-produced IDs are local candidate IDs; the application allocates permanent IDs. */
export interface FactCandidate extends Versioned {
  candidate_id: string; chunk_id: string; disposition: 'keep' | 'add' | 'replace' | 'retract';
  content: string; subject: string; occurred_at: UnknownValue<string>; journal_date: UnknownValue<string>;
  kind: FactKind; event_refs: EventRef[]; target_refs: FactRef[];
  scope: string[]; attribution: Record<string, unknown>;
}
export interface ChunkReview extends Versioned {
  chunk_id: string; status: 'complete' | 'partial' | 'deferred';
  reviewed_event_ids: string[]; zero_facts: boolean; reason: string | null;
}
export interface JournalSuggestion extends Versioned {
  suggestion_id: string; date: string; path: string; baseline_digest: string;
  mode: 'append' | 'replace'; old_text: string | null; new_text: string; candidate_ids: string[];
}
export interface ReviewResult extends Versioned {
  result_id: string; bundle_id: string; chunks: ChunkReview[]; candidates: FactCandidate[];
  pages: JournalSuggestion[]; created_at: string;
}
export interface FactRevision extends Versioned {
  fact_id: string; revision: number; event_refs: EventRef[]; content: string; subject: string;
  occurred_at: UnknownValue<string>; journal_date: UnknownValue<string>; kind: FactKind;
  action: 'assert' | 'replace' | 'retract'; target_refs: FactRef[]; scope: string[];
  attribution: Record<string, unknown>; recorded_at: string; legacy_locator?: string | null;
}
export interface JournalPatch extends Versioned {
  operation_id: string; date: string; path: string; baseline_digest: string;
  mode: 'append' | 'replace'; old_text: string | null; new_text: string; fact_refs: FactRef[];
}
export interface FactArtifact extends Versioned {
  batch_id: string; created_at: string; facts: FactRevision[]; coverage: SourceCoverage[];
  affected_dates: string[]; affected_weeks: string[];
}
export type FileStatus = 'applied' | 'noop' | 'pending' | 'conflict';
export interface FileOutcome extends Versioned { operation_id: string; path: string; status: FileStatus; reason: string | null }
export interface ConsumerOutcome extends Versioned { target: string; status: 'complete' | 'pending' | 'partial' | 'unavailable'; reason: string | null }
export interface PublishResult extends Versioned {
  result_id: string | null; fact_commit: 'committed' | 'already_committed' | 'pending' | 'failed';
  batch_id: string | null; export_status: 'ready' | 'pending' | 'failed';
  files: FileOutcome[]; consumers: ConsumerOutcome[]; pending: string[];
}
export const ABSENT_DIGEST = 'absent' as const;
/** Persist desired bytes and complete backup BEFORE replacing the target. */
export interface FileIntent extends Versioned {
  operation_id: string; path: string; baseline_digest: string; desired_digest: string;
  desired_bytes_base64: string | null; backup_bytes_base64: string | null;
  state: 'prepared' | 'applied' | 'pending' | 'conflict'; fact_refs: FactRef[];
  created_at: string; reason: string | null;
}
export interface OutboxEntry extends Versioned { batch_id: string; artifact: FactArtifact; status: 'pending' | 'ready'; export_path: string | null }
export interface ConsumerAck extends Versioned { consumer: string; batch_id: string; acknowledged_at: string }
export interface WorkItem extends Versioned {
  work_id: string; kind: string; lane: Lane; state: 'pending' | 'complete' | 'deferred';
  payload: Record<string, unknown>; reason: string | null; migration_key: string | null; updated_at: string;
}
export interface ReviewCommit extends Versioned { result_id: string; batch_id: string; reused: boolean; facts: FactRevision[]; patches: JournalPatch[] }
export interface EventQuery { range: TimeRange; lane?: Lane; limit?: number; after?: string; include_context?: boolean }
export interface FactQuery { range: TimeRange; scope?: string[]; as_of?: string }
export interface PrepareRequest { kind: ReviewKind; lane: Lane; period?: string; cutoff: string; output_dir?: string }
export interface CollectRequest { lane: Lane; cutoff: string; range: TimeRange; budget: CollectionBudget }
export interface CollectionBudget { max_duration_ms: number; max_bytes: number; max_directory_entries: number }
export interface AdapterContext { checkpoints: SourceCheckpoint[]; config: BookkeepingConfig }
export interface SourceAdapter {
  readonly provider: string;
  collect(request: CollectRequest, context: AdapterContext): AsyncIterable<CollectionBatch>;
  replay?(range: TimeRange, context: AdapterContext): AsyncIterable<CollectionBatch>;
}
export interface ProviderConfig extends Versioned {
  provider: string; enabled: boolean; roots: string[]; account_id: string;
  options: Record<string, unknown>;
}
export interface JournalTimezoneEntry extends Versioned { effective_from: string; timezone: string; basis: string }
export interface BookkeepingConfig extends Versioned {
  wiki_root: string; data_dir: string; journal_timezone: string; analysis_timezone: 'Europe/Amsterdam';
  cutover_at: string; live_start: string; journal_timezone_timeline: JournalTimezoneEntry[]; providers: ProviderConfig[];
  limits: { chunk_events: number; chunk_body_bytes: number; bundle_bytes: number; bundles_per_round: number };
  project_whitelist: string[]; goal_whitelist: string[];
}
/** One SQLite owner. commitReview MUST atomically persist result, allocated revisions,
 * chunk completion, file patches, and fact outbox; accepted results are reused by result/bundle ID. */
export interface Store {
  close(): void | Promise<void>;
  allocateId(namespace: string): string;
  saveCollection(batch: CollectionBatch): Promise<void>;
  getCheckpoints(provider: string, lane: Lane): Promise<SourceCheckpoint[]>;
  listEvents(query: EventQuery): Promise<SourceEvent[]>;
  listCoverage(range: TimeRange): Promise<SourceCoverage[]>;
  saveBundle(bundle: ReviewBundle): Promise<void>;
  getBundle(bundle_id: string): Promise<ReviewBundle | null>;
  listPendingChunks(range: TimeRange, lane: Lane): Promise<ReviewChunk[]>;
  getReviewResult(result_id: string): Promise<ReviewResult | null>;
  commitReview(result: ReviewResult): Promise<ReviewCommit>;
  readEffectiveFacts(query: FactQuery): Promise<FactRevision[]>;
  listOutbox(status?: 'pending' | 'ready'): Promise<OutboxEntry[]>;
  markExportReady(batch_id: string, export_path: string): Promise<void>;
  listReadyBatches(consumer: string): Promise<FactArtifact[]>;
  acknowledgeConsumer(ack: ConsumerAck): Promise<void>;
  saveFileIntent(intent: FileIntent): Promise<void>;
  getFileIntent(operation_id: string): Promise<FileIntent | null>;
  listFileIntents(states?: FileIntent['state'][]): Promise<FileIntent[]>;
  updateFileIntent(operation_id: string, state: FileIntent['state'], reason?: string | null): Promise<void>;
  enqueueWork(item: WorkItem): Promise<void>;
  listWork(kind?: string, state?: WorkItem['state']): Promise<WorkItem[]>;
  completeWork(work_id: string): Promise<void>;
  status(): Promise<Record<string, unknown>>;
  backup(output_dir: string): Promise<{ path: string; sha256: string }>;
}
export interface Reviewer {
  prepare(request: PrepareRequest): Promise<ReviewBundle[]>;
  accept(result: ReviewResult): Promise<ReviewCommit>;
}
export interface Publisher {
  publish(result: ReviewResult): Promise<PublishResult>;
  resume(): Promise<PublishResult>;
  exportFacts(): Promise<{ ready: string[]; pending: string[] }>;
  applyPatches(patches: JournalPatch[]): Promise<FileOutcome[]>;
}
export interface Consumer { readonly target: string; consume(): Promise<ConsumerOutcome> }
export interface ArchiveRequest { month: string; mode: 'report' | 'apply' }
export interface Manifest extends Versioned { manifest_id: string; kind: 'import' | 'migration'; entries: Record<string, unknown>[] }
/** CLI composition port. Optional capabilities fail explicitly when unavailable. */
export interface RuntimeServices {
  store: Store; adapters: SourceAdapter[]; reviewer: Reviewer; publisher: Publisher;
  consumers: Consumer[];
  archive?: (request: ArchiveRequest) => Promise<unknown>;
  importManifest?: (manifest: Manifest) => Promise<unknown>;
  migrateManifest?: (manifest: Manifest) => Promise<unknown>;
  analyticsReview?: (input: unknown) => Promise<unknown>;
  restore?: (input: string, data_dir: string) => Promise<unknown>;
  validate?: (scope: 'changed' | 'all') => Promise<unknown>;
}
