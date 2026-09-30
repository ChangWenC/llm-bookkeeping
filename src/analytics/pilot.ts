import type { AnalyticsPilotStats, AnalyticsReviewEvent, AnalysisRevisionRef, BookkeepingConfig, SourceCoverage } from '../contracts/types.ts';
import { utc } from '../contracts/validation.ts';
import { addCalendarDays, analysisWeekEnd, analysisWeekRange } from '../time.ts';
import { analysisKey, coverageStatus } from './model.ts';

export interface PilotNotice { notice_id: string; verified_at: string; active: boolean }
export interface PilotActionEvent {
  event_id: string; at: string; action_ref: AnalysisRevisionRef;
  disposition: 'continue' | 'narrow' | 'abandon' | 'completed' | 'active';
}
export interface AnalyticsPilotInput {
  as_of: string;
  coverage: SourceCoverage[];
  /** Only successfully applied events from the professional exact-ref ledger. */
  reviews: AnalyticsReviewEvent[];
  /** All generated professional notices; active is evaluated at this same as_of. */
  notices: PilotNotice[];
  actions: PilotActionEvent[];
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  return [...new Map(items.map(item => [key(item), item])).values()];
}

/** Four completed Amsterdam Mon–Sun periods, independent of the machine timezone.
 * Historical counters describe accepted events in that range; active counts describe
 * the current as_of state, including a still-active older notice/action. No source scan.
 */
export function analyticsPilotStats(config: BookkeepingConfig, input: AnalyticsPilotInput): AnalyticsPilotStats {
  const asOf = Date.parse(utc(input.as_of, 'pilot.as_of'));
  let last = analysisWeekEnd(input.as_of);
  if (Date.parse(analysisWeekRange(last).to) > asOf) last = addCalendarDays(last, -7);
  const weeks = Array.from({ length: 4 }, (_, index) => addCalendarDays(last, (index - 3) * 7));
  const range = { schema_version: 1 as const, from: analysisWeekRange(weeks[0]).from, to: analysisWeekRange(last).to };
  const from = Date.parse(range.from), to = Date.parse(range.to);
  const inRange = (instant: string) => { const at = Date.parse(utc(instant, 'pilot.event.at')); return at >= from && at < to && at <= asOf; };
  const stats: AnalyticsPilotStats = {
    schema_version: 1, range, weeks,
    review_duration_ms: { schema_version: 1, value: null, reason: 'Actual review duration was not measured' },
    coverage: { complete: 0, partial: 0, unknown: 0 },
    reviews: { confirmed_pairs: 0, corrected_pairs: 0, rejected_pairs: 0, retracted_reviews: 0 },
    notifications: { generated: 0, active: 0 },
    actions: { continued: 0, narrowed: 0, abandoned: 0, completed: 0, active: 0 },
  };
  for (const week of weeks) stats.coverage[coverageStatus(config, input.coverage, analysisWeekRange(week))]++;
  for (const review of uniqueBy(input.reviews, item => item.review_id).filter(item => inRange(item.created_at))) {
    if (review.action === 'retract') {
      stats.reviews.retracted_reviews++;
      continue;
    }
    const pairs = uniqueBy(review.selected_pairs ?? [], pair => JSON.stringify([analysisKey(pair.observation_ref), analysisKey(pair.capability_ref)]));
    const key = { confirm: 'confirmed_pairs', correct: 'corrected_pairs', reject: 'rejected_pairs' }[review.action] as 'confirmed_pairs' | 'corrected_pairs' | 'rejected_pairs';
    stats.reviews[key] += pairs.length;
  }
  for (const notice of uniqueBy(input.notices, item => item.notice_id)) {
    const at = Date.parse(utc(notice.verified_at, 'pilot.notice.verified_at'));
    if (inRange(notice.verified_at)) stats.notifications.generated++;
    if (at <= asOf && notice.active) stats.notifications.active++;
  }
  const actions = uniqueBy(input.actions, item => item.event_id).filter(item => Date.parse(utc(item.at, 'pilot.action.at')) <= asOf);
  const counters = { continue: 'continued', narrow: 'narrowed', abandon: 'abandoned', completed: 'completed' } as const;
  for (const action of actions) {
    if (inRange(action.at) && action.disposition !== 'active') stats.actions[counters[action.disposition]]++;
  }
  // Append-only event order breaks equal timestamp ties. New revisions never retain an old action state.
  const current = new Map<string, PilotActionEvent>();
  for (const action of actions) {
    const old = current.get(action.action_ref.logical_id);
    if (!old || action.action_ref.revision > old.action_ref.revision || (action.action_ref.revision === old.action_ref.revision && Date.parse(action.at) >= Date.parse(old.at))) current.set(action.action_ref.logical_id, action);
  }
  stats.actions.active = [...current.values()].filter(action => ['active', 'continue', 'narrow'].includes(action.disposition)).length;
  return stats;
}
