import type { BookkeepingConfig, Consumer, ConsumerOutcome, Store, MonthlyReviewInput, FactArtifact, JournalPatch, FactRef, FactRevision, JournalPublicationPayload, FileOutcome, WorkItem } from '../../contracts/types.ts';
import { createSafeWikiWriter, acquireWikiLock, readWikiTarget } from '../../publish/index.ts';
import { checkMonth, monthlyPath, effectiveMonthFacts, monthRange, sha } from '../archive/records.ts';
import { hasOperationTime, type WriterOptions } from '../../publish/files.ts';
import { analysisMonthRange } from '../../time.ts';
import { coverageStatus } from '../../analytics/model.ts';
import { updateManagedBlock, monthlyReviewBody } from './blocks.ts';
import { affectedMonths } from '../periods.ts';
import { canonicalDailyDate } from '../../publish/journals.ts';
import { storageFailureCode } from '../../storage-errors.ts';

const startPrefix = '<!-- bookkeeping:monthly-supplement:start';
const endMarker = '<!-- bookkeeping:monthly-supplement:end -->';
const refKey = (ref: { fact_id: string; revision: number }): string => `${ref.fact_id}:${ref.revision}`;
export interface MonthlyConsumer extends Consumer {
  prepareMonthlyContext(month: string): Promise<MonthlyReviewInput>;
  publishMonthlyReview(batch: FactArtifact): Promise<ConsumerOutcome & { files?: FileOutcome[] }>;
  refreshMonthlySupplements(month: string): Promise<ConsumerOutcome & { files?: FileOutcome[] }>;
}
export function createMonthlyConsumer(store: Store, config: BookkeepingConfig, options: WriterOptions = {}): MonthlyConsumer {
  const now = () => (options.now?.() ?? new Date()).toISOString();
  const writer = createSafeWikiWriter(store, config, options);
  const orderingPending = (): ConsumerOutcome => ({ schema_version: 1, target: 'monthly', status: 'pending', reason: 'Monthly publication acceptance order is unavailable; output debt retained' });
  async function batchOrder(batchId: unknown): Promise<number | null> {
    if (typeof batchId !== 'string' || !store.getPublicationBatchOrder) return null;
    const order = await store.getPublicationBatchOrder(batchId);
    return order !== null && Number.isSafeInteger(order) && order > 0 ? order : null;
  }
  async function latestRecord(records: WorkItem[]): Promise<WorkItem | null | undefined> {
    if (!records.length) return null;
    // A single historical record needs no relative ordering. Multiple records
    // require fresh proof from this Store; model timestamps are not commit order.
    if (records.length === 1) return records[0];
    let latest: WorkItem | undefined, latestOrder = 0;
    for (const record of records) {
      const order = await batchOrder(record.payload.batch_id);
      if (order === null) return undefined;
      if (order > latestOrder) { latest = record; latestOrder = order; }
    }
    return latest;
  }
  async function enqueue(month: string, identity: string, extra: Record<string, unknown> = {}): Promise<void> {
    checkMonth(month);
    await store.enqueueWork({ schema_version: 1, work_id: `prepare-monthly:${identity}:${month}`, kind: 'prepare_monthly', lane: 'history', state: 'pending',
      payload: { kind: 'monthly', month, ...extra }, reason: 'Prepare bounded monthly review separately; no nested LLM', migration_key: null, updated_at: now() });
  }
  const consumer: MonthlyConsumer = {
    target: 'monthly',
    async prepareMonthlyContext(month: string): Promise<MonthlyReviewInput> {
      const range = analysisMonthRange(month), facts = await effectiveMonthFacts(store, month, now()), coverage = await store.listCoverage(range);
      const baseline = await readWikiTarget(config.wiki_root, monthlyPath(month));
      const status = coverageStatus(config, coverage, range);
      return { schema_version: 1, month, range, facts, coverage, coverage_status: status,
        manual_baselines: [{ schema_version: 1, path: baseline.path, digest: baseline.digest, content: baseline.bytes?.toString('utf8') ?? null }] };
    },
    async consume(): Promise<ConsumerOutcome> {
      if (!hasOperationTime(options)) return { schema_version: 1, target: 'monthly', status: 'pending', reason: 'Task deadline reached; monthly work retained' };
      const batches = await store.listReadyBatches('monthly', 64);
      const supplements = await store.listWork('journal_supplement', 'pending');
      for (const batch of batches) {
        if (!hasOperationTime(options)) return { schema_version: 1, target: 'monthly', status: 'partial', reason: 'Task deadline reached; unread batches retained' };
        const months = affectedMonths(batch);
        // A monthly semantic output is already prepared. Its file publication is
        // handled by Publisher; never enqueue the same accepted result as new LLM work.
        if (batch.monthly_review) for (let index = months.length - 1; index >= 0; index--) if (months[index] === batch.monthly_review.month) months.splice(index, 1);
        for (const month of months) await enqueue(month, batch.batch_id, { batch_id: batch.batch_id });
        await store.acknowledgeConsumer({ schema_version: 1, consumer: 'monthly', batch_id: batch.batch_id, acknowledged_at: now() });
        for (const work of await store.listWork('consumer', 'pending')) if (work.payload.consumer === 'monthly' && work.payload.batch_id === batch.batch_id) await store.completeWork(work.work_id);
      }
      for (const work of supplements) {
        if (!hasOperationTime(options)) return { schema_version: 1, target: 'monthly', status: 'partial', reason: 'Task deadline reached; supplements retained' };
        const patch = work.payload.patch as { date?: string } | undefined;
        if (typeof patch?.date !== 'string') throw new Error('Supplement lacks original journal date');
        await enqueue(patch.date.slice(0, 7), work.work_id, { supplement_work_id: work.work_id });
      }
      const acceptedMonthly = new Set(batches.filter(batch => batch.monthly_review).map(batch => `${batch.batch_id}:${batch.monthly_review!.month}`));
      for (const work of await store.listWork('month', 'pending')) {
        if (!hasOperationTime(options)) return { schema_version: 1, target: 'monthly', status: 'partial', reason: 'Task deadline reached; month work retained' };
        const month = String(work.payload.period);
        if (!acceptedMonthly.has(`${work.payload.batch_id}:${month}`)) await enqueue(month, work.work_id, { batch_id: work.payload.batch_id });
        await store.completeWork(work.work_id);
      }
      return { schema_version: 1, target: 'monthly', status: 'complete', reason: batches.length || supplements.length ? 'Monthly preparation work durably queued; semantic review remains separate' : null };
    },
    async publishMonthlyReview(batch: FactArtifact): Promise<ConsumerOutcome & { files?: FileOutcome[] }> {
      if (!hasOperationTime(options)) return { schema_version: 1, target: 'monthly', status: 'pending', reason: 'Task deadline reached before monthly publication' };
      const review = batch.monthly_review;
      if (!review) throw new Error('FactArtifact has no monthly semantic result');
      checkMonth(review.month);
      const files: FileOutcome[] = [];
      const pendingPreparation = await store.listWork('prepare_monthly', 'pending');
      const pendingOriginals = await store.listWork('archive_context', 'pending');
      const records = (await store.listWork('monthly_review_record', 'complete')).filter(record => record.payload.month === review.month);
      const currentOrder = await batchOrder(batch.batch_id);
      if (currentOrder === null) return orderingPending();
      let newer = false;
      for (const record of records) {
        const order = await batchOrder(record.payload.batch_id);
        if (order === null) return orderingPending();
        if (order > currentOrder) newer = true;
      }
      if (!newer) {
        const lock = await acquireWikiLock(config.wiki_root);
        if (!lock) return { schema_version: 1, target: 'monthly', status: 'pending', reason: 'Wiki writer is active' };
        try {
          const path = monthlyPath(review.month);
          for (const intent of await store.listFileIntents(['prepared', 'pending', 'conflict'])) if (intent.path === path && intent.operation_id.startsWith(`monthly-review:${batch.batch_id}:`)) {
            const recovered = await writer.recoverLocked(intent, lock);
            files.push(recovered);
            if (recovered.status === 'pending' || recovered.status === 'conflict') return { schema_version: 1, target: 'monthly', status: 'partial', reason: recovered.reason, files };
          }
          const target = await readWikiTarget(config.wiki_root, path);
          const content = target.bytes?.toString('utf8') ?? `---\ntitle: 回顾_${review.month.replaceAll('-', '_')}\ntype: journal\nnamespace: personal\njournal_class: monthly-review\nsummary: ${JSON.stringify(`${review.month} 月回顾，覆盖与证据见正文`)}\nsources: []\ntags: [monthly-review]\nstatus: stable\naliases: []\nprivacy: private\nperiod: ${review.month}\ncanonical_record_id: month:${review.month}\narchive_target: none\nretention: pinned\ncreated: ${now().slice(0, 10)}\nupdated: ${now().slice(0, 10)}\n---\n\n# ${review.month} 月回顾\n`;
          if (target.bytes && !Buffer.from(content).equals(target.bytes)) throw new Error('Monthly manual body is not lossless UTF-8; preserve and defer');
          const body = monthlyReviewBody(review);
          const desired = updateManagedBlock(content, 'monthly-review', review.month, body);
          const outcome = await writer.writeLocked({ operation_id: `monthly-review:${batch.batch_id}:${sha(target.digest)}`, path, baseline_digest: target.digest,
            desired_bytes: Buffer.from(desired), fact_refs: review.fact_refs }, lock);
          files.push(outcome);
          if (outcome.status === 'pending' || outcome.status === 'conflict') return { schema_version: 1, target: 'monthly', status: 'partial', reason: outcome.reason, files };
          await store.enqueueWork({ schema_version: 1, work_id: `monthly-review-record:${batch.batch_id}`, kind: 'monthly_review_record', lane: 'history', state: 'complete',
            payload: { batch_id: batch.batch_id, month: review.month, created_at: batch.created_at, review }, reason: null, migration_key: null, updated_at: now() });
        } catch (error) { const code = storageFailureCode(error); return { schema_version: 1, target: 'monthly', status: 'pending', reason: (error as Error).message, files, ...(code ? { failure_scope: 'storage', failure_code: code } : {}) }; }
        finally { await lock.release(); }
      }
      const displayed = await consumer.refreshMonthlySupplements(review.month);
      files.push(...displayed.files ?? []);
      if (displayed.status !== 'complete') return { ...displayed, files };
      for (const workId of newer ? [] : review.completed_work_ids ?? []) {
        const work = pendingPreparation.find(item => item.work_id === workId);
        if (work?.payload.month === review.month) await store.completeWork(workId);
      }
      for (const workId of newer ? [] : review.completed_archive_context_ids ?? []) {
        const work = pendingOriginals.find(item => item.work_id === workId);
        if (work?.payload.month === review.month) await store.completeWork(workId);
      }
      await store.acknowledgeConsumer({ schema_version: 1, consumer: 'monthly-publish', batch_id: batch.batch_id, acknowledged_at: now() });
      return { schema_version: 1, target: 'monthly', status: 'complete', files, reason: newer ? 'Newer published monthly review retained; old accepted result remains historical' : null };
    },
    async refreshMonthlySupplements(month: string): Promise<ConsumerOutcome & { files?: FileOutcome[] }> {
      if (!hasOperationTime(options)) return { schema_version: 1, target: 'monthly', status: 'pending', reason: 'Task deadline reached before supplement display' };
      checkMonth(month);
      // Freeze output debt BEFORE reading facts: a later arrival cannot borrow this render.
      const supplementHistory = (await store.listWork('journal_supplement')).filter(work => (work.payload.patch as JournalPatch | undefined)?.date?.startsWith(`${month}-`));
      const supplements = supplementHistory.filter(work => work.state === 'pending');
      const journalHistory = (await store.listWork('journal_publication')).filter(work => {
        const payload = work.payload as unknown as JournalPublicationPayload;
        return payload.date?.startsWith(`${month}-`) && (payload.path === monthlyPath(month) || supplementHistory.some(item => {
          const patch = item.payload.patch as JournalPatch;
          return patch.operation_id === payload.operation_id && patch.date === payload.date && canonicalDailyDate(payload.path) === payload.date;
        }));
      });
      const journalWork = journalHistory.filter(work => work.state === 'pending');
      const displayHistory = (await store.listWork('monthly_display')).filter(work => work.payload.month === month);
      const displayWork = displayHistory.filter(work => work.state === 'pending');
      const displayBatches = new Map((await store.listReadyBatches('monthly-display', 64)).map(batch => [batch.batch_id, batch]));
      const latestReview = await latestRecord((await store.listWork('monthly_review_record', 'complete')).filter(record => record.payload.month === month));
      if (latestReview === undefined) return orderingPending();
      const frozenRefs = new Map<string, FactRef>();
      for (const work of supplementHistory) for (const ref of (work.payload.patch as JournalPatch).fact_refs ?? []) frozenRefs.set(refKey(ref), ref);
      for (const work of journalHistory) { const ref = (work.payload as unknown as JournalPublicationPayload).fact_ref; if (ref) frozenRefs.set(refKey(ref), ref); }
      for (const work of displayHistory) {
        const refs = work.payload.fact_refs as FactRef[] | undefined;
        for (const ref of refs ?? displayBatches.get(String(work.payload.batch_id))?.facts ?? []) frozenRefs.set(refKey(ref), { schema_version: 1, fact_id: ref.fact_id, revision: ref.revision });
      }
      const lookup = (store as Store & { lookupFactRevisions?(refs: FactRef[]): FactRevision[] | Promise<FactRevision[]> }).lookupFactRevisions;
      const revisions = lookup ? await lookup.call(store, [...frozenRefs.values()]) : [];
      const targets = lookup ? await lookup.call(store, revisions.flatMap(fact => fact.target_refs)) : [];
      const asOf = now();
      // Exact replacement targets may have moved to another month. Query only the
      // bounded date span of the frozen revisions, retaining the same operation clock.
      const range = monthRange(month);
      const dates = revisions.concat(targets).map(fact => fact.journal_date.value ?? fact.occurred_at.value?.slice(0, 10)).filter((date): date is string => !!date).sort();
      if (dates.length) {
        const first = `${dates[0]}T00:00:00.000Z`;
        const last = new Date(`${dates.at(-1)}T12:00:00Z`); last.setUTCDate(last.getUTCDate() + 2);
        if (first < range.from) range.from = first;
        if (last.toISOString() > range.to) range.to = last.toISOString();
      }
      // One frozen effective fold per month, before the file lock.
      const relatedEffective = await store.readEffectiveFacts({ range, as_of: asOf });
      const facts = relatedEffective.filter(fact => (fact.journal_date.value ?? fact.occurred_at.value?.slice(0, 10))?.startsWith(`${month}-`))
        .sort((left, right) => (left.journal_date.value ?? left.occurred_at.value ?? '').localeCompare(right.journal_date.value ?? right.occurred_at.value ?? '') || left.fact_id.localeCompare(right.fact_id) || left.revision - right.revision);
      const relatedKeys = new Set(relatedEffective.map(refKey));
      const correctionRefs = new Map<string, FactRevision>();
      for (const fact of revisions) {
        if (fact.recorded_at > asOf || !fact.target_refs.length) continue;
        const monthTargets = targets.filter(target => fact.target_refs.some(ref => refKey(ref) === refKey(target)) && (target.journal_date.value ?? target.occurred_at.value?.slice(0, 10))?.startsWith(`${month}-`));
        if (!monthTargets.length || monthTargets.some(target => relatedKeys.has(refKey(target)))) continue;
        if (fact.action === 'replace' && relatedKeys.has(refKey(fact)) || fact.action === 'retract' && !relatedEffective.some(current => current.fact_id === fact.fact_id)) correctionRefs.set(refKey(fact), fact);
      }
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
        const reviewedRefs = (latestReview?.payload.review as FactArtifact['monthly_review'])?.fact_refs ?? [];
        const represented = new Set<string>();
        if (latestReview && content.includes(`<!-- bookkeeping:monthly-review:start month=${month} `)) {
          // Validation preserves manual edits in the summary as a local conflict;
          // only this current intact review block represents its explicit refs.
          updateManagedBlock(content, 'monthly-review', month, '');
          reviewedRefs.forEach(ref => represented.add(refKey(ref)));
        }
        // Imported sealed legacy assertions are existing base context, not newly added supplement prose.
        const displayed = facts.filter(fact => !(fact.kind === 'legacy_record' && fact.action === 'assert' && fact.legacy_locator !== null) && !represented.has(refKey(fact)));
        const effective = new Set(facts.map(refKey));
        const invalidated = reviewedRefs.filter(ref => !effective.has(refKey(ref)));
        if (invalidated.length) await enqueue(month, 'invalidated-summary:' + sha(JSON.stringify(invalidated)), { invalidated_fact_refs: invalidated });
        const invalidationNotice = invalidated.length ? '月回顾摘要的部分依据已更正或撤回，原结论已失效，待重新审阅计算。\n\n' : '';
        const labels = { fact: '事实', inference: '推断', recommendation: '建议', legacy_record: '历史记录，未核验' };
        const correctionNotice = [...correctionRefs.values()].filter(fact => !displayed.some(item => refKey(item) === refKey(fact))).map(fact =>
          `- ${month} 的相关记录已${fact.action === 'retract' ? '撤回' : '更正至其他日期'}。 <!-- fact-ref:${sha(refKey(fact))} -->`).join('\n');
        const body = `## 补记与更正\n\n${invalidationNotice}${correctionNotice ? correctionNotice + '\n\n' : ''}${displayed.length ? displayed.map(fact => {
          const date = fact.journal_date.value ?? fact.occurred_at.value?.slice(0, 10) ?? '日期待核对';
          const text = fact.content.replaceAll('<!--', '&lt;!--').replaceAll('-->', '--&gt;').replaceAll('\n', '\n  ');
          return `- ${date}：${text}（${labels[fact.kind]}） <!-- fact-ref:${sha(refKey(fact))} -->`;
        }).join('\n') : '当前没有待展示的有效补记。'}\n\n`;
        const block = `${startPrefix} month=${month} digest=${sha(body)} -->\n${body}${endMarker}`;
        const desired = oldBlock === null ? `${content}${content.endsWith('\n') ? '\n' : '\n\n'}${block}\n` : content.replace(oldBlock, block);
        const renderedFacts = [...new Map([...displayed, ...facts.filter(fact => represented.has(refKey(fact))), ...correctionRefs.values()].map(fact => [refKey(fact), fact])).values()];
        const renderedRefs = renderedFacts.map(({ fact_id, revision }) => ({ schema_version: 1 as const, fact_id, revision })).sort((a,b) => a.fact_id.localeCompare(b.fact_id) || a.revision-b.revision);
        const id = `monthly-supplement:${month}:${sha(`${target.digest}:${sha(desired)}:${JSON.stringify(renderedRefs)}`)}`;
        const outcome = await writer.writeLocked({ operation_id: id, path, baseline_digest: target.digest, desired_bytes: Buffer.from(desired), fact_refs: renderedRefs }, lock);
        if (outcome.status === 'pending' || outcome.status === 'conflict') return { schema_version: 1, target: 'monthly', status: 'partial', reason: outcome.reason };
        const verified = await readWikiTarget(config.wiki_root, path);
        if (verified.bytes?.toString('utf8') !== desired) return { schema_version: 1, target: 'monthly', status: 'partial', reason: 'Monthly output changed before display acknowledgement' };
        const rendered = new Set(renderedFacts.map(refKey));
        const journalDisplayIds = journalWork.filter(work => rendered.has(refKey((work.payload as unknown as JournalPublicationPayload).fact_ref))).map(work => work.work_id);
        if (journalDisplayIds.length) {
          if (!store.completeJournalDisplay) return { schema_version: 1, target: 'monthly', status: 'partial', reason: 'Journal display acknowledgement unavailable; displayed debt retained' };
          await store.completeJournalDisplay(journalDisplayIds, id, lock);
        }
        for (const work of supplements) {
          const patch = work.payload.patch as JournalPatch;
          if (patch.fact_refs.length && patch.fact_refs.every(ref => rendered.has(refKey(ref)))) await store.completeWork(work.work_id);
        }
        for (const work of displayWork) {
          const batch = displayBatches.get(String(work.payload.batch_id));
          if (!batch) continue;
          const included = batch.facts.every(fact => {
            // Sealed legacy originals are existing base context. Their display
            // consumer verifies the derived exclusion, never journal debt completion.
            if (fact.kind === 'legacy_record' && fact.action === 'assert' && fact.legacy_locator != null) return true;
            const ownMonth = (fact.journal_date.value ?? fact.occurred_at.value?.slice(0, 10))?.slice(0, 7);
            const referencedTargets = fact.target_refs.map(ref => targets.find(target => refKey(ref) === refKey(target)));
            if (referencedTargets.some(target => !target)) return false;
            const affectsMonth = ownMonth === month || referencedTargets.some(target => (target!.journal_date.value ?? target!.occurred_at.value?.slice(0, 10))?.startsWith(`${month}-`));
            return affectsMonth ? rendered.has(refKey(fact)) : ownMonth !== undefined;
          });
          if (included) await store.completeWork(work.work_id);
        }
        return { schema_version: 1, target: 'monthly', status: 'complete', reason: null, files: [outcome] };
      } catch (error) { const code = storageFailureCode(error); return { schema_version: 1, target: 'monthly', status: 'pending', reason: (error as Error).message, ...(code ? { failure_scope: 'storage', failure_code: code } : {}) }; }
      finally { await lock.release(); }
    },
  };
  return consumer;
}
