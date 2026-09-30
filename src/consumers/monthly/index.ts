import type { BookkeepingConfig, Consumer, ConsumerOutcome, Store, MonthlyReviewInput, FactArtifact } from '../../contracts/types.ts';
import { createSafeWikiWriter, acquireWikiLock, readWikiTarget } from '../../publish/index.ts';
import { checkMonth, monthlyPath, effectiveMonthFacts, sha } from '../archive/records.ts';
import type { WriterOptions } from '../../publish/files.ts';
import { analysisMonthRange } from '../../time.ts';
import { coverageStatus } from '../../analytics/model.ts';
import { updateManagedBlock, safeRegionText } from './blocks.ts';

const startPrefix = '<!-- bookkeeping:monthly-supplement:start';
const endMarker = '<!-- bookkeeping:monthly-supplement:end -->';
const refKey = (ref: { fact_id: string; revision: number }): string => `${ref.fact_id}:${ref.revision}`;
export interface MonthlyConsumer extends Consumer {
  prepareMonthlyContext(month: string): Promise<MonthlyReviewInput>;
  publishMonthlyReview(batch: FactArtifact): Promise<ConsumerOutcome>;
  refreshMonthlySupplements(month: string): Promise<ConsumerOutcome>;
}
export function createMonthlyConsumer(store: Store, config: BookkeepingConfig, options: WriterOptions = {}): MonthlyConsumer {
  const now = () => (options.now?.() ?? new Date()).toISOString();
  const writer = createSafeWikiWriter(store, config, options);
  async function enqueue(month: string, identity: string, extra: Record<string, unknown> = {}): Promise<void> {
    checkMonth(month);
    await store.enqueueWork({ schema_version: 1, work_id: `prepare-monthly:${identity}:${month}`, kind: 'prepare_monthly', lane: 'history', state: 'pending',
      payload: { kind: 'monthly', month, ...extra }, reason: 'Prepare bounded monthly review separately; no nested LLM', migration_key: null, updated_at: now() });
  }
  const consumer: MonthlyConsumer = {
    target: 'monthly',
    async prepareMonthlyContext(month: string): Promise<MonthlyReviewInput> {
      const range = analysisMonthRange(month), facts = await effectiveMonthFacts(store, month), coverage = await store.listCoverage(range);
      const baseline = await readWikiTarget(config.wiki_root, monthlyPath(month));
      const status = coverageStatus(config, coverage, range);
      return { schema_version: 1, month, range, facts, coverage, coverage_status: status,
        manual_baselines: [{ schema_version: 1, path: baseline.path, digest: baseline.digest, content: baseline.bytes?.toString('utf8') ?? null }] };
    },
    async consume(): Promise<ConsumerOutcome> {
      const batches = await store.listReadyBatches('monthly');
      const supplements = await store.listWork('journal_supplement', 'pending');
      for (const batch of batches) {
        const months = [...new Set([...(batch.affected_months ?? []), ...batch.affected_dates.map(date => date.slice(0, 7)), ...batch.affected_weeks.map(date => date.slice(0, 7))])];
        // A monthly semantic output is already prepared. Its file publication is
        // handled by Publisher; never enqueue the same accepted result as new LLM work.
        if (batch.monthly_review) for (let index = months.length - 1; index >= 0; index--) if (months[index] === batch.monthly_review.month) months.splice(index, 1);
        for (const month of months) await enqueue(month, batch.batch_id, { batch_id: batch.batch_id });
        await store.acknowledgeConsumer({ schema_version: 1, consumer: 'monthly', batch_id: batch.batch_id, acknowledged_at: now() });
        for (const work of await store.listWork('consumer', 'pending')) if (work.payload.consumer === 'monthly' && work.payload.batch_id === batch.batch_id) await store.completeWork(work.work_id);
      }
      for (const work of supplements) {
        const patch = work.payload.patch as { date?: string } | undefined;
        if (typeof patch?.date !== 'string') throw new Error('Supplement lacks original journal date');
        await enqueue(patch.date.slice(0, 7), work.work_id, { supplement_work_id: work.work_id });
      }
      for (const work of await store.listWork('month', 'pending')) {
        const month = String(work.payload.period); await enqueue(month, work.work_id, { batch_id: work.payload.batch_id }); await store.completeWork(work.work_id);
      }
      return { schema_version: 1, target: 'monthly', status: 'complete', reason: batches.length || supplements.length ? 'Monthly preparation work durably queued; semantic review remains separate' : null };
    },
    async publishMonthlyReview(batch: FactArtifact): Promise<ConsumerOutcome> {
      const review = batch.monthly_review;
      if (!review) throw new Error('FactArtifact has no monthly semantic result');
      checkMonth(review.month);
      const records = await store.listWork('monthly_review_record', 'complete');
      const newer = records.some(record => record.payload.month === review.month && String(record.payload.created_at) > batch.created_at);
      if (!newer) {
        const lock = await acquireWikiLock(config.wiki_root);
        if (!lock) return { schema_version: 1, target: 'monthly', status: 'pending', reason: 'Wiki writer is active' };
        try {
          const path = monthlyPath(review.month);
          for (const intent of await store.listFileIntents(['prepared', 'pending', 'conflict'])) if (intent.path === path && intent.operation_id.startsWith(`monthly-review:${batch.batch_id}:`)) {
            const recovered = await writer.recoverLocked(intent, lock);
            if (recovered.status === 'pending' || recovered.status === 'conflict') return { schema_version: 1, target: 'monthly', status: 'partial', reason: recovered.reason };
          }
          const target = await readWikiTarget(config.wiki_root, path);
          const content = target.bytes?.toString('utf8') ?? `---\ntitle: 回顾_${review.month.replaceAll('-', '_')}\ntype: journal\nnamespace: personal\njournal_class: monthly-review\nsummary: ${JSON.stringify(`${review.month} 月回顾，覆盖与证据见正文`)}\nsources: []\ntags: [monthly-review]\nstatus: stable\naliases: []\nprivacy: private\nperiod: ${review.month}\ncanonical_record_id: month:${review.month}\narchive_target: none\nretention: pinned\ncreated: ${now().slice(0, 10)}\nupdated: ${now().slice(0, 10)}\n---\n\n# ${review.month} 月回顾\n`;
          if (target.bytes && !Buffer.from(content).equals(target.bytes)) throw new Error('Monthly manual body is not lossless UTF-8; preserve and defer');
          const coverage = review.coverage_status === 'complete' ? '覆盖：已采集并审阅的范围完整。' : review.coverage_status === 'partial' ? '覆盖：仍有采集或审阅缺口，不能据此判断整月无活动。' : '覆盖：范围未知，仍待补全。';
          const body = `## 月回顾摘要\n\n${safeRegionText(review.summary)}\n\n${coverage}\n${review.supplement_text ? `\n${safeRegionText(review.supplement_text)}\n` : ''}\n`;
          const desired = updateManagedBlock(content, 'monthly-review', review.month, body);
          const outcome = await writer.writeLocked({ operation_id: `monthly-review:${batch.batch_id}:${sha(target.digest)}`, path, baseline_digest: target.digest,
            desired_bytes: Buffer.from(desired), fact_refs: review.fact_refs }, lock);
          if (outcome.status === 'pending' || outcome.status === 'conflict') return { schema_version: 1, target: 'monthly', status: 'partial', reason: outcome.reason };
          await store.enqueueWork({ schema_version: 1, work_id: `monthly-review-record:${batch.batch_id}`, kind: 'monthly_review_record', lane: 'history', state: 'complete',
            payload: { batch_id: batch.batch_id, month: review.month, created_at: batch.created_at, review }, reason: null, migration_key: null, updated_at: now() });
        } catch (error) { return { schema_version: 1, target: 'monthly', status: 'pending', reason: (error as Error).message }; }
        finally { await lock.release(); }
      }
      const displayed = await consumer.refreshMonthlySupplements(review.month);
      if (displayed.status !== 'complete') return displayed;
      await store.acknowledgeConsumer({ schema_version: 1, consumer: 'monthly-publish', batch_id: batch.batch_id, acknowledged_at: now() });
      return { schema_version: 1, target: 'monthly', status: 'complete', reason: newer ? 'Newer published monthly review retained; old accepted result remains historical' : null };
    },
    async refreshMonthlySupplements(month: string): Promise<ConsumerOutcome> {
      checkMonth(month);
      // Read/fold facts before obtaining the file lock, never hold it across semantic work.
      const facts = await effectiveMonthFacts(store, month);
      const lock = await acquireWikiLock(config.wiki_root);
      if (!lock) return { schema_version: 1, target: 'monthly', status: 'pending', reason: 'Wiki writer is active' };
      try {
        const path = monthlyPath(month);
        for (const intent of await store.listFileIntents(['prepared', 'pending', 'conflict'])) if (intent.path === path && intent.operation_id.startsWith('monthly-supplement:')) {
          const recovered = await writer.recoverLocked(intent, lock);
          if (recovered.status === 'conflict' || recovered.status === 'pending') return { schema_version: 1, target: 'monthly', status: 'partial', reason: recovered.reason };
        }
        const target = await readWikiTarget(config.wiki_root, path);
        if (target.bytes === null) {
          await enqueue(month, 'missing-monthly-page');
          return { schema_version: 1, target: 'monthly', status: 'pending', reason: 'Monthly review must be prepared before supplement display' };
        }
        const content = target.bytes.toString('utf8');
        if (!Buffer.from(content).equals(target.bytes)) throw new Error('Monthly manual body is not lossless UTF-8; preserve and defer');
        const opening = /<!-- bookkeeping:monthly-supplement:start month=(\d{4}-\d{2}) digest=([a-f\d]{64}) -->\n/g;
        const matches = [...content.matchAll(opening)], starts = content.split(startPrefix).length - 1, ends = content.split(endMarker).length - 1;
        if (starts !== matches.length || matches.length > 1 || ends !== matches.length || matches.some(match => match[1] !== month)) return { schema_version: 1, target: 'monthly', status: 'partial', reason: 'Supplement markers are missing, duplicated or malformed' };
        let oldBlock: string | null = null;
        if (matches.length) {
          const match = matches[0], bodyStart = match.index! + match[0].length, end = content.indexOf(endMarker, bodyStart);
          if (end < bodyStart || sha(content.slice(bodyStart, end)) !== match[2]) return { schema_version: 1, target: 'monthly', status: 'partial', reason: 'Manual edits inside derived supplement retained; regeneration deferred' };
          oldBlock = content.slice(match.index!, end + endMarker.length);
        }
        const represented = new Set<string>();
        for (const intent of await store.listFileIntents(['applied'])) if (intent.path === path && !intent.operation_id.startsWith('monthly-supplement:')) intent.fact_refs.forEach(ref => represented.add(refKey(ref)));
        // Imported sealed legacy assertions are existing base context, not newly added supplement prose.
        const displayed = facts.filter(fact => !(fact.kind === 'legacy_record' && fact.action === 'assert' && fact.legacy_locator !== null) && !represented.has(refKey(fact)));
        const latestReview = (await store.listWork('monthly_review_record', 'complete')).filter(record => record.payload.month === month)
          .sort((left, right) => String(right.payload.created_at).localeCompare(String(left.payload.created_at)))[0];
        const reviewedRefs = (latestReview?.payload.review as FactArtifact['monthly_review'])?.fact_refs ?? [];
        const effective = new Set(facts.map(refKey));
        const invalidated = reviewedRefs.filter(ref => !effective.has(refKey(ref)));
        if (invalidated.length) await enqueue(month, 'invalidated-summary:' + sha(JSON.stringify(invalidated)), { invalidated_fact_refs: invalidated });
        const invalidationNotice = invalidated.length ? '月回顾摘要的部分依据已更正或撤回，原结论已失效，待重新审阅计算。\n\n' : '';
        const labels = { fact: '事实', inference: '推断', recommendation: '建议', legacy_record: '历史记录，未核验' };
        const body = `## 补记与更正\n\n${invalidationNotice}${displayed.length ? displayed.map(fact => {
          const date = fact.journal_date.value ?? fact.occurred_at.value?.slice(0, 10) ?? '日期待核对';
          const text = fact.content.replaceAll('<!--', '&lt;!--').replaceAll('-->', '--&gt;').replaceAll('\n', '\n  ');
          return `- ${date}：${text}（${labels[fact.kind]}） <!-- fact-ref:${sha(refKey(fact))} -->`;
        }).join('\n') : '当前没有待展示的有效补记。'}\n\n`;
        const block = `${startPrefix} month=${month} digest=${sha(body)} -->\n${body}${endMarker}`;
        const desired = oldBlock === null ? `${content}${content.endsWith('\n') ? '\n' : '\n\n'}${block}\n` : content.replace(oldBlock, block);
        const id = `monthly-supplement:${month}:${sha(`${target.digest}:${sha(desired)}`)}`;
        const outcome = await writer.writeLocked({ operation_id: id, path, baseline_digest: target.digest, desired_bytes: Buffer.from(desired), fact_refs: displayed.map(({ fact_id, revision }) => ({ schema_version: 1, fact_id, revision })) }, lock);
        if (outcome.status === 'pending' || outcome.status === 'conflict') return { schema_version: 1, target: 'monthly', status: 'partial', reason: outcome.reason };
        for (const work of await store.listWork('journal_supplement', 'pending')) if ((work.payload.patch as { date?: string })?.date?.startsWith(month)) await store.completeWork(work.work_id);
        return { schema_version: 1, target: 'monthly', status: 'complete', reason: null };
      } catch (error) { return { schema_version: 1, target: 'monthly', status: 'pending', reason: (error as Error).message }; }
      finally { await lock.release(); }
    },
  };
  return consumer;
}
