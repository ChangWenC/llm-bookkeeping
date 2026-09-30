import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runCli } from '../../src/cli.ts';
import { createStore } from '../../src/store/index.ts';
import { analyticsRepository } from '../../src/consumers/analytics/index.ts';
import { config, collection, bundle, result, event, range } from '../store/fixtures.ts';
import type { AnalyticsAttributionPair, AnalyticsReviewEvent, AnalyticsReviewInput, AnalysisRevisionRef, ReviewBundle, ReviewResult } from '../../src/contracts/types.ts';
const ref = (logical_id: string, revision = 1): AnalysisRevisionRef => ({ schema_version: 1, logical_id, revision });
const capability = (id: string, revision = 1, status: 'candidate' | 'formal' = 'formal') => ({ schema_version: 1 as const, definition_ref: ref(id, revision), label: '合成' + id, keywords: ['合成验证'], status });

async function fixture(t: test.TestContext) {
  const c = await config(), root = dirname(c.wiki_root), configPath = join(root, 'config.json');
  const goalPath = 'wiki/personal/plans/规划_professional_goal.md';
  c.goal_whitelist = [goalPath]; c.project_whitelist = ['a'];
  c.journal_timezone_timeline = [{ schema_version: 1, effective_from: '1970-01-01T00:00:00Z', timezone: 'Europe/Amsterdam', basis: 'synthetic fixture' }];
  c.analytics_catalog = { schema_version: 1, capabilities: [capability('capability:design'), capability('capability:verify')], directions: [], project_mappings: [] };
  await mkdir(dirname(join(c.wiki_root, goalPath)), { recursive: true }); await writeFile(join(c.wiki_root, goalPath), '# 明确合成职业目标\n\n仅供核对，不表示用户确认合同。\n');
  await writeFile(configPath, JSON.stringify(c));
  const store = await createStore(c), repository = analyticsRepository(store);
  let asOf = '2026-10-01T12:00:00Z', sequence = 0;
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const cli = async (args: string[]) => {
    let out = '', err = '';
    const code = await runCli([...args, '--config', configPath], { stdout: value => { out += value; }, stderr: value => { err += value; }, now: () => asOf });
    assert.equal(code, 0, err); return JSON.parse(out);
  };
  const input = async (command: 'publish' | 'analytics-review', value: ReviewResult | AnalyticsReviewInput) => {
    const path = join(root, `input-${++sequence}.json`); await writeFile(path, JSON.stringify(value)); return cli([command, '--input', path]);
  };
  const review = (id: string, target_ref: AnalysisRevisionRef, action: AnalyticsReviewEvent['action'], selected_pairs?: AnalyticsAttributionPair[], retracts_review_id?: string) => input('analytics-review', { schema_version: 1, kind: 'review', events: [{ schema_version: 1, review_id: id, target_ref, action, correction: action === 'correct' ? '仅核对所选归因，其余存在争议。' : null, evidence_refs: [], created_at: asOf, selected_pairs, retracts_review_id }] });
  const saveFact = async (id: string, replace?: { fact_id: string; revision: number }, verification = false, occurredAt = '2026-09-30T09:00:00.000Z') => {
    const source = event(id, 'Synthetic professional parser verification', occurredAt), material = bundle([source], 'bundle:' + id);
    material.existing_facts = await store.readEffectiveFacts({ range });
    await store.saveCollection(collection([source], 'live', 'collection:' + id)); await store.saveBundle(material);
    const semantic = result(material, 'result:' + id); semantic.pages = [];
    const candidate = semantic.candidates[0];
    candidate.occurred_at = source.utc_time; candidate.journal_date = source.journal_date;
    candidate.content = 'PRIVATE household detail; professional synthesis follows explicit projection only';
    candidate.analytics_projection.value!.summary = '合成职业解析器验证。';
    candidate.analytics_projection.value!.attribution = { responsibility: 'verification', actor: 'Roy', capability_ids: ['capability:design', 'capability:verify'], goal_target_version: 'goal-v1' };
    if (replace) { candidate.disposition = 'replace'; candidate.target_refs = [{ schema_version: 1, ...replace }]; }
    if (verification) candidate.analytics_projection.value!.verification = { schema_version: 1, name: 'parser_pass', value: 'yes', subject: 'Roy', verified_at: source.utc_time.value!, event_refs: [{ schema_version: 1, event_id: source.event_id }], basis: 'user_explicit_verification' };
    await input('publish', semantic); await cli(['consume', '--target', 'analytics']);
    return repository.facts().find(fact => fact.projection.event_refs.some(item => item.event_id === source.event_id))!;
  };
  return { c, root, store, repository, goalPath, cli, input, review, saveFact, setAsOf: (value: string) => { asOf = value; }, output: () => repository.currentOutput('integration', c, asOf) };
}

