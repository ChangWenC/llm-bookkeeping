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
    let anyKnown = false;
    let allComplete = true;
    for (const provider of providers) {
        const relevant = records.filter(record => record.provider === provider.provider && record.account_id === provider.account_id);
        const intervals: [
            number,
            number
        ][] = [];
        for (const record of relevant) {
            if (!['unknown', 'unavailable', 'disabled'].includes(record.capture_status))
                anyKnown = true;
            if (record.capture_status !== 'complete' || record.review_status !== 'complete' || record.gaps.length) {
                allComplete = false;
                continue;
            }
            // Provider discovery coverage is required; a completed individual conversation cannot prove enumeration.
            if (record.conversation_id !== null)
                continue;
            for (const read of record.read_ranges)
                intervals.push([Math.max(Date.parse(read.from), Date.parse(range.from)), Math.min(Date.parse(read.to), Date.parse(range.to), Date.parse(record.cutoff))]);
        }
        intervals.sort((a, b) => a[0] - b[0]);
        let frontier = Date.parse(range.from);
        for (const [from, to] of intervals)
            if (from <= frontier)
                frontier = Math.max(frontier, to);
        if (frontier < Date.parse(range.to))
            allComplete = false;
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
