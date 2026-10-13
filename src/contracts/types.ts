/** Public ports: schema_version 1. IDs are opaque strings; every timestamp is UTC ISO ending Z. */
export const SCHEMA_VERSION = 1 as const;
export type SchemaVersion = typeof SCHEMA_VERSION;
export interface Versioned { schema_version: SchemaVersion }
export type Lane = 'live' | 'history';
export type SelectionBasis = 'event_time' | 'capture_lane';
export type ReviewKind = 'daily' | 'weekly' | 'monthly';
export type CaptureStatus = 'complete' | 'partial' | 'unavailable' | 'disabled' | 'unknown';
export type ReviewStatus = 'complete' | 'partial' | 'pending' | 'not_applicable';
export type FactKind = 'fact' | 'inference' | 'recommendation' | 'legacy_record';
export interface UnknownValue<T> extends Versioned { value: T | null; reason: string | null }
export interface TimeRange extends Versioned { from: string; to: string }
/** Paired UTF-8 offsets into the immutable original SourceEvent.body; never slice-relative. */
export interface EventRef extends Versioned { event_id: string; block_id?: string | null; start_byte?: number; end_byte?: number }
export interface FactRef extends Versioned { fact_id: string; revision: number }
export interface SourceIdentity extends Versioned {
  provider: string; account_id: string; conversation_id: string; message_id: string | null; block_id: string | null;
}
export interface SourceEvent extends Versioned {
  event_id: string; source: SourceIdentity; role: string; kind: string; channel: string | null;
  body: string | null; fragment_ref: string | null; physical_order: string;
  original_time: UnknownValue<string>; time_precision: 'minute' | 'second' | 'millisecond' | 'microsecond' | 'nanosecond' | 'day' | 'unknown';
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
export interface PageBaseline extends Versioned { path: string; digest: string; content: string | null; context_excerpt?: boolean; excerpt_reason?: string | null }
export interface ReviewChunk extends Versioned {
  chunk_id: string; events: SourceEvent[]; context_events: SourceEvent[]; body_bytes: number;
}
export interface AnalysisRevisionRef extends Versioned { logical_id: string; revision: number }
export interface ProfessionalFact extends Versioned {
  fact_ref: FactRef; projection: AnalyticsProjection; kind: FactKind;
  occurred_at: UnknownValue<string>;
}
export type AnalysisCoverageStatus = 'complete' | 'partial' | 'unknown';
export interface ValidationAction extends Versioned {
  action_ref: AnalysisRevisionRef; subject: string; description: string;
  evidence_refs: FactRef[]; state: 'active' | 'completed' | 'abandoned';
}
export interface PriorActionDisposition extends Versioned {
  action_ref: AnalysisRevisionRef; disposition: 'continue' | 'narrow' | 'abandon';
  reason: string; evidence_refs: FactRef[];
}
export interface WeeklyObservation extends Versioned {
  observation_ref: AnalysisRevisionRef; summary: string; subject: string;
  kind: 'fact' | 'inference' | 'recommendation'; evidence_refs: FactRef[];
  capability_ids: string[]; responsibility_basis: string;
  stage: 'candidate' | 'formal';
}
export interface CapabilityAssessment extends Versioned {
  capability_id: string; trend: 'improving' | 'stable' | 'declining' | 'unknown';
  explanation: string; evidence_refs: FactRef[];
}
export interface GoalGap extends Versioned {
  goal_ref: AnalysisRevisionRef; description: string; evidence_refs: FactRef[];
}
export interface WeeklyAnalysisSnapshot extends Versioned {
  analysis_ref: AnalysisRevisionRef; week_end: string; coverage_status: AnalysisCoverageStatus;
  observations: WeeklyObservation[]; capabilities: CapabilityAssessment[]; goal_gaps: GoalGap[];
  direction: 'aligned' | 'divergent' | 'unknown'; patterns: string[];
  validation_action: ValidationAction | null;
}
export interface FactsPage extends Versioned { snapshot_id: string; cutoff: string; offset: number; next_offset: number | null; total: number }
export interface WeeklyAnalysisInput extends Versioned {
  analysis_ref?: AnalysisRevisionRef; previous_snapshot?: WeeklyAnalysisSnapshot;
  week_end: string; range: TimeRange; analysis_timezone: 'Europe/Amsterdam';
  facts: ProfessionalFact[]; coverage: SourceCoverage[]; coverage_status: AnalysisCoverageStatus;
  previous_weeks: WeeklyAnalysisSnapshot[]; prior_action: ValidationAction | null;
  confirmed_goal_refs: AnalysisRevisionRef[];
  observation_candidates?: WeeklyObservation[];
  confirmed_goals?: GoalContract[];
  facts_page?: FactsPage; prepared_work_ids?: string[];
  analytics_catalog?: AnalyticsCatalog; goal_page_baselines?: PageBaseline[];
}
export interface WeeklyAnalysisResult extends Versioned {
  snapshot: WeeklyAnalysisSnapshot; prior_action_disposition: PriorActionDisposition | null;
  proposed_confirmations: AnalysisRevisionRef[]; freshness_at: string;
  completed_work_ids?: string[];
}
export interface AnalyticsDefinition extends Versioned {
  definition_ref: AnalysisRevisionRef; label: string; keywords: string[]; status: 'candidate' | 'formal';
}
export interface AnalyticsProjectMapping extends Versioned {
  id: string; wiki_prefix: string; repo_hint: string | null; direction_id: string | null;
}
export interface AnalyticsCatalog extends Versioned {
  capabilities: AnalyticsDefinition[]; directions: AnalyticsDefinition[]; project_mappings: AnalyticsProjectMapping[];
}
export interface AnalyticsAttributionPair extends Versioned {
  observation_ref: AnalysisRevisionRef; capability_ref: AnalysisRevisionRef;
}
export interface AnalyticsPilotStats extends Versioned {
  review_duration_ms: UnknownValue<number>;
  range: TimeRange; weeks: string[];
  coverage: { complete: number; partial: number; unknown: number };
  reviews: { confirmed_pairs: number; corrected_pairs: number; rejected_pairs: number; retracted_reviews: number };
  notifications: { generated: number; active: number };
  actions: { continued: number; narrowed: number; abandoned: number; completed: number; active: number };
}
export interface AnalyticsReviewEvent extends Versioned {
  review_id: string; target_ref: AnalysisRevisionRef;
  action: 'confirm' | 'reject' | 'correct' | 'retract';
  correction: string | null; evidence_refs: FactRef[]; created_at: string;
  selected_pairs?: AnalyticsAttributionPair[]; retracts_review_id?: string | null;
}
export interface GoalContract extends Versioned {
  contract_ref: AnalysisRevisionRef; subject: string; description: string;
  target_version: string; deadline: string | null; confirmed: boolean;
}
export interface MajorDecisionContract extends Versioned {
  contract_ref: AnalysisRevisionRef; subject: string; goal_ref: AnalysisRevisionRef;
  valid_from: string; valid_to: string;
  trigger: { schema_version: SchemaVersion; name: string; expected_value: string };
  confirmed: boolean;
}
export type AnalyticsReviewInput =
  | { schema_version: SchemaVersion; kind: 'review'; events: AnalyticsReviewEvent[] }
  | { schema_version: SchemaVersion; kind: 'goal_contract'; contract: GoalContract }
  | { schema_version: SchemaVersion; kind: 'decision_contract'; contract: MajorDecisionContract }
  | { schema_version: SchemaVersion; kind: 'capability_candidate'; definition: AnalyticsDefinition };
export interface ReviewReceipt extends Versioned {
  review_id: string; target_ref: AnalysisRevisionRef;
  status: 'applied' | 'already_applied' | 'stale' | 'pending'; reason: string | null;
}
export interface ArchiveReviewContext extends Versioned {
  work_id: string; source_path: string; date: string; original_digest: string;
  content_excerpt: string; excerpt_reason: string | null; fact_refs: FactRef[];
}
export interface ArchiveContextPage extends Versioned { offset: number; next_offset: number | null; total: number }
export interface MonthlyReviewInput extends Versioned {
  /** Only frozen outstanding work metadata; prior accepted monthly conclusions stay unchanged. */
  work_only?: boolean;
  month: string; range: TimeRange; facts: FactRevision[]; coverage: SourceCoverage[];
  coverage_status: AnalysisCoverageStatus; manual_baselines: PageBaseline[];
  prepared_work_ids?: string[]; facts_page?: FactsPage;
  archive_contexts?: ArchiveReviewContext[]; archive_context_page?: ArchiveContextPage;
}
export interface MonthlyReviewResult extends Versioned {
  month: string; summary: string; fact_refs: FactRef[];
  supplement_text: string; coverage_status: AnalysisCoverageStatus;
  completed_work_ids?: string[]; completed_archive_context_ids?: string[];
}
export interface ReviewBundle extends Versioned {
  bundle_id: string; kind: ReviewKind; lane: Lane; period: string | null; cutoff: string;
  chunks: ReviewChunk[]; existing_facts: FactRevision[]; baselines: PageBaseline[];
  coverage: SourceCoverage[]; unfinished: CoverageGap[];
  source?: string;
  /** New daily material requires exact evidence/disposition spans for all admitted primary text roles. */
  review_requirements?: ReviewRequirements;
  replay?: SemanticReplayScope;
  /** Explicit daily empty-review intent (at most 32 days); observational coverage is not this range. */
  review_range?: TimeRange;
  /** Effective IANA journal timezone for explicit empty-review range; never inferred from source wire time. */
  review_timezone?: string;
  analysis_context?: WeeklyAnalysisInput; monthly_context?: MonthlyReviewInput;
}
export interface ExplicitVerification extends Versioned { name: string; value: string; subject: string; verified_at: string; event_refs: EventRef[]; basis: 'user_explicit_verification' }
export interface AnalyticsProjection extends Versioned { summary: string; scope: string[]; subject: string; event_refs: EventRef[]; attribution: Record<string, unknown>; verification?: ExplicitVerification }
/** Model-produced IDs are local candidate IDs; the application allocates permanent IDs. */
export interface FactCandidate extends Versioned {
  candidate_id: string; chunk_id: string; disposition: 'keep' | 'add' | 'replace' | 'retract';
  content: string; subject: string; occurred_at: UnknownValue<string>; journal_date: UnknownValue<string>;
  kind: FactKind; analytics_projection: UnknownValue<AnalyticsProjection>; event_refs: EventRef[]; target_refs: FactRef[];
  scope: string[]; attribution: Record<string, unknown>;
}
export interface ChunkReview extends Versioned {
  chunk_id: string; status: 'complete' | 'partial' | 'deferred';
  reviewed_event_ids: string[]; reviewed_spans?: ReviewUnit[]; zero_facts: boolean; reason: string | null;
}
export interface JournalSuggestion extends Versioned {
  suggestion_id: string; date: string; path: string; baseline_digest: string;
  mode: 'append' | 'replace'; old_text: string | null; new_text: string; candidate_ids: string[];
}
export interface ReviewResult extends Versioned {
  result_id: string; bundle_id: string; chunks: ChunkReview[]; candidates: FactCandidate[];
  pages: JournalSuggestion[]; created_at: string;
  source?: string;
  journal_dispositions?: JournalDisposition[];
  unit_dispositions?: ReviewUnitDisposition[];
  analysis?: WeeklyAnalysisResult; monthly_review?: MonthlyReviewResult;
}
export interface FactRevision extends Versioned {
  fact_id: string; revision: number; event_refs: EventRef[]; content: string; subject: string;
  occurred_at: UnknownValue<string>; journal_date: UnknownValue<string>; kind: FactKind;
  analytics_projection: UnknownValue<AnalyticsProjection>;
  action: 'assert' | 'replace' | 'retract'; target_refs: FactRef[]; scope: string[];
  attribution: Record<string, unknown>; recorded_at: string; legacy_locator?: string | null;
}
export interface JournalPatch extends Versioned {
  operation_id: string; date: string; path: string; baseline_digest: string;
  mode: 'append' | 'replace'; old_text: string | null; new_text: string; fact_refs: FactRef[];
  supersedes_operation_id?: string;
}
export interface FactArtifact extends Versioned {
  batch_id: string; created_at: string; facts: FactRevision[]; coverage: SourceCoverage[];
  affected_dates: string[]; affected_weeks: string[];
  affected_months?: string[]; analysis?: WeeklyAnalysisResult; monthly_review?: MonthlyReviewResult;
}
export type FileStatus = 'applied' | 'noop' | 'pending' | 'conflict';
export interface FileOutcome extends Versioned { operation_id: string; path: string; status: FileStatus; reason: string | null; queued_work_ids?: string[]; failure_scope?: 'storage'; failure_code?: string }
export interface ConsumerOutcome extends Versioned { target: string; status: 'complete' | 'pending' | 'partial' | 'unavailable'; reason: string | null; analytics_pilot?: AnalyticsPilotStats; failure_scope?: 'storage'; failure_code?: string }
export interface PublishResult extends Versioned {
  execution_status?: 'complete' | 'partial' | 'storage_unavailable';
  continuation?: { schema_version: 1; stage: 'export' | 'recovery' | 'monthly' | 'result'; status: 'failed'; reason: string };
  result_id: string | null; fact_commit: 'committed' | 'already_committed' | 'pending' | 'failed';
  batch_id: string | null; export_status: 'ready' | 'pending' | 'failed';
  files: FileOutcome[]; consumers: ConsumerOutcome[]; pending: string[];
}
export const ABSENT_DIGEST = 'absent' as const;
/** Persist desired bytes and complete backup BEFORE replacing the target. */
export interface FileIntent extends Versioned {
  operation_id: string; path: string; baseline_digest: string; desired_digest: string;
  desired_bytes_base64: string | null; backup_bytes_base64: string | null;
  /** True survives pre-guard crashes and only tightens confirmation; false/absence grants no exemption. */
  journal_confirmation_required?: boolean;
  state: 'prepared' | 'applied' | 'pending' | 'conflict' | 'superseded'; fact_refs: FactRef[];
  created_at: string; reason: string | null;
  supersedes_operation_id?: string;
}
export interface OutboxEntry extends Versioned { batch_id: string; artifact: FactArtifact; status: 'pending' | 'ready'; export_path: string | null }
export interface ConsumerAck extends Versioned { consumer: string; batch_id: string; acknowledged_at: string }
export interface WorkItem extends Versioned {
  work_id: string; kind: string; lane: Lane; state: 'pending' | 'complete' | 'deferred';
  payload: Record<string, unknown>; reason: string | null; migration_key: string | null; updated_at: string;
}
export interface LegacyIdMapping extends Versioned { source_id: string; target_id: string | null; confidence: 'verified' | 'unresolved'; reason: string | null }
export interface LegacyImportBatch extends Versioned { migration_key: string; facts: FactRevision[]; mappings: LegacyIdMapping[]; work: WorkItem[] }
export interface LegacyImportResult extends Versioned { migration_key: string; reused: boolean; imported_facts: number; unresolved: number }
export interface ReviewCommit extends Versioned { result_id: string; batch_id: string; reused: boolean; facts: FactRevision[]; patches: JournalPatch[] }
export interface EventQuery { range: TimeRange; lane?: Lane; limit?: number; after?: string; include_context?: boolean; source?: string; selection_basis?: SelectionBasis }
export interface FactQuery { range: TimeRange; scope?: string[]; as_of?: string }
export interface SemanticReplayRequest extends Versioned { replay_key: string; source: string; range: TimeRange; cutoff: string; event_ids?: string[] }
export interface SemanticReplayScope extends Versioned { work_id: string; source: string; range: TimeRange }
/** Original immutable source identity and exact UTF-8 interval, never a transient slice ID. */
export interface ReviewUnit extends Versioned { event_id: string; start_byte: number; end_byte: number }
export interface ReviewRequirements extends Versioned { unit_dispositions: true; inspection_version: 2; completion_policy?: 'primary_spans_v1' }
export type ReviewUnitDispositionKind = 'no_persistent_information' | 'covered_by_facts' | 'defer';
/** Exact admitted primary text intervals of every role only; groups never imply unseen source completion. */
export interface ReviewUnitDisposition extends Versioned {
  units: ReviewUnit[]; disposition: ReviewUnitDispositionKind; fact_refs: FactRef[]; reason: string;
}
export interface PrepareRequest { kind: ReviewKind; lane: Lane; period?: string; cutoff: string; output_dir?: string;
  work_only?: boolean;
  context_fact_refs?: FactRef[];
  selection_basis?: SelectionBasis; candidate_continuation?: PreparationContinuation; page_paths?: string[]; fact_offset?: number; fact_snapshot?: string; archive_context_offset?: number; replay_id?: string; source?: string; max_bundles?: number; range?: TimeRange; skip_units?: ReviewUnit[] }

export type JournalDispositionKind = 'patch' | 'already_present' | 'not_needed' | 'defer';
export type JournalConsistency = 'consistent' | 'conflicting' | 'unknown';
export type JournalDimensionComparison = JournalConsistency | 'not_applicable';
export type JournalSemanticRelation = 'new' | 'clarification' | 'correction' | 'unknown';
/** Semantic declarations, not automated semantic equivalence proofs. */
export interface JournalAssessmentDimensions {
  subject: JournalDimensionComparison; action: JournalDimensionComparison; time: JournalDimensionComparison;
  result: JournalDimensionComparison; negation: JournalDimensionComparison;
}
/** Exact complete Markdown paragraph/list item in full baseline UTF-8 bytes, outside frontmatter. */
export interface JournalBaselineEvidence extends Versioned {
  section: 'body'; kind: 'paragraph' | 'list_item'; start_byte: number; end_byte: number;
  text: string; dimensions: JournalAssessmentDimensions;
}
/** Summary and body are assessed independently. Old accepted declarations remain immutable. */
export interface JournalBaselineAssessment extends Versioned {
  baseline_digest: string; summary_text: string | null; body_evidence_text: string;
  consistency: JournalConsistency; reason: string;
  relation?: JournalSemanticRelation; summary_consistency?: JournalConsistency; body_consistency?: JournalConsistency;
  summary_dimensions?: JournalAssessmentDimensions;
  body_evidence?: JournalBaselineEvidence[];
}

/** Acceptance uses local candidate IDs; Store freezes allocated fact refs in journal work. */
export interface JournalDisposition extends Versioned {
  candidate_id: string; date: string; path: string; disposition: JournalDispositionKind;
  suggestion_id?: string; evidence_text?: string; baseline_assessment?: JournalBaselineAssessment; reason: string | null;
}
export interface JournalPublicationPayload extends Versioned {
  fact_ref: FactRef; date: string; path: string; target_refs: FactRef[];
  operation_id?: string; disposition?: JournalDispositionKind;
}
export interface JournalWorkRequest extends Versioned { cutoff: string; work_ids?: string[]; max_items?: number }
export interface JournalWorkBundle extends Versioned {
  journal_bundle_id: string; cutoff: string; work: WorkItem[]; facts: FactRevision[];
  existing_facts: FactRevision[]; baselines: PageBaseline[]; conflicts: FileOutcome[];
}
export interface JournalWorkSuggestion extends Versioned {
  suggestion_id: string; work_ids: string[]; date: string; path: string; baseline_digest: string;
  mode: 'append' | 'replace'; old_text: string | null; new_text: string;
  supersedes_operation_id?: string;
}
export interface JournalWorkDisposition extends Versioned {
  work_id: string; disposition: JournalDispositionKind; suggestion_id?: string; evidence_text?: string; baseline_assessment?: JournalBaselineAssessment; reason: string | null;
}
/** File resolution only: no chunk completion, fact candidates or fact outbox. */
export interface JournalResolution extends Versioned {
  resolution_id: string; journal_bundle_id: string; created_at: string;
  dispositions: JournalWorkDisposition[]; pages: JournalWorkSuggestion[];
}
/** Complete immutable user-confirmation proposal; source instructions grant no authority. */
export interface JournalConfirmationProposal extends Versioned {
  proposal_id: string; proposal_digest: string; operation_id: string; path: string;
  baseline_digest: string; desired_digest: string; old_text: string; new_text: string;
  fact_refs: FactRef[]; work_ids: string[]; reason: string;
  state: 'awaiting_user_confirmation' | 'confirmed' | 'keep_existing' | 'stale';
}
export interface JournalConfirmationRequest extends Versioned {
  patch?: JournalPatch; intent?: FileIntent; current_baseline_digest: string;
  old_text: string; new_text: string; reason: string;
  work_ids?: string[]; requires_confirmation: boolean;
}
export interface JournalConfirmationGuard extends Versioned {
  status: 'not_required' | 'confirmed' | 'awaiting_user_confirmation' | 'keep_existing' | 'stale';
  proposal_id: string | null; work_ids: string[]; reason: string | null;
}
/** Cooperative chat confirmation only; fields record an explicit response, not authenticated identity. */
export interface JournalUserDecision extends Versioned {
  decision_id: string; proposal_id: string; proposal_digest: string;
  decision: 'confirm' | 'keep_existing'; basis: 'explicit_user_response';
  baseline_digest: string; fact_refs: FactRef[]; work_ids: string[]; reason: string;
  response_source?: string; response_content?: string;
}
export interface JournalUserDecisionReceipt extends Versioned {
  decision_id: string; proposal_id: string; status: 'confirmed' | 'keep_existing' | 'stale';
  operation_id: string; work_ids: string[]; reason: string | null;
}
export interface JournalResolutionCommit extends Versioned {
  resolution_id: string; reused: boolean; patches: JournalPatch[]; work_ids: string[];
}
export interface DailyRoundLimits extends Versioned {
  task_duration_ms: number; capture_duration_ms: number; semantic_start_duration_ms: number;
  wave_bundles: number; live_bundles: number; history_bundles: number; max_started_bundles: number;
}
/** Acceptance time is measured by Store; model-created timestamps are not that evidence. */
export interface AcceptedDailyInventoryRequest { from: string; to: string; after_result_id?: string; limit?: number; include_unknown_acceptance?: boolean }
export interface AcceptedDailyInventoryItem {
  result_id: string; accepted_at: UnknownValue<string>; result_created_at: string;
  acceptance_time_basis: 'store_transaction_clock' | 'unknown_legacy_result_time'; window_membership: 'included' | 'unknown';
  bundle: ReviewBundle; result: ReviewResult; commit: ReviewCommit; facts: FactRevision[]; targets: FactRevision[];
  patches: { patch: JournalPatch; status: string; reason: string | null }[]; conflicts: FileOutcome[];
}
export interface AcceptedDailyInventory extends Versioned { items: AcceptedDailyInventoryItem[]; next_result_id: string | null }
export interface JournalRecoveryRequest extends Versioned { result_ids: string[]; created_at: string }
export interface JournalRecoveryReceipt extends Versioned { result_ids: string[]; work_ids: string[] }
/** Coordinator-selected bounded audit; no source/fact acceptance is rewritten. */
export interface ReviewRiskInventoryRequest extends Versioned {
  from: string; to: string; limit?: number; after_result_id?: string; known_mixed_event_ids?: string[];
}
export interface ReviewRiskInventoryItem extends Versioned {
  result_id: string; accepted_at: UnknownValue<string>; acceptance_time_basis: 'store_transaction_clock';
  primary_units: number; other_primary_zero_candidate_completed: number;
  known_mixed_event_completed_ids: string[]; weak_closed_journal_work_ids: string[];
}
export interface ReviewRiskInventory extends Versioned {
  items: ReviewRiskInventoryItem[]; next_result_id: string | null; unknown_legacy_acceptance_count: number;
}
export interface JournalReassessmentRequest extends Versioned {
  work_ids: string[]; mode: 'preview' | 'apply'; created_at: string; expected_plan_digest?: string;
}
export interface JournalReassessmentItem extends Versioned { work_id: string; eligible: boolean; reason: string }
export interface JournalReassessmentReceipt extends Versioned {
  plan_digest: string; items: JournalReassessmentItem[]; reopened_work_ids: string[];
}
export interface WikiWriterLock { readonly root: string; readonly token: string; release(): Promise<void> }
export interface CollectRequest { lane: Lane; cutoff: string; range: TimeRange; budget: CollectionBudget }
export interface CollectionBudget { max_duration_ms: number; max_bytes: number; max_directory_entries: number }
export interface AdapterContext { checkpoints: SourceCheckpoint[]; config: BookkeepingConfig; generation_checkpoints?: readonly SourceCheckpoint[] }
export interface SourceAdapter {
  readonly provider: string;
  readonly account_id?: string;
  close?(): void | Promise<void>;
  collect(request: CollectRequest, context: AdapterContext): AsyncIterable<CollectionBatch>;
  replay?(range: TimeRange, context: AdapterContext): AsyncIterable<CollectionBatch>;
}
/** Private inline configuration: never commit real entries. Stable native contact IDs only. */
export interface WechatPersonMapping extends Versioned {
  wxid: string; display_name: string; wiki_path: string; relationship: string; verified: true;
}
/** Undefined allowlist retains prior participation policy; [] excludes every group. */
export interface WechatScopeOptions { group_allowlist?: string[]; private_person_registry?: WechatPersonMapping[] }
export interface PreparationScope extends Versioned {
  source: string; lane: Lane; range: TimeRange; cutoff: string; selection_basis: SelectionBasis;
}
/** Opaque cursor; only Reviewer/Store produce it. Bound to the complete frozen scope. */
export interface PreparationContinuation extends Versioned { scope: PreparationScope; cursor: string }
export interface DeferredReviewUnit extends Versioned { unit: ReviewUnit; reason: string }
export type PreparationPhase = 'candidates' | 'facts' | 'coverage' | 'baselines' | 'bundle';
/** Digest of actual stable stage/frontier/selected/deferred state, never of a random cursor ID. */
export interface PreparationProgress extends Versioned {
  phase: PreparationPhase; frontier: string; advanced: boolean;
  stages: PreparationStageProgress[];
}
export interface PreparationStageProgress extends Versioned { phase: PreparationPhase; rows: number; elapsed_ms: number }
export interface CandidatePreparation extends Versioned {
  state: 'ready' | 'more' | 'exhausted' | 'unavailable'; scope: PreparationScope;
  continuation: PreparationContinuation | null;
  scanned: { pages: number; rows: number; elapsed_ms: number };
  deferred_units: DeferredReviewUnit[];
  progress?: PreparationProgress;
}
export interface PublicationOutboxPageRequest extends Versioned { status: 'pending' | 'ready'; limit: number; after?: string }
export interface PublicationOutboxPage extends Versioned { items: OutboxEntry[]; next_cursor: string | null }
export interface PublicationFilePageRequest extends Versioned { states: FileIntent['state'][]; limit: number; after?: string }
export interface PublicationFilePage extends Versioned { items: FileIntent[]; next_cursor: string | null }
export type PublicationRecoveryKind = 'ready_exports' | 'applied_intents';
export interface MonthlySemanticDebt extends Versioned {
  month: string; pending_count: number; oldest_at: UnknownValue<string>; reasons: string[];
  eligible: boolean; continuation: FactsPage | null;
}
/** Progress for exactly one immutable ref manifest; no facts or source text is loaded. */
export interface FactMaterialProgress extends Versioned {
  snapshot_id: string; cutoff: string; total: number; first_unread_offset: number | null;
  /** Count exact frozen IDs whose current state is not complete, including missing IDs. */
  pending_work_count: number; pending_archive_context_count: number;
}
export interface MonthlySemanticStatus extends Versioned {
  cutoff: string; pending_count: number; oldest_month: string | null; months: MonthlySemanticDebt[];
}
export interface MonthlyRoundLimits extends Versioned { task_duration_ms: number; semantic_start_duration_ms: number; max_started_bundles: number }
export interface ProviderStageOutcome extends Versioned {
  provider: string; stage: 'prepare' | 'material' | 'publish';
  execution_status: 'complete' | 'partial' | 'unavailable'; reason: string | null; bundle_ids: string[];
  preparation?: CandidatePreparation;
}
export interface PreparationResult extends Versioned { bundles: ReviewBundle[]; providers: ProviderStageOutcome[] }
export interface ProviderConfig extends Versioned {
  provider: string; enabled: boolean; roots: string[]; account_id: string;
  options: Record<string, unknown>;
}
export interface JournalTimezoneEntry extends Versioned { effective_from: string; timezone: string; basis: string }
export interface PublicCliCommand extends Versioned { executable: string; args: string[]; timeout_ms?: number }
export interface IndexCommands extends Versioned { lint: PublicCliCommand; build_index: PublicCliCommand; qmd: PublicCliCommand }
export interface PageTargetsManifest extends Versioned { paths: string[] }
export interface MigrationLimits { max_bytes?: number; max_records?: number; max_record_bytes?: number; max_duration_ms?: number }
/** Private exact stored-event semantic read restrictions; never review completion. */
export interface ReviewReadExclusion extends Versioned { event_id: string; reason: string }
export interface ReviewReadExclusions extends Versioned { events: ReviewReadExclusion[] }
export interface ReviewReadExclusionMetadata extends Versioned { event_id: string; reason: string; provider: string; account_id: string; unreviewed: boolean }
export interface BookkeepingConfig extends Versioned {
  wiki_root: string; data_dir: string; journal_timezone: string; analysis_timezone: 'Europe/Amsterdam';
  cutover_at: string; live_start: string; journal_timezone_timeline: JournalTimezoneEntry[]; providers: ProviderConfig[];
  limits: { chunk_events: number; chunk_body_bytes: number; bundle_bytes: number; bundles_per_round: number };
  index_commands?: IndexCommands;
  migration_limits?: MigrationLimits;
  analytics_catalog?: AnalyticsCatalog;
  collection_budgets?: { live: CollectionBudget; history: CollectionBudget };
  daily_round_limits?: DailyRoundLimits;
  monthly_round_limits?: MonthlyRoundLimits;
  review_read_exclusions?: ReviewReadExclusions;
  project_whitelist: string[]; goal_whitelist: string[];
}
/** One SQLite owner. commitReview MUST atomically persist result, allocated revisions,
 * chunk completion, file patches, and fact outbox; accepted results are reused by result/bundle ID. */
export interface Store {
  close(): void | Promise<void>;
  allocateId(namespace: string): string;
  saveCollection(batch: CollectionBatch): Promise<void>;
  requestSemanticReplay(request: SemanticReplayRequest): Promise<WorkItem>;
  getSemanticReplay(work_id: string): Promise<WorkItem | null>;
  getCheckpoints(provider: string, lane: Lane): Promise<SourceCheckpoint[]>;
  listEvents(query: EventQuery): Promise<SourceEvent[]>;
  listCoverage(range: TimeRange): Promise<SourceCoverage[]>;
  saveBundle(bundle: ReviewBundle): Promise<void>;
  getBundle(bundle_id: string): Promise<ReviewBundle | null>;
  reviewReadExclusions?(range?: TimeRange, source?: string): ReviewReadExclusionMetadata[] | Promise<ReviewReadExclusionMetadata[]>;
  assertReviewBundleReadable?(bundle_id: string): void | Promise<void>;
  listPendingChunks(range: TimeRange, lane: Lane): Promise<ReviewChunk[]>;
  getReviewResult(result_id: string): Promise<ReviewResult | null>;
  acceptedReviewIdentity?(bundle_id: string): Promise<{ schema_version: 1; result_id: string; batch_id: string } | null>;
  commitReview(result: ReviewResult): Promise<ReviewCommit>;
  acceptedJournalResolutionIdentity?(journal_bundle_id: string): Promise<{schema_version:1;resolution_id:string}|null>;
  commitJournalResolution?(resolution: JournalResolution): Promise<JournalResolutionCommit>;
  listJournalConflicts?(): Promise<FileOutcome[]>;
  ensureJournalConfirmation?(request: JournalConfirmationRequest, lock: WikiWriterLock): Promise<JournalConfirmationGuard>;
  validateJournalConfirmation?(intent: FileIntent, lock: WikiWriterLock): Promise<JournalConfirmationGuard>;
  getJournalConfirmation?(proposal_id: string): Promise<JournalConfirmationProposal | null>;
  decideJournalConfirmation?(decision: JournalUserDecision, lock: WikiWriterLock): Promise<JournalUserDecisionReceipt>;
  inventoryAcceptedDaily?(request: AcceptedDailyInventoryRequest): Promise<AcceptedDailyInventory>;
  recoverJournalPublication?(request: JournalRecoveryRequest): Promise<JournalRecoveryReceipt>;
  reassessJournalPublication?(request: JournalReassessmentRequest): Promise<JournalReassessmentReceipt>;
  inventoryReviewRisks?(request: ReviewRiskInventoryRequest): Promise<ReviewRiskInventory>;
  getOperationSupersession?(operation_id: string): Promise<string | null>;
  lookupFactRevisions?(refs: FactRef[]): FactRevision[] | Promise<FactRevision[]>;
  completeJournalDisplay?(work_ids: string[], publication_operation_id: string, lock: WikiWriterLock): Promise<void>;
  listPendingPatches(): Promise<JournalPatch[]>;
  markPatchStatus(operation_id: string, status: FileStatus, reason?: string | null): Promise<void>;
  importLegacy(batch: LegacyImportBatch): Promise<LegacyImportResult>;
  readEffectiveFacts(query: FactQuery): Promise<FactRevision[]>;
  listOutbox(status?: 'pending' | 'ready'): Promise<OutboxEntry[]>;
  getPublicationOutbox?(batch_id: string): Promise<OutboxEntry | null>;
  getPublicationBatchOrder?(batch_id: string): Promise<number | null>;
  listPublicationOutbox?(request: PublicationOutboxPageRequest): Promise<PublicationOutboxPage>;
  listPublicationFileIntents?(request: PublicationFilePageRequest): Promise<PublicationFilePage>;
  getPublicationRecoveryCursor?(kind: PublicationRecoveryKind): Promise<string | null>;
  setPublicationRecoveryCursor?(kind: PublicationRecoveryKind, cursor: string | null): Promise<void>;
  monthlySemanticStatus?(cutoff: string, as_of?: string): Promise<MonthlySemanticStatus>;
  factMaterialProgress?(snapshot_id: string): Promise<FactMaterialProgress | null>;
  /** Exact accepted complete monthly conclusion proof; no source/fact text is returned. */
  hasCompleteMonthlyConclusion?(snapshot_id: string): Promise<boolean>;
  markExportReady(batch_id: string, export_path: string): Promise<void>;
  listReadyBatches(consumer: string, limit?: number, after_batch_id?: string): Promise<FactArtifact[]>;
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
  prepareWithOutcomes?(request: PrepareRequest): Promise<PreparationResult>;
  accept(result: ReviewResult): Promise<ReviewCommit>;
  prepareJournalWork?(request: JournalWorkRequest): Promise<JournalWorkBundle>;
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
  close?(): void | Promise<void>;
  /** Cooperative budget shared by nested publishers/writers/consumers. */
  setDeadline?(deadline_at: string): void;
  store: Store; adapters: SourceAdapter[]; reviewer: Reviewer; publisher: Publisher;
  consumers: Consumer[];
  archive?: (request: ArchiveRequest) => Promise<unknown>;
  importManifest?: (manifest: Manifest) => Promise<unknown>;
  migrateManifest?: (manifest: Manifest) => Promise<unknown>;
  analyticsReview?: (input: unknown) => Promise<unknown>;
  restore?: (input: string, data_dir: string) => Promise<unknown>;
  validate?: (scope: 'changed' | 'all') => Promise<unknown>;
}
