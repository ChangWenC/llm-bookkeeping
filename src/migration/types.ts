import type { Manifest, AnalysisRevisionRef, BookkeepingConfig, Store, TimeRange } from '../contracts/types.ts';
export type ImportFormat = 'chatlab-json'|'chatlab-jsonl'|'legacy-json'|'legacy-jsonl';
export interface Budget { max_bytes: number; max_records: number; max_record_bytes: number; max_duration_ms: number }
export interface BaseEntry { kind: string; path: string; source_file_id: string; recorded_at: string; format?: string }
export interface ImportEntry extends BaseEntry {
  kind: 'chat_export'; format: ImportFormat; account_id: string; conversation_id: string; owner_id: string;
  time_source: 'timestamp'|'create_time'|'epoch'; source_timezone: string|null; known_range: TimeRange;
  conversation_type?: 'private'|'group'|'unknown'; identity_verified: boolean; self_ids?: string[]; provider?: string; complete?: boolean;
  pagination?: { limit_hit?: boolean; truncated?: boolean; duplicate_page?: boolean; cursor_verified?: boolean };
}
export interface JournalEntry extends BaseEntry { kind: 'daily_journal'; format: 'jsonl' }
export interface AnalyticsMapping {
  source_id: string; target_ref: AnalysisRevisionRef|null; weekly_ref?: AnalysisRevisionRef;
  target_content_hash: string; weekly_content_hash?: string;
  confidence: 'verified'|'unresolved'; reason: string|null;
}
export interface AnalyticsHistoryRecord {
  kind:'observation'|'weekly'|'review'; source_id:string; logical_id:string; revision:number;
  content_hash:string; professional_payload:Record<string,unknown>;
}
export interface LegacyAnalyticsPort {
  importHistory(input: {schema_version:1;migration_key:string;records:AnalyticsHistoryRecord[];mappings:AnalyticsMapping[]}):Promise<{reused:boolean;retained:number;activated:number;unresolved:number}>;
}
export interface AnalyticsEntry extends BaseEntry {
  kind:'analytics_observation'|'analytics_weekly'|'analytics_review'; format:'jsonl';
  projections?: {source_id:string;content_hash:string;professional_payload:Record<string,unknown>}[];
  mappings?: AnalyticsMapping[];
}
export interface StateEntry extends BaseEntry { kind:'pending_state'; format:'json'|'jsonl'; category?: 'collect'|'review'|'draft'|'consumer'|'index'|'out_of_scope'|'needs_review' }
export type MigrationEntry = ImportEntry|JournalEntry|AnalyticsEntry|StateEntry;
export interface EntryResult { source_file_id:string; kind:string; status:'partial'|'unknown'|'pending'|'inspected'; records:number; bytes_read:number; next_offset:number|null; pending:string[] }
export interface MigrationReport { schema_version:1;manifest_id:string;kind:'import'|'migration'; entries:EntryResult[];budget:Budget; bytes_read:number;records:number;capture_status:'partial'|'unknown' }
export interface MigrationService { importManifest(manifest:Manifest):Promise<MigrationReport>; migrateManifest(manifest:Manifest):Promise<MigrationReport> }
export type MigrationFactory = (store:Store,config:BookkeepingConfig,options?:{analytics?:LegacyAnalyticsPort;budget?:Partial<Budget>})=>MigrationService;
