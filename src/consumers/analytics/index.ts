import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AnalyticsReviewInput, BookkeepingConfig, Consumer, ConsumerOutcome, ReviewReceipt, Store, WeeklyAnalysisInput } from '../../contracts/types.ts';
import { canonical, digest } from '../../analytics/serialization.ts';
import { getAnalyticsPort, type AnalyticsPort, type AnalyticsOutput } from '../../store/analytics.ts';
import { analysisWeekRange, addCalendarDays } from '../../time.ts';
import { coverageStatus, factKey, analysisKey } from '../../analytics/model.ts';
import { validateAnalyticsInput } from '../../analytics/validation.ts';
import { createSafeWikiWriter, readWikiTarget, syncDirectory, type WriterOptions } from '../../publish/files.ts';
export const analyticsRepository = (store: Store): AnalyticsPort => getAnalyticsPort(store);
export interface AnalyticsOptions {
    now?: () => Date;
    writer?: WriterOptions;
    fault?: (stage: 'after_output' | 'before_ack', batchId: string) => void | Promise<void>;
}
export interface AnalyticsConsumer extends Consumer {
    review(input: unknown): Promise<ReviewReceipt[]>;
}
async function immutableOutput(path: string, bytes: Buffer): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
        const current = await readFile(path);
        if (!current.equals(bytes))
            throw new Error('Immutable Analytics output conflict');
        return;
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            throw error;
    }
    const temporary = path + '.' + randomUUID() + '.tmp';
    const handle = await open(temporary, 'wx', 0o600);
    try {
        await handle.writeFile(bytes);
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    try {
        await rename(temporary, path);
        await syncDirectory(dirname(path));
    }
    finally {
        await unlink(temporary).catch(() => { });
    }
}
/** Current professional evidence is projected from immutable READY artifacts, independently of source/Wiki availability. */
export async function prepareWeeklyAnalysis(store: Store, config: BookkeepingConfig, weekEnd: string): Promise<WeeklyAnalysisInput> {
    const repository = analyticsRepository(store);
    for (const batch of await store.listReadyBatches('analytics'))
        repository.ingest(batch, config);
    const range = analysisWeekRange(weekEnd);
    const facts = repository.facts().filter(fact => fact.occurred_at.value && Date.parse(fact.occurred_at.value) >= Date.parse(range.from) && Date.parse(fact.occurred_at.value) < Date.parse(range.to));
    const coverage = repository.coverage().filter(record => Date.parse(record.query_range.from) < Date.parse(range.to) && Date.parse(record.query_range.to) > Date.parse(range.from));
    const previous = repository.snapshots().filter(snapshot => snapshot.week_end < weekEnd && snapshot.week_end >= addCalendarDays(weekEnd, -28)).slice(-4);
    const latest = previous.at(-1);
    const goals = repository.confirmedGoals(config).filter(goal => !goal.deadline || Date.parse(goal.deadline) >= Date.parse(range.from));
    const currentKeys = new Set(facts.map(fact => factKey(fact.fact_ref)));
    const excluded = repository.exclusions().some(item => item.reason !== 'Outside professional whitelist' && (!item.occurred_at.value || (Date.parse(item.occurred_at.value) >= Date.parse(range.from) && Date.parse(item.occurred_at.value) < Date.parse(range.to))));
    const previousSnapshot = repository.rawSnapshot(weekEnd);
    return { schema_version: 1, analysis_ref: { schema_version: 1, logical_id: 'weekly:' + weekEnd, revision: repository.latestRevision('weekly:' + weekEnd) + 1 }, ...(previousSnapshot ? { previous_snapshot: previousSnapshot } : {}), week_end: weekEnd, range, analysis_timezone: 'Europe/Amsterdam', facts, coverage,
        coverage_status: excluded || repository.unresolvedHistory() ? 'partial' : coverageStatus(config, coverage, range), previous_weeks: previous,
        prior_action: latest?.validation_action?.state === 'active' ? latest.validation_action : null,
        confirmed_goal_refs: goals.map(goal => goal.contract_ref), confirmed_goals: goals,
        observation_candidates: repository.observations().filter(observation => observation.evidence_refs.some(ref => currentKeys.has(factKey(ref)))) };
}
const START = '<!-- bookkeeping-analytics:begin -->';
const END = '<!-- bookkeeping-analytics:end -->';
const COCKPIT = 'wiki/personal/synthesis/综合_self_analytics_current.md';
function region(output: AnalyticsOutput): string {
    const snapshots = output.snapshots.slice(-4);
    const latest = snapshots.at(-1);
    const lines = [START, '## 职业与学习分析', '', ...(output.freshness.length ? ['最近完整输出检查：' + output.freshness.at(-1)!.freshness_at, ''] : [])];
    if (!latest)
        lines.push('周语义审阅待完成；当前活动材料不证明能力趋势或方向。', '');
    for (const snapshot of snapshots) {
        lines.push(`### 截至 ${snapshot.week_end}`, `覆盖：${snapshot.coverage_status}；快照 ${snapshot.analysis_ref.logical_id} r${snapshot.analysis_ref.revision}`, '');
        for (const observation of snapshot.observations) {
            const overlay = output.overlays.find(item => analysisKey(item.observation_ref as any) === analysisKey(observation.observation_ref));
            const state = overlay?.confirmed ? '已确认' : '待确认';
            lines.push(`- ${observation.summary}（${observation.kind}；${state}；${observation.responsibility_basis}）`);
        }
        lines.push('', '能力趋势：');
        for (const capability of snapshot.capabilities)
            lines.push(`- ${capability.capability_id}：${capability.trend}。${capability.explanation}`);
        lines.push('', '目标差距：');
        for (const goal of snapshot.goal_gaps)
            lines.push(`- ${goal.description}（${goal.goal_ref.logical_id} r${goal.goal_ref.revision}）`);
        lines.push('', `方向：${snapshot.direction}`, ...snapshot.patterns.map(pattern => `- ${pattern}`), '');
    }
    if (latest?.validation_action?.state === 'active')
        lines.push(`当前验证动作：${latest.validation_action.description}（${latest.validation_action.action_ref.logical_id} r${latest.validation_action.action_ref.revision}）`, '');
    if (output.notices.length)
        lines.push('已满足显式重大决策验证条件：', ...output.notices.map(notice => `- ${notice.decision_ref.logical_id} r${notice.decision_ref.revision} / ${notice.fact_ref.fact_id} r${notice.fact_ref.revision}`), '');
    lines.push(END);
    return lines.join('\n');
}
export function createAnalyticsConsumer(store: Store, config: BookkeepingConfig, options: AnalyticsOptions = {}): AnalyticsConsumer {
    const repository = analyticsRepository(store);
    const writer = createSafeWikiWriter(store, config, options.writer);
    const now = () => (options.now?.() ?? new Date()).toISOString();
    const publishCockpit = async (output: AnalyticsOutput): Promise<ConsumerOutcome> => {
        const pendingIntent = repository.pendingCockpit();
        if (pendingIntent) {
            const intent = await store.getFileIntent(pendingIntent.operation_id);
            if (intent) {
                const recovered = await writer.write({ operation_id: intent.operation_id, path: intent.path, baseline_digest: intent.baseline_digest, desired_bytes: intent.desired_bytes_base64 === null ? null : Buffer.from(intent.desired_bytes_base64, 'base64'), fact_refs: intent.fact_refs });
                if (recovered.status !== 'applied' && recovered.status !== 'noop')
                    return { schema_version: 1, target: 'analytics', status: 'pending', reason: recovered.reason };
                repository.setCockpitRegion(pendingIntent.region);
            }
            repository.setPendingCockpit(null);
        }
        const target = await readWikiTarget(config.wiki_root, COCKPIT);
        const day = now().slice(0, 10);
        const current = target.bytes?.toString('utf8') ?? `---\ntitle: 职业学习分析\nnamespace: personal\ntype: personal-synthesis\nsummary: 职业学习证据与周验证动作\nsources: []\ntags: [self-analytics]\nstatus: stable\nprivacy: private\naliases: []\ncreated: ${day}\nupdated: ${day}\n---\n\n# 职业学习分析\n`;
        const desiredRegion = region(output);
        if (output.observations.some(o => o.summary.includes(START) || o.summary.includes(END)) || output.snapshots.some(snapshot => canonical(snapshot).includes(START) || canonical(snapshot).includes(END)))
            throw new Error('Managed-region delimiters cannot be semantic content');
        const start = current.indexOf(START);
        const end = current.indexOf(END);
        if ((start >= 0) !== (end >= 0) || (start >= 0 && (end < start || current.indexOf(START, start + START.length) >= 0 || current.indexOf(END, end + END.length) >= 0)))
            return { schema_version: 1, target: 'analytics', status: 'pending', reason: 'Cockpit managed region is malformed; manual content preserved' };
        const oldRegion = start >= 0 ? current.slice(start, end + END.length) : null;
        const saved = repository.cockpitRegion();
        if (saved !== null && oldRegion !== saved)
            return { schema_version: 1, target: 'analytics', status: 'pending', reason: 'Human changed the Analytics region; draft requires reconciliation' };
        if (oldRegion === desiredRegion)
            return { schema_version: 1, target: 'analytics', status: 'complete', reason: null };
        const desired = oldRegion === null ? current + (current.endsWith('\n') || !current ? '' : '\n') + '\n' + desiredRegion + '\n' : current.slice(0, start) + desiredRegion + current.slice(end + END.length);
        const operationId = 'analytics-cockpit:' + digest(canonical([target.digest, desiredRegion]));
        repository.setPendingCockpit({ operation_id: operationId, region: desiredRegion });
        const outcome = await writer.write({ operation_id: operationId, path: COCKPIT, baseline_digest: target.digest, desired_bytes: Buffer.from(desired), fact_refs: output.facts.map(fact => fact.fact_ref) });
        if (outcome.status === 'applied' || outcome.status === 'noop') {
            repository.setCockpitRegion(desiredRegion);
            repository.setPendingCockpit(null);
            return { schema_version: 1, target: 'analytics', status: 'complete', reason: null };
        }
        return { schema_version: 1, target: 'analytics', status: 'pending', reason: outcome.reason };
    };
    const queueCockpit = async (output: AnalyticsOutput, reason: string | null) => store.enqueueWork({ schema_version: 1, work_id: 'analytics-display:' + digest(canonical(output)), kind: 'analytics_display', lane: 'history', state: 'pending', payload: { batch_id: output.batch_id }, reason, migration_key: null, updated_at: now() });
    return {
        target: 'analytics',
        async consume(): Promise<ConsumerOutcome> {
            const batches = await store.listReadyBatches('analytics');
            let pending: string | null = null;
            const reports = new Set<string>();
            for (const batch of batches) {
                try {
                    const oldSnapshot = batch.analysis ? repository.rawSnapshot(batch.analysis.snapshot.week_end) : null;
                    const output = repository.ingest(batch, config);
                    if (batch.analysis && canonical(oldSnapshot) !== canonical(batch.analysis.snapshot))
                        reports.add('Weekly analysis changed; exact proposed confirmations remain user decisions');
                    if (output.exclusions.some(item => item.reason !== 'Outside professional whitelist'))
                        reports.add('Some professional evidence is excluded or pending; coverage cannot be treated as quiet');
                    await immutableOutput(join(config.data_dir, 'analytics', 'batches', digest(batch.batch_id) + '.json'), Buffer.from(canonical(output) + '\n'));
                    await options.fault?.('after_output', batch.batch_id);
                    for (const week of batch.analysis ? [] : batch.affected_weeks)
                        await store.enqueueWork({ schema_version: 1, work_id: `analytics-prepare:${batch.batch_id}:${week}`, kind: 'analytics_prepare', lane: 'history', state: 'pending', payload: { batch_id: batch.batch_id, week_end: addCalendarDays(week, 6) }, reason: 'External Codex semantic weekly review required', migration_key: null, updated_at: now() });
                    const current = repository.currentOutput(batch.batch_id);
                    const cockpit = await publishCockpit(current);
                    if (cockpit.status !== 'complete') {
                        pending = cockpit.reason;
                        await queueCockpit(output, cockpit.reason);
                        continue;
                    }
                    if (batch.analysis)
                        for (const id of batch.analysis.completed_work_ids ?? []) {
                            const work = (await store.listWork('analytics_prepare', 'pending')).find(item => item.work_id === id);
                            if (work)
                                await store.completeWork(id);
                        }
                    await options.fault?.('before_ack', batch.batch_id);
                    await store.acknowledgeConsumer({ schema_version: 1, consumer: 'analytics', batch_id: batch.batch_id, acknowledged_at: now() });
                    const queue = (await store.listWork('consumer')).find(item => item.work_id === 'consumer:analytics:' + batch.batch_id);
                    if (queue)
                        await store.completeWork(queue.work_id);
                }
                catch (error) {
                    pending = String(error);
                }
            }
            const display = await store.listWork('analytics_display', 'pending');
            if (display.length) {
                try {
                    const cockpit = await publishCockpit(repository.currentOutput('display'));
                    if (cockpit.status === 'complete')
                        for (const work of display)
                            await store.completeWork(work.work_id);
                    else
                        pending = cockpit.reason;
                }
                catch (error) {
                    pending = String(error);
                }
            }
            return { schema_version: 1, target: 'analytics', status: pending ? 'pending' : 'complete', reason: pending ?? (reports.size ? [...reports].join('; ') : null) };
        },
        async review(value: unknown): Promise<ReviewReceipt[]> {
            const input: AnalyticsReviewInput = validateAnalyticsInput(value);
            const receipts = repository.applyReview(input, config);
            const output = repository.currentOutput('review:' + digest(canonical(input)));
            await immutableOutput(join(config.data_dir, 'analytics', 'reviews', digest(canonical(input)) + '.json'), Buffer.from(canonical({ schema_version: 1, input, receipts: receipts.map(receipt => ({ ...receipt, status: receipt.status === 'already_applied' ? 'applied' : receipt.status })) }) + '\n'));
            const cockpit = await publishCockpit(output);
            if (cockpit.status !== 'complete')
                await queueCockpit(output, cockpit.reason);
            return receipts;
        },
    };
}
