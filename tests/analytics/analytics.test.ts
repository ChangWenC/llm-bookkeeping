import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createStore, canonical, digest } from '../../src/store/index.ts';
import { createReviewer } from '../../src/review/index.ts';
import { createAnalyticsConsumer, prepareWeeklyAnalysis, analyticsRepository } from '../../src/consumers/analytics/index.ts';
import { coverageStatus, cropProjection } from '../../src/analytics/model.ts';
import { validateStore } from '../../src/store/health.ts';
import { analysisWeekRange } from '../../src/time.ts';
import { config, event, collection, bundle, result, value, range } from '../store/fixtures.ts';
import type { WeeklyAnalysisInput, WeeklyAnalysisResult, AnalysisRevisionRef } from '../../src/contracts/types.ts';
const at = '2026-10-05T00:00:00Z', week = '2026-10-04';
async function fixture(projectionMissing = false) {
    const c = await config();
    c.project_whitelist = ['a'];
    c.goal_whitelist = ['goal:parser'];
    c.analytics_catalog = {schema_version:1,capabilities:[{schema_version:1,definition_ref:{schema_version:1,logical_id:'capability:parser',revision:1},label:'Parser verification',keywords:['parser'],status:'formal'}],directions:[],project_mappings:[]};
    const s = await createStore(c);
    const events = [event('professional', 'PRIVATE family and professional mixed content')];
    const batch = collection(events);
    batch.coverage[0].query_range = analysisWeekRange(week);
    batch.coverage[0].read_ranges = [analysisWeekRange(week)];
    batch.coverage[0].cutoff = at;
    await s.saveCollection(batch);
    const b = bundle(events);
    b.coverage = batch.coverage;
    await s.saveBundle(b);
    const r = result(b);
    r.pages = [];
    r.candidates[0].content = 'PRIVATE family detail. Professional parser verification.';
    r.candidates[0].analytics_projection.value!.attribution = { actor: 'Roy', responsibility: 'verification', capability_ids: ['parser'], goal_target_version: 'v1' };
    if (projectionMissing)
        r.candidates[0].analytics_projection = { schema_version: 1, value: null, reason: 'Missing professional projection' };
    const commit = await s.commitReview(r);
    await s.markExportReady(commit.batch_id, c.data_dir + '/synthetic-ready.json');
    return { c, s, commit, consumer: createAnalyticsConsumer(s, c) };
}
function semantic(input: WeeklyAnalysisInput): WeeklyAnalysisResult { return { schema_version: 1, snapshot: { schema_version: 1, analysis_ref: input.analysis_ref!, week_end: input.week_end, coverage_status: input.coverage_status, observations: input.observation_candidates ?? [], capabilities: input.facts.length ? [{ schema_version: 1, capability_id: 'parser', trend: 'improving', explanation: 'Explicit verification evidence', evidence_refs: [input.facts[0].fact_ref] }] : [], goal_gaps: [], direction: 'unknown', patterns: ['Verification precedes publication'], validation_action: input.facts.length ? { schema_version: 1, action_ref: { schema_version: 1, logical_id: 'action:parser', revision: 1 }, subject: 'Roy', description: 'Verify one independent parser fixture', evidence_refs: [input.facts[0].fact_ref], state: 'active' } : null }, prior_action_disposition: null, proposed_confirmations: input.observation_candidates?.slice(0, 3).map(o => o.observation_ref) ?? [], freshness_at: at }; }
async function acceptWeek(f: Awaited<ReturnType<typeof fixture>>, analysis?: WeeklyAnalysisResult) { const reviewer = createReviewer(f.s, f.c), b = (await reviewer.prepare({ kind: 'weekly', lane: 'history', period: week, cutoff: at }))[0]; const r = result(b, 'week:' + digest(canonical(analysis ?? b)), false); r.analysis = analysis ?? semantic(b.analysis_context!); const commit = await reviewer.accept(r); await f.s.markExportReady(commit.batch_id, f.c.data_dir + '/week.json'); return { b, commit, analysis: r.analysis }; }
async function review(f: Awaited<ReturnType<typeof fixture>>, ref: AnalysisRevisionRef, action: 'confirm' | 'reject' | 'correct' | 'retract' = 'confirm', id = 'review:' + action + ':' + ref.logical_id + ':' + ref.revision) { return f.consumer.review({ schema_version: 1, kind: 'review', events: [{ schema_version: 1, review_id: id, target_ref: ref, action, correction: action === 'correct' ? 'Responsibility limited to verification' : null, evidence_refs: [], created_at: at, retracts_review_id: action === 'retract' ? 'review:confirm:' + ref.logical_id + ':' + ref.revision : null }] }); }
test('ready professional ledger, capability semantics and typed weekly publication preserve privacy and manual cockpit', async () => {
    const f = await fixture();
    try {
        const cockpit = join(f.c.wiki_root, 'wiki/personal/synthesis/综合_self_analytics_current.md');
        await mkdir(join(f.c.wiki_root, 'wiki/personal/synthesis'), { recursive: true });
        await writeFile(cockpit, 'Human authored goals stay here.\n');
        assert.equal((await f.consumer.consume()).status, 'complete');
        const input = await prepareWeeklyAnalysis(f.s, f.c, week);
        assert.equal(input.coverage_status, 'complete');
        assert.equal(input.facts[0].projection.scope[0], 'project:a');
        assert(!canonical(input).includes('PRIVATE'));
        const w = await acceptWeek(f);
        assert.equal((await f.s.listReadyBatches('analytics'))[0].analysis!.snapshot.analysis_ref.logical_id, 'weekly:' + week);
        assert.equal((await f.consumer.consume()).status, 'complete');
        const body = await readFile(cockpit, 'utf8');
        assert(body.startsWith('Human authored goals'));
        assert(body.includes('improving'));
        assert(body.includes('当前验证动作'));
        assert(!body.includes('PRIVATE'));
        for (const filename of await readdir(join(f.c.data_dir, 'analytics/batches')))
            assert(!(await readFile(join(f.c.data_dir, 'analytics/batches', filename), 'utf8')).includes('PRIVATE'));
        assert.equal(w.commit.facts.length, 0);
        const weeklyArtifact=(await f.s.listOutbox()).find(batch=>batch.batch_id===w.commit.batch_id)!.artifact;assert.deepEqual(weeklyArtifact.affected_dates,[]);assert.deepEqual(weeklyArtifact.affected_weeks,[]);assert.deepEqual(weeklyArtifact.affected_months,[]);
    }
    finally {
        f.s.close();
    }
});
test('provider discovery and separate conversations cannot cover another partial source, later same scope completion resolves', async () => { const c = await config(), full = { ...collection([]).coverage[0], query_range: analysisWeekRange(week), read_ranges: [analysisWeekRange(week)], cutoff: at, review_status: 'complete' as const }; const partial = { ...full, coverage_id: 'partial-chat', conversation_id: 'chat:partial', capture_status: 'partial' as const, gaps: [{ schema_version: 1 as const, range: full.query_range, reason: 'unread', locator: null, resumable: true }] }; assert.equal(coverageStatus(c, [{ ...full, conversation_id: 'chat:complete' }], full.query_range), 'partial'); assert.equal(coverageStatus(c, [full, partial], full.query_range), 'partial'); assert.equal(coverageStatus(c, [full, partial, { ...full, coverage_id: 'later', conversation_id: 'chat:partial', cutoff: '2026-10-05T01:00:00Z' }], full.query_range), 'complete'); assert.equal(coverageStatus(c, [{ ...full, read_ranges: [{ schema_version: 1, from: full.query_range.from, to: '2026-09-28T01:00:00Z' }] }], full.query_range), 'partial'); });
test('confirm/reject/correct/retract bind exact observations; revised facts rebuild evidence without inherited confirmation', async () => {
    const f = await fixture();
    try {
        await f.consumer.consume();
        const repo = analyticsRepository(f.s), old = repo.observations()[0];
        assert.equal((await review(f, old.observation_ref))[0].status, 'applied');
        assert.equal((await review(f, old.observation_ref))[0].status, 'already_applied');
        assert.equal(repo.currentOutput('x').overlays[0].stage, 'candidate'); // Activity confirmation does not confirm attribution pairs.
        await review(f, old.observation_ref, 'correct');
        assert.equal(repo.currentOutput('x').overlays[0].stage, 'candidate');
        await review(f, old.observation_ref, 'reject');
        assert.equal(repo.currentOutput('x').overlays.length, 0);
        await review(f, old.observation_ref, 'confirm', 'confirm:again');
        const e = event('correction');
        await f.s.saveCollection(collection([e], 'live', 'correction-source'));
        const b = bundle([e], 'correction');
        b.existing_facts = await f.s.readEffectiveFacts({ range });
        await f.s.saveBundle(b);
        const r = result(b, 'correction');
        r.pages = [];
        r.candidates[0].disposition = 'replace';
        r.candidates[0].target_refs = [old.evidence_refs[0]];
        r.candidates[0].analytics_projection.value!.summary = 'Corrected parser evidence';
        r.candidates[0].analytics_projection.value!.attribution = { actor: 'Roy', responsibility: 'correction', capability_ids: ['parser'] };
        const commit = await f.s.commitReview(r);
        await f.s.markExportReady(commit.batch_id, f.c.data_dir + '/correction.json');
        await f.consumer.consume();
        assert.equal(repo.facts().length, 1);
        const newer = repo.observations()[0];
        assert.equal(newer.observation_ref.logical_id, old.observation_ref.logical_id);
        assert.equal(newer.observation_ref.revision, 2);
        assert.equal(repo.currentOutput('x').overlays[0].confirmed, false);
        assert.equal((await review(f, old.observation_ref, 'confirm', 'stale-confirm'))[0].status, 'stale');
        await review(f, newer.observation_ref);
        await review(f, newer.observation_ref, 'retract');
        assert.equal(repo.currentOutput('x').overlays[0].confirmed, false); // The exact activity confirmation is undone; evidence remains.
    }
    finally {
        f.s.close();
    }
});
test('missing projection does not inspect mixed fact bodies and cannot yield full coverage', async () => {
    const f = await fixture(true);
    try {
        const input = await prepareWeeklyAnalysis(f.s, f.c, week);
        assert.equal(input.coverage_status, 'partial');
        assert(!canonical(input).includes('PRIVATE'));
        assert.equal(input.facts.length, 0);
        const projected = { schema_version: 1 as const, summary: 'scope', scope: ['project:a', 'project:unknown', 'life', 'career_and_learning'], subject: 'Roy', event_refs: [], attribution: {} };
        assert.deepEqual(cropProjection(projected, f.c)!.scope, ['project:a', 'career_and_learning']);
    }
    finally {
        f.s.close();
    }
});
test('immutable output crash and writer crash leave independent facts ready, then recover before ack', async () => {
    for (const stage of ['after_output', 'before_ack', 'after_target']) {
        const f = await fixture();
        try {
            let once = true;
            const faulty = createAnalyticsConsumer(f.s, f.c, { fault: stage === 'after_target' ? undefined : (at) => {
                    if (once && at === stage) {
                        once = false;
                        throw new Error('synthetic crash');
                    }
                }, writer: { fault: (at) => {
                        if (once && at === stage) {
                            once = false;
                            throw new Error('synthetic crash');
                        }
                    } } });
            assert.equal((await faulty.consume()).status, 'pending');
            assert.equal((await f.s.listReadyBatches('analytics')).length, 1);
            assert.equal((await f.s.readEffectiveFacts({ range })).length, 1);
            assert.equal((await f.consumer.consume()).status, 'complete');
            assert.equal((await f.s.listReadyBatches('analytics')).length, 0);
            assert.equal(analyticsRepository(f.s).observations().length, 1);
        }
        finally {
            f.s.close();
        }
    }
});
test('human managed-region edits preserve human text and queue reconciliation without rolling back review', async () => {
    const f = await fixture();
    try {
        await f.consumer.consume();
        const path = join(f.c.wiki_root, 'wiki/personal/synthesis/综合_self_analytics_current.md');
        const body = await readFile(path, 'utf8');
        await writeFile(path, body.replace('职业与学习分析', 'Human replaced heading'));
        const obs = analyticsRepository(f.s).observations()[0];
        assert.equal((await review(f, obs.observation_ref))[0].status, 'applied');
        assert((await f.s.listWork('analytics_display', 'pending')).length);
        assert((await readFile(path, 'utf8')).includes('Human replaced heading'));
        assert.equal((await validateStore(f.s)).status, 'valid');
    }
    finally {
        f.s.close();
    }
});
test('complete unchanged snapshot reuses identity with fresh output, while forged IDs fail before acceptance', async () => {
    const f = await fixture();
    try {
        await f.consumer.consume();
        const first = await acceptWeek(f);
        await f.consumer.consume();
        const reviewer = createReviewer(f.s, f.c);
        const b = (await reviewer.prepare({ kind: 'weekly', lane: 'history', period: week, cutoff: '2026-10-05T01:00:00Z' }))[0];
        assert.equal(b.analysis_context!.analysis_ref!.revision, 2);
        const r = result(b, 'unchanged', false);
        r.analysis = { ...first.analysis, snapshot: b.analysis_context!.previous_snapshot!, freshness_at: '2026-10-05T01:00:00Z' };
        const committed = await reviewer.accept(r);
        await f.s.markExportReady(committed.batch_id, f.c.data_dir + '/unchanged.json');
        await f.consumer.consume();
        const repo = analyticsRepository(f.s);
        assert.equal(repo.snapshots().length, 1);
        assert.equal(repo.snapshots()[0].analysis_ref.revision, 1);
        assert.equal(repo.currentOutput('x').freshness.length, 1);
        assert.equal(repo.currentOutput('x').freshness[0].freshness_at, '2026-10-05T01:00:00Z');
        const third = (await reviewer.prepare({ kind: 'weekly', lane: 'history', period: week, cutoff: '2026-10-05T02:00:00Z' }))[0], bad = result(third, 'forged', false);
        bad.analysis = semantic(third.analysis_context!);
        bad.analysis.snapshot.analysis_ref = { schema_version: 1, logical_id: 'model-created-other-week', revision: 1 };
        await assert.rejects(reviewer.accept(bad), /exact application|reuse the previous snapshot/);
        assert.equal(await f.s.getReviewResult('forged'), null);
    }
    finally {
        f.s.close();
    }
});
test('typed monthly result is atomically retained and invalid context references cannot be accepted', async () => {
    const f = await fixture();
    try {
        const reviewer = createReviewer(f.s, f.c), b = (await reviewer.prepare({ kind: 'monthly', lane: 'history', period: '2026-09', cutoff: at }))[0], r = result(b, 'monthly', false);
        r.monthly_review = { schema_version: 1, month: '2026-09', summary: 'A reviewed synthetic month', supplement_text: 'Historical supplement', fact_refs: b.monthly_context!.facts.map(f => ({ schema_version: 1, fact_id: f.fact_id, revision: f.revision })), coverage_status: 'partial' };
        const bad = structuredClone(r);
        bad.result_id = 'bad-month';
        bad.monthly_review!.fact_refs = [{ schema_version: 1, fact_id: 'unknown', revision: 1 }];
        await assert.rejects(reviewer.accept(bad), /outside prepared/);
        const commit = await reviewer.accept(r);
        assert.deepEqual((await f.s.listOutbox()).find(box => box.batch_id === commit.batch_id)!.artifact.monthly_review, r.monthly_review);
        assert.deepEqual((await f.s.commitReview({ ...r, result_id: 'new-label' })).batch_id, commit.batch_id);
    }
    finally {
        f.s.close();
    }
});
test('major decisions require exact confirmed goal version, subject, validity and explicit verified fact; notice is unique and retractable', async () => {
    const f = await fixture();
    try {
        const repo = analyticsRepository(f.s);
        await f.consumer.consume();
        const goal = { schema_version: 1 as const, contract_ref: { schema_version: 1 as const, logical_id: 'goal:parser', revision: 1 }, subject: 'Roy', description: 'Verified parser target', target_version: 'v1', deadline: '2026-10-05T00:00:00Z', confirmed: false };
        const decision = { schema_version: 1 as const, contract_ref: { schema_version: 1 as const, logical_id: 'decision:publish', revision: 1 }, subject: 'Roy', goal_ref: goal.contract_ref, valid_from: '2026-09-28T00:00:00Z', valid_to: '2026-10-05T00:00:00Z', trigger: { schema_version: 1 as const, name: 'parser_verified', expected_value: 'yes' }, confirmed: false };
        await f.consumer.review({ schema_version: 1, kind: 'goal_contract', contract: goal });
        await f.consumer.review({ schema_version: 1, kind: 'decision_contract', contract: decision });
        assert.equal((await review(f, decision.contract_ref))[0].status, 'pending');
        await review(f, goal.contract_ref);
        await review(f, decision.contract_ref, 'confirm', 'decision-confirm-after-goal');
        assert.equal(repo.currentOutput('x').notices.length, 0);
        for (const [i, kind, subject, version, verifiedAt] of [[1, 'inference', 'Roy', 'v1', '2026-09-30T09:00:00Z'], [2, 'fact', 'Other', 'v1', '2026-09-30T09:00:00Z'], [3, 'fact', 'Roy', 'v2', '2026-09-30T09:00:00Z'], [4, 'fact', 'Roy', 'v1', '2026-09-30T09:00:00Z']] as const) {
            const e = event('verification:' + i, 'Synthetic user explicit verification', verifiedAt);
            await f.s.saveCollection(collection([e], 'live', 'verified-source:' + i));
            const b = bundle([e], 'verified:' + i);
            await f.s.saveBundle(b);
            const r = result(b, 'verified:' + i);
            r.pages = [];
            const candidate = r.candidates[0];
            candidate.kind = kind;
            candidate.subject = subject;
            candidate.analytics_projection.value!.subject = subject;
            candidate.analytics_projection.value!.attribution = { actor: subject, responsibility: 'verification', goal_target_version: version };
            candidate.analytics_projection.value!.verification = { schema_version: 1, name: 'parser_verified', value: 'yes', subject, verified_at: verifiedAt, event_refs: [{ schema_version: 1, event_id: e.event_id }], basis: 'user_explicit_verification' };
            const commit = await f.s.commitReview(r);
            await f.s.markExportReady(commit.batch_id, f.c.data_dir + '/verified-' + i + '.json');
            await f.consumer.consume();
            assert.equal(repo.currentOutput('x').notices.length, i === 4 ? 1 : 0);
        }
        await f.consumer.consume();
        await review(f, decision.contract_ref, 'confirm', 'decision-confirm-repeat');
        assert.equal(repo.currentOutput('x').notices.length, 1);
        await review(f, goal.contract_ref, 'retract');
        assert.equal(repo.currentOutput('x').notices.length, 0);
        const newGoal = { ...goal, contract_ref: { ...goal.contract_ref, revision: 2 }, target_version: 'v2' };
        await f.consumer.review({ schema_version: 1, kind: 'goal_contract', contract: newGoal });
        assert.equal(repo.confirmedGoals(f.c).length, 0);
    }
    finally {
        f.s.close();
    }
});
test('prior action explicitly continues into an empty later week rather than failing for a missing run', async () => {
    const f = await fixture();
    try {
        await f.consumer.consume();
        const first = await acceptWeek(f);
        await f.consumer.consume();
        const reviewer = createReviewer(f.s, f.c), b = (await reviewer.prepare({ kind: 'weekly', lane: 'history', period: '2026-10-11', cutoff: '2026-10-12T00:00:00Z' }))[0];
        assert.equal(b.analysis_context!.facts.length, 0);
        assert.equal(b.analysis_context!.prior_action!.state, 'active');
        const r = result(b, 'continue-action', false);
        r.analysis = semantic(b.analysis_context!);
        r.analysis.snapshot.validation_action = first.analysis.snapshot.validation_action;
        r.analysis.prior_action_disposition = { schema_version: 1, action_ref: b.analysis_context!.prior_action!.action_ref, disposition: 'continue', reason: 'Need another observation, previous action remains valid', evidence_refs: b.analysis_context!.prior_action!.evidence_refs };
        await reviewer.accept(r);
        assert.equal((await f.s.listOutbox()).at(-1)!.artifact.analysis!.snapshot.validation_action!.state, 'active');
        const forged = structuredClone(r);
        forged.result_id = 'action-forged';
        forged.analysis!.snapshot.direction = 'divergent';
        await assert.rejects(f.s.commitReview(forged), /identity conflict/);
    }
    finally {
        f.s.close();
    }
});
test('partial semantic inputs reject decline and divergence and cap exact confirmations before any accepted result', async () => {
    const f = await fixture(true);
    try {
        const reviewer = createReviewer(f.s, f.c), b = (await reviewer.prepare({ kind: 'weekly', lane: 'history', period: week, cutoff: at }))[0], r = result(b, 'invalid-analysis', false);
        r.analysis = semantic(b.analysis_context!);
        r.analysis.snapshot.direction = 'divergent';
        await assert.rejects(reviewer.accept(r), /incomplete coverage/);
        r.analysis.snapshot.direction = 'unknown';
        r.analysis.proposed_confirmations = Array.from({ length: 4 }, (_, i) => ({ schema_version: 1, logical_id: 'confirmation:' + i, revision: 1 }));
        await assert.rejects(reviewer.accept(r), /at most three/);
        assert.equal(await f.s.getReviewResult(r.result_id), null);
        assert.equal((await f.s.listOutbox()).length, 1);
    }
    finally {
        f.s.close();
    }
});
