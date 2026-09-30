import type { GoalContract, MajorDecisionContract } from '../contracts/types.ts';
import { utc } from '../contracts/validation.ts';
import { analysisKey } from './model.ts';

/** The confirmation boolean must come from the exact current-revision review fold. */
export function goalActiveAt(goal: GoalContract, asOf: string, confirmed: boolean): boolean {
  const now = Date.parse(utc(asOf, 'asOf'));
  if (!confirmed) return false;
  return goal.deadline === null || now <= Date.parse(utc(goal.deadline, 'goal.deadline'));
}

/** Contract windows are half-open. Registration's `confirmed` field grants no authority. */
export function decisionActiveAt(
  decision: MajorDecisionContract,
  goal: GoalContract,
  asOf: string,
  confirmation: { decision_confirmed: boolean; goal_confirmed: boolean },
): boolean {
  const now = Date.parse(utc(asOf, 'asOf'));
  return confirmation.decision_confirmed && goalActiveAt(goal, asOf, confirmation.goal_confirmed)
    && decision.subject === goal.subject && analysisKey(decision.goal_ref) === analysisKey(goal.contract_ref)
    && now >= Date.parse(utc(decision.valid_from, 'decision.valid_from'))
    && now < Date.parse(utc(decision.valid_to, 'decision.valid_to'));
}