test('actual CLI exact-pair review fold, candidate promotion and immutable revision changes share professional SQLite state', async t => {
  const f = await fixture(t);
  const first = await f.saveFact('pair-source');
  const observation = f.repository.observations()[0], a = ref('capability:design'), b = ref('capability:verify');
  const pair = (capability_ref: AnalysisRevisionRef): AnalyticsAttributionPair => ({ schema_version: 1, observation_ref: observation.observation_ref, capability_ref });
  const overlays = () => f.output().overlays;
  await f.review('generic-observation-confirm', observation.observation_ref, 'confirm');
  assert.equal(overlays().length, 2); assert.ok(overlays().every(item => !item.confirmed), 'Generic observation confirmation is not a capability attribution confirmation');
  await f.review('select-design', observation.observation_ref, 'confirm', [pair(a)]);
  assert.equal(overlays().find(item => item.capability_id === a.logical_id)!.confirmed, true);
  assert.equal(overlays().find(item => item.capability_id === b.logical_id)!.confirmed, false);
  await f.review('correct-to-verify', observation.observation_ref, 'correct', [pair(b)]);
  assert.equal(overlays().find(item => item.capability_id === a.logical_id)!.contested, true);
  assert.equal(overlays().find(item => item.capability_id === b.logical_id)!.confirmed, true);
  await f.review('withdraw-correction', observation.observation_ref, 'retract', undefined, 'correct-to-verify');
  assert.equal(overlays().find(item => item.capability_id === a.logical_id)!.confirmed, true);
  assert.equal(overlays().find(item => item.capability_id === b.logical_id)!.confirmed, false);
  await f.review('restore-correction', observation.observation_ref, 'retract', undefined, 'withdraw-correction');
  assert.equal(overlays().find(item => item.capability_id === a.logical_id)!.contested, true);
  assert.equal(overlays().find(item => item.capability_id === b.logical_id)!.confirmed, true);
  const candidate = capability('capability:new', 1, 'candidate');
  const registered = await f.input('analytics-review', { schema_version: 1, kind: 'capability_candidate', definition: candidate });
  assert.equal(registered[0].status, 'pending');
  assert.equal(f.output().analytics_catalog!.capabilities.find(item => item.definition_ref.logical_id === candidate.definition_ref.logical_id)!.status, 'candidate');
  await f.review('promote-exact-definition', candidate.definition_ref, 'confirm');
  assert.equal(f.output().analytics_catalog!.capabilities.find(item => item.definition_ref.logical_id === candidate.definition_ref.logical_id)!.status, 'formal');
  await f.input('analytics-review', { schema_version: 1, kind: 'capability_candidate', definition: capability('capability:verify', 2, 'candidate') });
  const changedCapability = overlays().find(item => item.capability_id === b.logical_id)!;
  assert.equal(changedCapability.capability_ref.revision, 2); assert.equal(changedCapability.confirmed, false);
  assert.equal(changedCapability.contested, false, 'A new definition revision inherits no prior correction dispute');
  const second = await f.saveFact('pair-source-replacement', first.fact_ref);
  assert.equal(second.fact_ref.revision, 2);
  assert.ok(overlays().every(item => !item.confirmed), 'Replacement observation revision inherits no old pair confirmation');
  const stale = await f.review('stale-old-observation', observation.observation_ref, 'confirm', [pair(a)]);
  assert.equal(stale[0].status, 'stale');
  const outputDir = join(f.root, 'weekly-spec7-material');
  const manifest = await f.cli(['prepare', '--kind', 'weekly', '--lane', 'history', '--period', '2026-10-04', '--output', outputDir]);
  const material: ReviewBundle = JSON.parse(await readFile(join(outputDir, manifest.bundles[0]), 'utf8'));
  assert.ok(!JSON.stringify(material).includes('PRIVATE'));
  assert.match(material.analysis_context!.goal_page_baselines![0].content!, /明确合成职业目标/);
  assert.deepEqual(material.analysis_context!.confirmed_goals, [], 'Goal page contents do not become confirmed contracts');
  assert.equal(material.analysis_context!.analytics_catalog!.capabilities.find(item => item.definition_ref.logical_id === candidate.definition_ref.logical_id)!.status, 'formal');
  assert.equal((await f.cli(['validate', '--scope', 'all'])).status, 'valid');
});

