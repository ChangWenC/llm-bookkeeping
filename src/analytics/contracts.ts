import type { GoalContract, MajorDecisionContract } from '../contracts/types.ts';
import { utcComparisonKey } from '../contracts/validation.ts';
import { analysisKey } from './model.ts';

/** The confirmation boolean must come from the exact current-revision review fold. */
export function goalActiveAt(goal: GoalContract, asOf: string, confirmed: boolean): boolean {
  const now = utcComparisonKey(asOf);
  if (!confirmed) return false;
  return goal.deadline === null || now <= utcComparisonKey(goal.deadline);
}

/** Contract windows are half-open. Registration's `confirmed` field grants no authority. */
export function decisionActiveAt(
  decision: MajorDecisionContract,
  goal: GoalContract,
  asOf: string,
  confirmation: { decision_confirmed: boolean; goal_confirmed: boolean },
): boolean {
  const now = utcComparisonKey(asOf);
  return confirmation.decision_confirmed && goalActiveAt(goal, asOf, confirmation.goal_confirmed)
    && decision.subject === goal.subject && analysisKey(decision.goal_ref) === analysisKey(goal.contract_ref)
    && now >= utcComparisonKey(decision.valid_from)
    && now < utcComparisonKey(decision.valid_to);
}
