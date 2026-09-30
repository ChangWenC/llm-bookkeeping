import type { AnalysisCoverageStatus, AnalyticsProjection, AnalysisRevisionRef, BookkeepingConfig, FactRef, ProfessionalFact, SourceCoverage, TimeRange, WeeklyObservation } from '../contracts/types.ts';
import { canonical, digest } from './serialization.ts';
export const factKey = (ref: FactRef): string => `${ref.fact_id}:${ref.revision}`;
export const analysisKey = (ref: AnalysisRevisionRef): string => `${ref.logical_id}:${ref.revision}`;
export const observationId = (factId: string): string => 'observation:' + digest(factId);
/** Scope is explicit semantic input. Cwd and source text never establish professional membership. */
export function cropProjection(projection: AnalyticsProjection, config: BookkeepingConfig): AnalyticsProjection | null {
    const allowed = new Set(['career_and_learning']);
    for (const configured of config.project_whitelist)
        allowed.add('project:' + configured.replace(/^project:/, ''));
    for (const configured of config.goal_whitelist)
        allowed.add('goal:' + configured.replace(/^goal:/, ''));
    const scope = projection.scope.map(item => {
        if (['career', 'learning', 'career_and_learning'].includes(item))
            return 'career_and_learning';
        if (item.startsWith('project:') || item.startsWith('goal:'))
            return item;
        if (config.project_whitelist.includes(item))
            return 'project:' + item;
        if (config.goal_whitelist.includes(item))
            return 'goal:' + item;
        return item;
    }).filter(item => allowed.has(item));
    if (!scope.length)
        return null;
    return { ...structuredClone(projection), scope };
}
export function coverageStatus(config: BookkeepingConfig, records: SourceCoverage[], range: TimeRange): AnalysisCoverageStatus {
    const providers = config.providers.filter(provider => provider.enabled);
    if (!providers.length)
        return 'unknown';
    const start = Date.parse(range.from), end = Date.parse(range.to);
    let anyKnown = false;
    let allComplete = true;
    for (const provider of providers) {
        const relevant = records.filter(record => record.provider === provider.provider && record.account_id === provider.account_id && Date.parse(record.query_range.from) < end && Date.parse(record.query_range.to) > start);
        if (relevant.some(record => !['unknown', 'unavailable', 'disabled'].includes(record.capture_status)))
            anyKnown = true;
        const scopes = new Set<string | null>([null, ...relevant.map(record => record.conversation_id)]);
        for (const scope of scopes) {
            const scoped = relevant.filter(record => record.conversation_id === scope);
            // Discovery covers the entire period. Conversation/file obligations cover their explicitly queried intervals.
            const obligations = scope === null ? [[start, end, 0]] : scoped.map(record => [Math.max(start, Date.parse(record.query_range.from)), Math.min(end, Date.parse(record.query_range.to)), Date.parse(record.cutoff)]);
            for (const [from, to, minimumCutoff] of obligations) {
                const intervals = scoped.filter(record => record.capture_status === 'complete' && record.review_status === 'complete' && !record.gaps.length && Date.parse(record.cutoff) >= minimumCutoff).flatMap(record => record.read_ranges.map(read => [Math.max(from, Date.parse(read.from), Date.parse(record.query_range.from)), Math.min(to, Date.parse(read.to), Date.parse(record.query_range.to), Date.parse(record.cutoff))])).sort((a, b) => a[0] - b[0]);
                let frontier = from;
                for (const [left, right] of intervals)
                    if (left <= frontier)
                        frontier = Math.max(frontier, right);
                if (frontier < to)
                    allComplete = false;
            }
        }
    }
    return allComplete ? 'complete' : anyKnown ? 'partial' : 'unknown';
}
/** Activities can be observations without being evidence of capability ownership. */
export function observationFor(fact: ProfessionalFact): WeeklyObservation {
    const explicit = fact.projection.attribution;
    const responsibility = typeof explicit.responsibility === 'string' ? explicit.responsibility.trim() : '';
    const claimedCapabilities = Array.isArray(explicit.capability_ids) ? explicit.capability_ids.filter((id): id is string => typeof id === 'string' && !!id.trim()) : [];
    const basis = responsibility && explicit.actor === fact.projection.subject && ['design', 'correction', 'verification', 'ownership'].includes(responsibility)
        ? responsibility : 'activity_only; responsibility not established';
    return {
        schema_version: 1, observation_ref: { schema_version: 1, logical_id: observationId(fact.fact_ref.fact_id), revision: fact.fact_ref.revision },
        summary: fact.projection.summary, subject: fact.projection.subject,
        kind: fact.kind === 'inference' || fact.kind === 'recommendation' ? fact.kind : 'fact',
        evidence_refs: [fact.fact_ref], capability_ids: basis.startsWith('activity_only') ? [] : claimedCapabilities,
        responsibility_basis: basis, stage: 'candidate',
    };
}
export function contentHash(value: unknown): string { return digest(canonical(value)); }
