import test from 'node:test';
import assert from 'node:assert/strict';
import { analyticsPilotStats, type AnalyticsPilotInput, type PilotActionEvent } from '../../src/analytics/pilot.ts';
import { decisionActiveAt, goalActiveAt } from '../../src/analytics/contracts.ts';
import { analysisWeekRange } from '../../src/time.ts';
import { config as base } from '../../test/fixtures/basic.ts';
import type { AnalyticsReviewEvent, AnalyticsAttributionPair, GoalContract, MajorDecisionContract, SourceCoverage } from '../../src/contracts/types.ts';
const ref = (logical_id: string, revision = 1) => ({ schema_version: 1 as const, logical_id, revision });
const pair = (id: string, revision = 1): AnalyticsAttributionPair => ({ schema_version: 1, observation_ref: ref('observation:' + id, revision), capability_ref: ref('capability:verify', revision) });
const review = (id: string, action: AnalyticsReviewEvent['action'], selected_pairs?: AnalyticsAttributionPair[]): AnalyticsReviewEvent => ({ schema_version: 1, review_id: id, target_ref: ref('observation:a'), action, correction: action === 'correct' ? '确切合成更正' : null, evidence_refs: [], created_at: '2026-10-14T12:00:00Z', selected_pairs });
const action = (id: string, logical: string, disposition: PilotActionEvent['disposition'], revision = 1, at = '2026-10-14T12:00:00Z'): PilotActionEvent => ({ event_id: id, at, action_ref: ref(logical, revision), disposition });
function coverage(week: string, scope: string | null = null, partial = false): SourceCoverage {
  const range = analysisWeekRange(week);
  return { schema_version: 1, coverage_id: `${week}:${scope}`, provider: 'synthetic', account_id: 'account', conversation_id: scope, lane: 'history', query_range: range, cutoff: range.to, read_ranges: partial ? [] : [range], gaps: [], capture_status: partial ? 'partial' : 'complete', review_status: 'complete' };
}
const config = { ...base, providers: [{ schema_version: 1 as const, provider: 'synthetic', account_id: 'account', enabled: true, roots: [], options: {} }] };
const empty = (): AnalyticsPilotInput => ({ as_of: '2026-11-02T00:00:00Z', coverage: [], reviews: [], notices: [], actions: [] });

test('pilot uses four completed Amsterdam weeks across DST and real scope coverage without treating missing weeks as quiet', () => {
  const input = empty();
  input.coverage = [coverage('2026-10-11'), coverage('2026-10-18'), coverage('2026-10-25'), coverage('2026-10-25', 'chat:a', true)];
  const result = analyticsPilotStats(config, input);
  assert.deepEqual(result.weeks, ['2026-10-11', '2026-10-18', '2026-10-25', '2026-11-01']);
  assert.equal(result.range.from, '2026-10-04T22:00:00.000Z');
  assert.equal(result.range.to, '2026-11-01T23:00:00.000Z');
  assert.equal((Date.parse(result.range.to) - Date.parse(result.range.from)) / 3600000, 673);
  assert.deepEqual(result.coverage, { complete: 2, partial: 1, unknown: 1 });
  assert.deepEqual(analyticsPilotStats({ ...config, providers: [] }, input).coverage, { complete: 0, partial: 0, unknown: 4 });
});

test('pilot counts exact selected pair events and append-only retractions without promoting generic confirmation', () => {
  const input = empty(), confirm = review('confirm', 'confirm', [pair('a'), pair('a'), pair('a', 2)]);
  input.reviews = [confirm, confirm, review('generic', 'confirm'), review('correct', 'correct', [pair('b')]), review('reject', 'reject', [pair('c')]), { ...review('retract', 'retract'), retracts_review_id: 'confirm' }, { ...review('too-old', 'confirm', [pair('z')]), created_at: '2026-10-04T21:59:59Z' }, { ...review('next-week', 'confirm', [pair('z')]), created_at: '2026-11-01T23:00:00Z' }];
  assert.deepEqual(analyticsPilotStats(config, input).reviews, { confirmed_pairs: 2, corrected_pairs: 1, rejected_pairs: 1, retracted_reviews: 1 });
});

test('pilot deduplicates generated notices and action events; active state uses asOf and exact revision closure', () => {
  const input = empty();
  const notice = { notice_id: 'decision:fact:r1', verified_at: '2026-10-14T12:00:00Z', active: false };
  input.notices = [notice, notice, { notice_id: 'older-active', verified_at: '2026-09-01T12:00:00Z', active: true }, { notice_id: 'current-active', verified_at: '2026-10-20T12:00:00Z', active: true }, { notice_id: 'future', verified_at: '2026-11-03T12:00:00Z', active: true }];
  const continued = action('continue:1', 'validation:a', 'continue');
  input.actions = [continued, continued, action('narrow:2', 'validation:a', 'narrow'), action('new:2', 'validation:a', 'active', 2), action('done:2', 'validation:a', 'completed', 2, '2026-10-21T12:00:00Z'), action('abandon:1', 'validation:b', 'abandon'), action('older-active', 'validation:c', 'active', 1, '2026-09-01T12:00:00Z'), action('future-close', 'validation:c', 'completed', 2, '2026-11-03T12:00:00Z'), action('stale', 'validation:a', 'active', 1, '2026-10-30T12:00:00Z')];
  const result = analyticsPilotStats(config, input);
  assert.deepEqual(result.notifications, { generated: 2, active: 2 });
  assert.deepEqual(result.actions, { continued: 1, narrowed: 1, abandoned: 1, completed: 1, active: 1 });
  assert.throws(() => analyticsPilotStats(config, { ...input, as_of: 'invalid' }), /UTC ISO/);
});

test('decision and goal activity require exact confirmations, matching subject and goal revision, and current expiry', () => {
  const goal: GoalContract = { schema_version: 1, contract_ref: ref('goal:a'), subject: 'Roy', description: '合成目标', target_version: 'v1', deadline: '2026-10-31T12:00:00Z', confirmed: true };
  const decision: MajorDecisionContract = { schema_version: 1, contract_ref: ref('decision:a'), subject: 'Roy', goal_ref: goal.contract_ref, valid_from: '2026-10-01T00:00:00Z', valid_to: '2026-11-01T00:00:00Z', trigger: { schema_version: 1, name: 'verification', expected_value: 'yes' }, confirmed: true };
  const confirmation = { decision_confirmed: true, goal_confirmed: true };
  assert.equal(decisionActiveAt(decision, goal, decision.valid_from, confirmation), true);
  assert.equal(decisionActiveAt(decision, goal, decision.valid_to, confirmation), false);
  assert.equal(goalActiveAt(goal, goal.deadline!, true), true);
  assert.equal(goalActiveAt(goal, '2026-10-31T12:00:00.001Z', true), false);
  assert.equal(decisionActiveAt(decision, goal, '2026-10-20T00:00:00Z', { ...confirmation, decision_confirmed: false }), false);
  assert.equal(decisionActiveAt(decision, goal, '2026-10-20T00:00:00Z', { ...confirmation, goal_confirmed: false }), false);
  assert.equal(decisionActiveAt({ ...decision, goal_ref: ref('goal:a', 2) }, goal, '2026-10-20T00:00:00Z', confirmation), false);
  assert.equal(decisionActiveAt({ ...decision, subject: 'Someone else' }, goal, '2026-10-20T00:00:00Z', confirmation), false);
  assert.equal(goalActiveAt({ ...goal, deadline: null, confirmed: false }, '2026-10-20T00:00:00Z', true), true, 'Registration boolean is inert; exact review confirmation is authoritative');
});
