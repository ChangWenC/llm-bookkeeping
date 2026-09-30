import type { MonthlyReviewResult, WeeklyAnalysisResult, FactRef, WeeklyObservation, CapabilityAssessment, GoalGap } from '../contracts/types.ts';
import { factKey, analysisKey } from './model.ts';
export interface SemanticPage<T> {
    offset: number;
    result: T;
}
const uniqueRefs = (refs: FactRef[]): FactRef[] => [...new Map(refs.map(ref => [factKey(ref), ref])).values()];
/** Combine accepted page conclusions, never raw sources or unaccepted model drafts. */
export function accumulateMonthly(pages: SemanticPage<MonthlyReviewResult>[]): MonthlyReviewResult {
    const sorted = [...pages].sort((a, b) => a.offset - b.offset), latest = sorted.at(-1)!.result;
    if (sorted.length === 1)
        return structuredClone(latest);
    return { ...latest, summary: sorted.map(page => page.result.summary).join('\n\n'), supplement_text: sorted.map(page => page.result.supplement_text).filter(Boolean).join('\n\n'), fact_refs: uniqueRefs(sorted.flatMap(page => page.result.fact_refs)), completed_work_ids: [...new Set(sorted.flatMap(page => page.result.completed_work_ids ?? []))], completed_archive_context_ids: [...new Set(sorted.flatMap(page => page.result.completed_archive_context_ids ?? []))], coverage_status: 'partial' };
}
export function accumulateWeekly(pages: SemanticPage<WeeklyAnalysisResult>[], current: WeeklyAnalysisResult): WeeklyAnalysisResult {
    const sorted = [...pages].sort((a, b) => a.offset - b.offset);
    if (sorted.length === 1)
        return structuredClone(current);
    const observations = new Map<string, WeeklyObservation>(), capabilities = new Map<string, CapabilityAssessment>(), goals = new Map<string, GoalGap>();
    for (const { result } of sorted) {
        for (const observation of result.snapshot.observations) {
            const old = observations.get(observation.observation_ref.logical_id);
            if (!old || old.observation_ref.revision <= observation.observation_ref.revision)
                observations.set(observation.observation_ref.logical_id, observation);
        }
        for (const capability of result.snapshot.capabilities) {
            const old = capabilities.get(capability.capability_id);
            capabilities.set(capability.capability_id, old ? { ...capability, trend: old.trend === capability.trend ? capability.trend : 'unknown', explanation: [old.explanation, capability.explanation].filter((text, index, all) => all.indexOf(text) === index).join('\n'), evidence_refs: uniqueRefs([...old.evidence_refs, ...capability.evidence_refs]) } : capability);
        }
        for (const gap of result.snapshot.goal_gaps) {
            const key = analysisKey(gap.goal_ref), old = goals.get(key);
            goals.set(key, old ? { ...gap, description: [old.description, gap.description].filter((text, index, all) => all.indexOf(text) === index).join('\n'), evidence_refs: uniqueRefs([...old.evidence_refs, ...gap.evidence_refs]) } : gap);
        }
    }
    const directions = new Set(sorted.map(page => page.result.snapshot.direction));
    return { ...current, snapshot: { ...current.snapshot, coverage_status: 'partial', observations: [...observations.values()], capabilities: [...capabilities.values()], goal_gaps: [...goals.values()], direction: directions.size === 1 ? current.snapshot.direction : 'unknown', patterns: [...new Set(sorted.flatMap(page => page.result.snapshot.patterns))], validation_action: current.snapshot.validation_action }, proposed_confirmations: [...new Map([current, ...sorted.map(page => page.result)].flatMap(result => result.proposed_confirmations).map(ref => [analysisKey(ref), ref])).values()].slice(0, 3) };
}
