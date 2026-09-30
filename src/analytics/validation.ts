import type { AnalyticsReviewInput, FactRef, WeeklyAnalysisInput, WeeklyAnalysisResult } from '../contracts/types.ts';
import { array, record, string, utc, version, validateWeeklyAnalysisResult } from '../contracts/validation.ts';
import { analysisKey, factKey } from './model.ts';
import { canonical } from './serialization.ts';
function ref(value: unknown): void {
    const r = version(value, 'revision ref');
    string(r.logical_id, 'logical_id');
    if (!Number.isSafeInteger(r.revision) || r.revision < 1)
        throw new Error('Invalid analysis revision');
}
function evidence(value: unknown): void {
    for (const item of array(value, 'evidence_refs')) {
        const r = version(item);
        string(r.fact_id, 'fact_id');
        if (!Number.isSafeInteger(r.revision) || r.revision < 1)
            throw new Error('Invalid fact revision');
    }
}
function text(value: unknown, name: string): void { string(value, name); }
export function validateAnalyticsInput(value: unknown): AnalyticsReviewInput {
    const input = version(value, 'analytics review input');
    if (input.kind === 'review') {
        const events = array(input.events, 'events');
        if (!events.length)
            throw new Error('Review input requires at least one event');
        const ids = new Set<string>();
        for (const item of events) {
            const event = version(item);
            text(event.review_id, 'review_id');
            ref(event.target_ref);
            evidence(event.evidence_refs);
            utc(event.created_at, 'created_at');
            if (!['confirm', 'reject', 'correct', 'retract'].includes(event.action))
                throw new Error('Invalid review action');
            if (event.action === 'correct')
                text(event.correction, 'correction');
            else if (event.correction !== null)
                throw new Error('Only correction events may have correction text');
            if (ids.has(event.review_id))
                throw new Error('Duplicate review ID');
            ids.add(event.review_id);
        }
    }
    else if (input.kind === 'goal_contract' || input.kind === 'decision_contract') {
        const contract = version(input.contract);
        ref(contract.contract_ref);
        text(contract.subject, 'subject');
        if (contract.confirmed !== false)
            throw new Error('New contracts must be candidate/confirmed:false');
        if (input.kind === 'goal_contract') {
            text(contract.description, 'description');
            text(contract.target_version, 'target_version');
            if (contract.deadline !== null)
                utc(contract.deadline, 'deadline');
        }
        else {
            ref(contract.goal_ref);
            utc(contract.valid_from, 'valid_from');
            utc(contract.valid_to, 'valid_to');
            if (Date.parse(contract.valid_from) >= Date.parse(contract.valid_to))
                throw new Error('Invalid decision validity interval');
            const trigger = version(contract.trigger);
            text(trigger.name, 'trigger.name');
            text(trigger.expected_value, 'trigger.expected_value');
        }
    }
    else
        throw new Error('Unknown Analytics input kind');
    return input as AnalyticsReviewInput;
}
export function validateAnalysisAgainstInput(value: unknown, input: WeeklyAnalysisInput): WeeklyAnalysisResult {
    const result = validateWeeklyAnalysisResult(value);
    const snapshot = result.snapshot;
    const previousSnapshot = input.previous_snapshot;
    const reuse = previousSnapshot && canonical(snapshot) === canonical(previousSnapshot);
    if (!input.analysis_ref || (!reuse && analysisKey(snapshot.analysis_ref) !== analysisKey(input.analysis_ref)))
        throw new Error('Snapshot must use the exact application-prepared weekly revision');
    if (snapshot.week_end !== input.week_end)
        throw new Error('Analysis week differs from prepared week');
    if (input.coverage_status !== 'complete' && snapshot.coverage_status === 'complete')
        throw new Error('Analysis cannot upgrade incomplete prepared coverage');
    const allowed = new Set(input.facts.map(fact => factKey(fact.fact_ref)));
    const check = (refs: FactRef[]): void => {
        if (refs.some(ref => !allowed.has(factKey(ref))))
            throw new Error('Analysis evidence outside prepared professional facts');
    };
    const observationIds = new Set<string>();
    for (const observation of snapshot.observations) {
        if (!observation.evidence_refs.length)
            throw new Error('Observation requires evidence');
        check(observation.evidence_refs);
        if (observationIds.has(analysisKey(observation.observation_ref)))
            throw new Error('Duplicate observation revision');
        observationIds.add(analysisKey(observation.observation_ref));
        const candidate = input.observation_candidates?.find(item => analysisKey(item.observation_ref) === analysisKey(observation.observation_ref));
        if (!candidate || canonical({ ...candidate, stage: 'candidate' }) !== canonical({ ...observation, stage: 'candidate' }))
            throw new Error('Observation must reference the exact application candidate revision');
        const facts = input.facts.filter(fact => observation.evidence_refs.some(ref => factKey(ref) === factKey(fact.fact_ref)));
        if (facts.some(fact => fact.projection.subject !== observation.subject))
            throw new Error('Observation subject differs from evidence attribution');
        if (observation.capability_ids.length && !facts.some(fact => fact.projection.attribution.actor === observation.subject && ['design', 'correction', 'verification', 'ownership'].includes(String(fact.projection.attribution.responsibility))))
            throw new Error('Capability attribution requires explicit responsibility evidence');
    }
    for (const capability of snapshot.capabilities) {
        check(capability.evidence_refs);
        if (capability.trend !== 'unknown' && !capability.evidence_refs.length)
            throw new Error('Capability trend requires evidence');
    }
    for (const goal of snapshot.goal_gaps) {
        check(goal.evidence_refs);
        if (!input.confirmed_goal_refs.some(ref => analysisKey(ref) === analysisKey(goal.goal_ref)))
            throw new Error('Goal gap requires an exact confirmed goal revision');
    }
    const actionEvidence = new Set([...allowed, ...(input.prior_action?.evidence_refs ?? []).map(factKey)]);
    const checkAction = (refs: FactRef[]) => {
        if (refs.some(ref => !actionEvidence.has(factKey(ref))))
            throw new Error('Action evidence outside prepared current facts or prior action');
    };
    if (snapshot.validation_action)
        checkAction(snapshot.validation_action.evidence_refs);
    const previous = input.prior_action;
    const disposition = result.prior_action_disposition;
    if (previous?.state === 'active') {
        if (!disposition || analysisKey(disposition.action_ref) !== analysisKey(previous.action_ref))
            throw new Error('Prior active action requires explicit disposition');
        checkAction(disposition.evidence_refs);
        if (disposition.disposition === 'continue' && (!snapshot.validation_action || analysisKey(snapshot.validation_action.action_ref) !== analysisKey(previous.action_ref) || snapshot.validation_action.state !== 'active'))
            throw new Error('Continue must preserve the prior active action');
        if (disposition.disposition === 'narrow' && (!snapshot.validation_action || snapshot.validation_action.action_ref.logical_id !== previous.action_ref.logical_id || snapshot.validation_action.action_ref.revision !== previous.action_ref.revision + 1 || snapshot.validation_action.state !== 'active'))
            throw new Error('Narrow requires a new revision of the same active action');
    }
    else if (disposition)
        throw new Error('Prior action disposition has no prepared action');
    const targets = new Set([analysisKey(snapshot.analysis_ref), ...snapshot.observations.map(observation => analysisKey(observation.observation_ref)), ...(snapshot.validation_action ? [analysisKey(snapshot.validation_action.action_ref)] : [])]);
    if (result.proposed_confirmations.some(ref => !targets.has(analysisKey(ref))))
        throw new Error('Proposed confirmation refers outside current analysis');
    if (snapshot.observations.some(observation => observation.stage === 'formal'))
        throw new Error('New weekly results propose candidates; only user confirmation promotes formal state');
    return result;
}
