import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { affectedMonths } from '../src/consumers/periods.ts';
import { validateWeeklyAnalysisResult } from '../src/contracts/validation.ts';
const ref = { schema_version: 1, logical_id: 'analysis:2026-10-04', revision: 1 };
const result = { schema_version: 1, snapshot: { schema_version: 1, analysis_ref: ref, week_end: '2026-10-04', coverage_status: 'partial', observations: [], capabilities: [], goal_gaps: [], direction: 'unknown', patterns: [], validation_action: null }, prior_action_disposition: null, proposed_confirmations: [], freshness_at: '2026-09-30T21:30:00Z' };
test('weekly coverage and explicit revision/actions remain distinct', () => {
  assert.equal(validateWeeklyAnalysisResult(result).snapshot.coverage_status, 'partial');
  assert.throws(() => validateWeeklyAnalysisResult({ ...result, snapshot: { ...result.snapshot, direction: 'divergent' } }), /coverage/);
  assert.throws(() => validateWeeklyAnalysisResult({ ...result, proposed_confirmations: [ref, ref, ref, ref] }), /at most three/);
});
test('published schema includes minute precision, weekly privacy DTOs and no dangling refs', async () => {
  const schema = JSON.parse(await readFile(new URL('../schemas/contracts.schema.json', import.meta.url), 'utf8'));
  assert.ok(schema.$defs.SourceEvent.properties.time_precision.enum.includes('minute'));
  assert.ok(schema.$defs.SourceEvent.properties.time_precision.enum.includes('nanosecond'));
  assert.ok(schema.$defs.WeeklyAnalysisInput.properties.facts);
  assert.deepEqual(schema.$defs.AnalyticsReviewInput.oneOf.map((variant: any) => variant.properties.kind.const), ['review', 'goal_contract', 'decision_contract', 'capability_candidate']);
  assert.equal(schema.$defs.BookkeepingConfig.properties.migration_limits.properties.max_record_bytes.maximum, 4 * 1024 * 1024);
  const text = JSON.stringify(schema);
  for (const match of text.matchAll(/"\$ref":"#\/\$defs\/([^" ]+)"/g)) assert.ok(schema.$defs[match[1]], match[1]);
});

test('event month scope is authoritative and never inferred from cross-month week labels', () => {
  assert.deepEqual(affectedMonths({ affected_months: [], affected_dates: ['2026-10-04'] }), []);
  assert.deepEqual(affectedMonths({ affected_dates: ['2026-09-30'] }), ['2026-09']);
});