test('actual CLI clock expiry removes current decision notice while preserving historical generation and pilot unknown duration', async t => {
  const f = await fixture(t), goalRef = ref(f.goalPath), decisionRef = ref('decision:synthetic');
  await f.input('analytics-review', { schema_version: 1, kind: 'goal_contract', contract: { schema_version: 1, contract_ref: goalRef, subject: 'Roy', description: '合成职业目标合同', target_version: 'goal-v1', deadline: '2026-10-04T00:00:00Z', confirmed: false } });
  await f.review('confirm-goal', goalRef, 'confirm');
  await f.input('analytics-review', { schema_version: 1, kind: 'decision_contract', contract: { schema_version: 1, contract_ref: decisionRef, subject: 'Roy', goal_ref: goalRef, valid_from: '2026-09-29T00:00:00Z', valid_to: '2026-10-02T00:00:00Z', trigger: { schema_version: 1, name: 'parser_pass', expected_value: 'yes' }, confirmed: false } });
  await f.review('confirm-decision', decisionRef, 'confirm');
  await f.saveFact('decision-verification-source', undefined, true);
  assert.equal(f.output().notices.length, 1);
  const active = await f.cli(['consume', '--target', 'analytics']);
  assert.equal(active.consumers[0].analytics_pilot.notifications.active, 1);
  f.setAsOf('2026-10-05T12:00:00Z');
  const expired = await f.cli(['consume', '--target', 'analytics']);
  assert.equal(expired.consumers[0].analytics_pilot.notifications.active, 0);
  assert.equal(expired.consumers[0].analytics_pilot.notifications.generated, 1, 'Expiration preserves historical unique generated notices');
  assert.deepEqual(expired.consumers[0].analytics_pilot.review_duration_ms, { schema_version: 1, value: null, reason: 'Actual review duration was not measured' });
  assert.equal(f.output().notices.length, 0);
  const cockpit = await readFile(join(f.c.wiki_root, 'wiki/personal/synthesis/综合_self_analytics_current.md'), 'utf8');
  assert.ok(!cockpit.includes('已满足显式重大决策验证条件'));
  assert.ok(!cockpit.includes('PRIVATE'));
  assert.equal((await f.cli(['validate', '--scope', 'all'])).status, 'valid');
});

test('actual CLI accepted weekly actions feed four-week professional pilot disposition and closure counters exactly once', async t => {
  const f = await fixture(t);
  const first = await f.saveFact('action-source');
  for (const [index, week] of ['2026-10-04', '2026-10-11', '2026-10-18', '2026-10-25', '2026-11-01'].entries()) {
    const reviewTime = new Date(`${week}T12:00:00Z`);
    f.setAsOf(reviewTime.toISOString());
    if (index === 4) await f.saveFact('completed-action-source', undefined, false, '2026-10-28T09:00:00.000Z');
    const output = join(f.root, `action-week-${index}`);
    const manifest = await f.cli(['prepare', '--kind', 'weekly', '--lane', 'history', '--period', week, '--output', output]);
    const material: ReviewBundle = JSON.parse(await readFile(join(output, manifest.bundles[0]), 'utf8'));
    const context = material.analysis_context!, review = result(material, 'action-week:' + week, false);
    const prior = context.prior_action;
    const evidence = index === 4 ? context.facts.map(item => item.fact_ref) : [first.fact_ref];
    const action = index === 3 ? null : index === 4
      ? { schema_version: 1 as const, action_ref: ref('validation:completed'), subject: 'Roy', description: '已用本周合成证据核对完成。', evidence_refs: evidence, state: 'completed' as const }
      : index === 0
        ? { schema_version: 1 as const, action_ref: ref('validation:active'), subject: 'Roy', description: '合成职业验证动作。', evidence_refs: evidence, state: 'active' as const }
        : index === 1 ? prior!
          : { ...prior!, action_ref: ref(prior!.action_ref.logical_id, prior!.action_ref.revision + 1), description: '收窄到合成解析器边界。' };
    const disposition = index >= 1 && index <= 3 ? { schema_version: 1 as const, action_ref: prior!.action_ref, disposition: (index === 1 ? 'continue' : index === 2 ? 'narrow' : 'abandon') as 'continue' | 'narrow' | 'abandon', reason: '本周显式核对处置。', evidence_refs: prior!.evidence_refs } : null;
    review.analysis = { schema_version: 1, snapshot: { schema_version: 1, analysis_ref: context.analysis_ref!, week_end: context.week_end, coverage_status: context.coverage_status, observations: context.observation_candidates ?? [], capabilities: [], goal_gaps: [], direction: 'unknown', patterns: [`合成第${index + 1}周`], validation_action: action }, prior_action_disposition: disposition, proposed_confirmations: [], freshness_at: reviewTime.toISOString() };
    await f.input('publish', review);
    await f.cli(['consume', '--target', 'analytics']);
    if (index === 3) {
      const refreshed = join(f.root, 'closed-action-same-week');
      const response = await f.cli(['prepare', '--kind', 'weekly', '--lane', 'history', '--period', week, '--output', refreshed]);
      const sameWeek: ReviewBundle = JSON.parse(await readFile(join(refreshed, response.bundles[0]), 'utf8'));
      assert.equal(sameWeek.analysis_context!.prior_action, null, 'Explicit current-week closure cannot revive an older week active action');
    }
    // Identical accepted input reuses the transaction and never duplicates disposition events.
    await f.input('publish', review);
    await f.cli(['consume', '--target', 'analytics']);
  }
  f.setAsOf('2026-11-02T12:00:00Z');
  const consumed = await f.cli(['consume', '--target', 'analytics']);
  assert.deepEqual(consumed.consumers[0].analytics_pilot.actions, { continued: 1, narrowed: 1, abandoned: 1, completed: 1, active: 0 });
  assert.equal(consumed.consumers[0].analytics_pilot.weeks.length, 4);
  assert.ok(!JSON.stringify(consumed).includes('PRIVATE'));
  assert.equal((await f.cli(['validate', '--scope', 'all'])).status, 'valid');
});
