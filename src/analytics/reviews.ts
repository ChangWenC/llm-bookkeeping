import type { AnalyticsCatalog, AnalyticsDefinition, AnalyticsReviewEvent, AnalysisRevisionRef, WeeklyObservation } from '../contracts/types.ts';
import { analysisKey } from './model.ts';
/** A retraction disables one exact earlier effect. Retracting that retraction restores it. */
export function activeReviews(events: AnalyticsReviewEvent[]): AnalyticsReviewEvent[] {
    const disabled = new Set<string>(), active: AnalyticsReviewEvent[] = [];
    for (const event of [...events].reverse()) {
        if (disabled.has(event.review_id))
            continue;
        if (event.action === 'retract') {
            if (event.retracts_review_id)
                disabled.add(event.retracts_review_id);
        }
        else
            active.unshift(event);
    }
    return active;
}
/** Generic observation confirmation proves observed activity, never all attribution pairs. */
export function activityReview(events: AnalyticsReviewEvent[], ref: AnalysisRevisionRef): AnalyticsReviewEvent | null {
    return activeReviews(events).filter(event => analysisKey(event.target_ref) === analysisKey(ref) && !event.selected_pairs?.length && !(event.action === 'correct' && event.selected_pairs !== undefined)).at(-1) ?? null;
}
export function capabilityMatches(definition: AnalyticsDefinition, capabilityId: string): boolean {
    return definition.definition_ref.logical_id === capabilityId || definition.definition_ref.logical_id === 'capability:' + capabilityId;
}
export function attributionOverlays(observations: WeeklyObservation[], catalog: AnalyticsCatalog, events: AnalyticsReviewEvent[]): Record<string, unknown>[] {
    const active = activeReviews(events);
    return observations.flatMap(observation => {
        if (activityReview(events, observation.observation_ref)?.action === 'reject')
            return [];
        const definitions = catalog.capabilities.filter(definition => observation.capability_ids.some(id => capabilityMatches(definition, id)));
        const states = new Map<string, {
            confirmed: boolean;
            contested: boolean;
            review_id: string;
            correction: string | null;
        }>();
        for (const event of active.filter(event => analysisKey(event.target_ref) === analysisKey(observation.observation_ref) && (event.selected_pairs?.length || (event.action === 'correct' && event.selected_pairs !== undefined)))) {
            const chosen = new Set(event.selected_pairs!.map(pair => analysisKey(pair.capability_ref)));
            for (const definition of definitions) {
                const key = analysisKey(definition.definition_ref);
                if (event.action === 'correct')
                    states.set(key, { confirmed: chosen.has(key), contested: !chosen.has(key), review_id: event.review_id, correction: event.correction });
                else if (chosen.has(key))
                    states.set(key, { confirmed: event.action === 'confirm', contested: event.action === 'reject', review_id: event.review_id, correction: null });
            }
        }
        return definitions.map(definition => {
            const state = states.get(analysisKey(definition.definition_ref));
            return { observation_ref: observation.observation_ref, capability_ref: definition.definition_ref, capability_id: definition.definition_ref.logical_id, label: definition.label,
                responsibility_basis: observation.responsibility_basis, evidence_refs: observation.evidence_refs, confirmed: state?.confirmed ?? false, contested: state?.contested ?? false,
                stage: state?.confirmed && definition.status === 'formal' ? 'formal' : 'candidate', correction: state?.correction ?? null, review_id: state?.review_id ?? null };
        });
    });
}
export function validatePairTargets(event: AnalyticsReviewEvent, observation: WeeklyObservation | null, definitions: AnalyticsDefinition[]): void {
    if (!observation)
        throw new Error('Pair review requires an observation target');
    for (const pair of event.selected_pairs ?? []) {
        if (!observation || analysisKey(pair.observation_ref) !== analysisKey(event.target_ref))
            throw new Error('Pair must bind the exact reviewed observation revision');
        const definition = definitions.find(item => analysisKey(item.definition_ref) === analysisKey(pair.capability_ref));
        if (!definition || !observation.capability_ids.some(id => capabilityMatches(definition, id)))
            throw new Error('Pair must bind a current defined capability attributed by this observation');
        if (observation.responsibility_basis === 'activity_only')
            throw new Error('Attribution pair requires explicit responsibility evidence');
    }
}
