import type { AnalysisRevisionRef, AnalyticsReviewEvent, BookkeepingConfig, Store } from '../contracts/types.ts';
import { canonical } from '../analytics/serialization.ts';
import { getAnalyticsHistoryRepository } from './analytics.ts';
import { contentHash } from '../analytics/model.ts';
import { validateAnalyticsInput } from '../analytics/validation.ts';
import { record, string, version } from '../contracts/validation.ts';
export interface AnalyticsHistoryRecord {
    kind: 'observation' | 'weekly' | 'review';
    source_id: string;
    logical_id: string;
    revision: number;
    content_hash: string;
    professional_payload: Record<string, unknown>;
}
export interface AnalyticsHistoryMapping {
    source_id: string;
    target_ref: AnalysisRevisionRef;
    weekly_ref?: AnalysisRevisionRef;
    target_content_hash: string;
    weekly_content_hash?: string;
    confidence: 'verified' | 'unresolved';
    reason: string | null;
}
export interface AnalyticsHistoryImport {
    schema_version: 1;
    migration_key: string;
    records: AnalyticsHistoryRecord[];
    mappings: AnalyticsHistoryMapping[];
}
export interface AnalyticsHistoryResult {
    schema_version: 1;
    reused: boolean;
    retained: number;
    activated: number;
    unresolved: number;
}
/** Original legacy records belong to sealed migration data; only explicit professional payloads are accepted here. */
export function createAnalyticsHistoryPort(store: Store, config: BookkeepingConfig) {
    const repository = getAnalyticsHistoryRepository(store);
    return {
        async importHistory(input: AnalyticsHistoryImport): Promise<AnalyticsHistoryResult> {
            version(input);
            string(input.migration_key, 'migration_key');
            if (!Array.isArray(input.records) || !Array.isArray(input.mappings))
                throw new Error('Invalid Analytics history arrays');
            const ids = new Set<string>();
            for (const item of input.records) {
                string(item.source_id, 'source_id');
                string(item.logical_id, 'logical_id');
                if (!['observation', 'weekly', 'review'].includes(item.kind) || !Number.isSafeInteger(item.revision) || item.revision < 1 || !/^[0-9a-f]{64}$/.test(item.content_hash))
                    throw new Error('Invalid legacy Analytics identity');
                record(item.professional_payload, 'professional_payload');
                if (ids.has(item.source_id))
                    throw new Error('Duplicate legacy source ID');
                ids.add(item.source_id);
                if (Object.keys(item.professional_payload).some(key => ['raw', 'body', 'original_record', 'journal_content'].includes(key)))
                    throw new Error('Raw legacy content is not Analytics input');
            }
            const prior = repository.historyRecord(input.migration_key);
            if (prior) {
                const retained = prior;
                if (canonical(retained.input) !== canonical(input))
                    throw new Error('Analytics migration identity conflict');
                return { ...retained.result, reused: true };
            }
            const result = repository.transaction(() => {
                let activated = 0;
                let unresolved = 0;
                // Append history first; activation itself uses the normal exact-revision review transaction.
                for (const mapping of input.mappings) {
                    const legacy = input.records.find(item => item.source_id === mapping.source_id);
                    const target = repository.target(mapping.target_ref);
                    const weekly = mapping.weekly_ref ? repository.target(mapping.weekly_ref) : null;
                    const verified = legacy && mapping.confidence === 'verified' && target && contentHash(target.value) === mapping.target_content_hash && weekly?.kind === 'snapshot' && contentHash(weekly.value) === mapping.weekly_content_hash;
                    if (!verified) {
                        unresolved++;
                        continue;
                    }
                    if (legacy.kind === 'review') {
                        const event = legacy.professional_payload as unknown as AnalyticsReviewEvent;
                        if (canonical(event.target_ref) !== canonical(mapping.target_ref)) {
                            unresolved++;
                            continue;
                        }
                        const validated = validateAnalyticsInput({ schema_version: 1, kind: 'review', events: [event] });
                        const receipt = repository.applyReview(validated, config, true)[0];
                        if (receipt.status === 'applied' || receipt.status === 'already_applied')
                            activated++;
                        else
                            unresolved++;
                    }
                }
                unresolved += input.records.filter(item => !input.mappings.some(mapping => mapping.source_id === item.source_id)).length;
                const result: AnalyticsHistoryResult = { schema_version: 1, reused: false, retained: input.records.length, activated, unresolved };
                repository.saveHistory(input.migration_key, { input, result });
                return result;
            });
            if (result.unresolved)
                await store.enqueueWork({ schema_version: 1, work_id: 'analytics-history:' + input.migration_key, kind: 'needs_review', lane: 'history', state: 'pending', payload: { migration_key: input.migration_key, unresolved: result.unresolved }, reason: 'Exact legacy weekly/target hashes or active revisions unresolved; confirmations not transferred', migration_key: input.migration_key + ':analytics', updated_at: new Date().toISOString() });
            return result;
        },
        async readHistory(): Promise<AnalyticsHistoryImport[]> { return repository.readHistory().map((row: any) => row.input); },
    };
}
