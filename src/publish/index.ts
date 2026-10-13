import { mkdir, open, rename, readFile, rm } from 'node:fs/promises';
import { join, dirname, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { BookkeepingConfig, Store, Publisher, PublishResult, ReviewResult, JournalPatch, FileOutcome, FactArtifact, OutboxEntry, ReviewCommit, FileIntent } from '../contracts/types.ts';
import { acquireWikiLock } from './lock.ts';
import { SafeWikiWriter, digestBytes, readWikiTarget, syncDirectory, supersededOutcome, operationSupersession, hasOperationTime, localWrite, type WriterOptions } from './files.ts';
import { canonicalDailyDate, retainedJournal, retainedWindowStart } from './journals.ts';
import { affectedMonths } from '../consumers/periods.ts';
import { storageFailureCode } from '../storage-errors.ts';
export { acquireWikiLock, withWikiLock, wikiLockLocation, assertWikiLockHeld } from './lock.ts';
export { createSafeWikiWriter, SafeWikiWriter, digestBytes, resolveWikiPath, readWikiTarget } from './files.ts';
export type { WikiLock } from './lock.ts';
export type { SafeWriteRequest, WriterOptions, FaultStage } from './files.ts';

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const validDate = (date: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(date) && new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) === date;
const fileOutcome = (patch: Pick<JournalPatch, 'operation_id' | 'path'>, status: FileOutcome['status'], reason: string | null = null): FileOutcome => ({ schema_version: 1, operation_id: patch.operation_id, path: patch.path, status, reason });

/** No LLM calls: immutable review acceptance precedes independent export and Wiki publication. */
export function createPublisher(store: Store, config: BookkeepingConfig, options: WriterOptions = {}): Publisher {
  if (!isAbsolute(config.data_dir) || !isAbsolute(config.wiki_root)) throw new Error('Explicit absolute data_dir and wiki_root required');
  const writer = new SafeWikiWriter(store, config, options);
  const now = () => (options.now?.() ?? new Date()).toISOString();
  let storageCode: string | null = null;
  async function enqueue(kind: string, id: string, payload: Record<string, unknown>, reason: string | null = null): Promise<void> {
    await store.enqueueWork({ schema_version: 1, work_id: `${kind}:${id}`, kind, lane: 'live', state: 'pending', payload, reason, migration_key: null, updated_at: now() });
  }
  async function queueConsumers(artifact: FactArtifact): Promise<void> {
    const months = affectedMonths(artifact);
    // Evidence independently discovers ready batches and tracks kind:evidence
    // work. Do not create a second consumer queue for already acknowledged mirrors.
    for (const consumer of ['analytics', 'monthly']) await enqueue('consumer', `${consumer}:${artifact.batch_id}`, { consumer, batch_id: artifact.batch_id,
      affected_dates: artifact.affected_dates, affected_weeks: artifact.affected_weeks, affected_months: months });
    for (const [kind, periods] of [['date', artifact.affected_dates], ['week', artifact.affected_weeks], ['month', months]] as const)
      for (const period of periods) await enqueue(kind, `${artifact.batch_id}:${period}`, { period, batch_id: artifact.batch_id });
  }
  const recoveryLimit = 64;
  const partialReasons = new Set<string>();
  async function exportEntry(entry: OutboxEntry, exports: { ready: string[]; pending: string[] }): Promise<void> {
    if (!hasOperationTime(options) || storageCode) { exports.pending.push(entry.batch_id); return; }
    let candidate: string | null = null;
    let registered = false;
    try {
      const parent = join(config.data_dir, 'facts', 'batches');
      await localWrite(() => mkdir(parent, { recursive: true, mode: 0o700 }));
      const destination = join(parent, hash(entry.batch_id)), file = join(destination, 'artifact.json');
      const bytes = Buffer.from(`${canonical(entry.artifact)}\n`);
      let existing: Buffer | null = null;
      try { existing = await readFile(file); } catch (error) { if (!missing(error)) throw error; }
      if (existing === null) {
        candidate = join(parent, `.export-${randomUUID()}`);
        await localWrite(() => mkdir(candidate!, { mode: 0o700 }));
        await localWrite(async () => {
          const handle = await open(join(candidate!, 'artifact.json'), 'wx', 0o600);
          try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        });
        await syncDirectory(candidate);
        try { await localWrite(() => rename(candidate!, destination)); candidate = null; }
        catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
        await syncDirectory(parent);
        await options.fault?.('after_export_rename', entry.batch_id);
        existing = await readFile(file);
      }
      if (!existing.equals(bytes)) throw new Error('Immutable fact batch content conflict');
      await store.markExportReady(entry.batch_id, file);
      registered = true; exports.ready.push(entry.batch_id);
      await queueConsumers(entry.artifact);
      if ((await store.listWork('export', 'pending')).some(work => work.work_id === `export:${entry.batch_id}`)) await store.completeWork(`export:${entry.batch_id}`);
    } catch (error) {
      storageCode ??= storageFailureCode(error);
      if (!registered) exports.pending.push(entry.batch_id);
      if (storageCode || registered) throw error;
      await enqueue('export', entry.batch_id, { batch_id: entry.batch_id }, message(error));
    } finally { if (candidate && !storageCode) await localWrite(() => rm(candidate!, { recursive: true, force: true })); }
  }
  async function exportFacts(exports = { ready: [] as string[], pending: [] as string[] }): Promise<{ ready: string[]; pending: string[] }> {
    const exact = store.getPublicationOutbox;
    const seen = new Set([...exports.ready, ...exports.pending]);
    if (!hasOperationTime(options) || storageCode) return exports;
    if (!store.listPublicationOutbox) {
      partialReasons.add('Bounded outbox recovery unavailable; history was not enumerated');
      return exports;
    }
    // Genuine pending exports precede the rotating ready-batch integrity audit.
    const pending = await store.listPublicationOutbox({ schema_version: 1, status: 'pending', limit: recoveryLimit });
    for (const entry of pending.items) {
      if (!hasOperationTime(options) || storageCode) break;
      if (!seen.has(entry.batch_id)) { seen.add(entry.batch_id); await exportEntry(entry, exports); }
    }
    if (pending.next_cursor) partialReasons.add('Additional pending exports remain for the next bounded recovery');
    if (exact) for (const work of await store.listWork('export', 'pending')) {
      if (!hasOperationTime(options) || storageCode) break;
      const id = String(work.payload.batch_id);
      if (seen.has(id)) continue;
      const entry = await exact.call(store, id);
      if (entry) { seen.add(id); await exportEntry(entry, exports); }
    }
    if (!hasOperationTime(options) || storageCode) return exports;
    if (!store.getPublicationRecoveryCursor || !store.setPublicationRecoveryCursor) {
      partialReasons.add('Persistent ready export audit cursor unavailable'); return exports;
    }
    let after = await store.getPublicationRecoveryCursor('ready_exports');
    for (let checked = 0; checked < recoveryLimit && hasOperationTime(options) && !storageCode; checked++) {
      // A one-item page exposes the exact opaque continuation after each checked item.
      const audit = await store.listPublicationOutbox({ schema_version: 1, status: 'ready', limit: 1, ...(after ? { after } : {}) });
      const entry = audit.items[0];
      if (entry) try {
        if (!entry.export_path) throw new Error('Ready export path is missing');
        const bytes = await readFile(entry.export_path);
        if (!bytes.equals(Buffer.from(`${canonical(entry.artifact)}\n`))) throw new Error('Ready immutable export integrity conflict');
      } catch (error) {
        storageCode ??= storageFailureCode(error);
        if (storageCode) throw error;
        await enqueue('export', entry.batch_id, { batch_id: entry.batch_id }, message(error));
        if (!exports.pending.includes(entry.batch_id)) exports.pending.push(entry.batch_id);
      }
      after = audit.next_cursor;
      await store.setPublicationRecoveryCursor('ready_exports', after);
      if (!after) break;
    }
    return exports;
  }
  async function archivedDates(): Promise<{ dates: Set<string>; uncertain: Set<string> }> {
    const dates = new Set<string>(), uncertain = new Set<string>();
    const add = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(add); return; }
      if (!value || typeof value !== 'object') return;
      const record = value as Record<string, unknown>;
      if (typeof record.date === 'string' && record.retention !== 'pinned' && validDate(record.date)) dates.add(record.date);
      if (Array.isArray(record.archived_dates)) for (const date of record.archived_dates) if (typeof date === 'string' && validDate(date)) dates.add(date);
      for (const key of ['entries', 'records', 'journals']) add(record[key]);
    };
    try { add(JSON.parse(await readFile(join(config.data_dir, 'retention', 'state.json'), 'utf8'))); }
    catch (error) {
      if (!missing(error)) await enqueue('retention_projection', hash(config.data_dir), { path: join(config.data_dir, 'retention', 'state.json') }, message(error));
    }
    for (const work of await store.listWork('archive', 'complete')) add(work.payload);
    const { readArchiveRecords } = await import('../consumers/archive/records.ts');
    const records = await readArchiveRecords(config);
    for (const item of records) add(item.record);
    for (const issue of records.issues) {
      if (issue.date) uncertain.add(issue.date);
      await enqueue('archive_record', hash(JSON.stringify(issue)), { ...issue }, issue.reason);
    }
    return { dates, uncertain };
  }
  async function applyPatches(patches: JournalPatch[], collected: FileOutcome[] = []): Promise<FileOutcome[]> {
    if (!patches.length) return collected;
    if (!hasOperationTime(options) || storageCode) { collected.push(...await Promise.all(patches.map(async patch => (await store.getFileIntent(patch.operation_id))?.state === 'applied' ? fileOutcome(patch, 'noop') : ({ ...fileOutcome(patch, 'pending', storageCode ? 'Shared storage unavailable; accepted patch retained' : 'Task deadline reached; accepted patch retained'), ...(storageCode ? { failure_scope: 'storage' as const, failure_code: storageCode } : {}) })))); return collected; }
    const lock = await acquireWikiLock(config.wiki_root);
    if (!lock) {
      const outcomes: FileOutcome[] = collected;
      for (const patch of patches) {
        if (!hasOperationTime(options) || storageCode) { outcomes.push(fileOutcome(patch, (await store.getFileIntent(patch.operation_id))?.state === 'applied' ? 'noop' : 'pending', 'Deadline/storage unavailable; accepted patch retained')); continue; }
        const terminal = await supersededOutcome(store, patch);
        if (!terminal && (await store.getFileIntent(patch.operation_id))?.state === 'applied') { outcomes.push(fileOutcome(patch, 'noop')); continue; }
        const outcome = terminal ?? fileOutcome(patch, 'pending', 'Wiki writer is active');
        if (!terminal) await store.markPatchStatus(outcome.operation_id, outcome.status, outcome.reason);
        outcomes.push(outcome);
      }
      return outcomes;
    }
    const outcomes: FileOutcome[] = collected;
    try {
      let archived: { dates: Set<string>; uncertain: Set<string> } | null = null;
      for (const patch of patches) {
        if (!hasOperationTime(options) || storageCode) { outcomes.push(fileOutcome(patch, (await store.getFileIntent(patch.operation_id))?.state === 'applied' ? 'noop' : 'pending', 'Deadline/storage unavailable; accepted patch retained')); continue; }
        const terminal = await supersededOutcome(store, patch);
        if (terminal) { outcomes.push(terminal); continue; }
        let outcome: FileOutcome;
        try {
          const intent = await store.getFileIntent(patch.operation_id);
          if ((intent?.state as string) === 'superseded') { outcomes.push(fileOutcome(patch, 'pending', 'Superseded FileIntent remains terminal')); continue; }
          if (intent?.state === 'applied') outcome = await writer.recoverLocked(intent, lock);
          else {
            if (!validDate(patch.date)) throw new Error('Invalid journal calendar date');
            const target = await readWikiTarget(config.wiki_root, patch.path);
            const dailyDate = canonicalDailyDate(target.path, target.bytes);
            if (dailyDate !== null && dailyDate !== patch.date) throw new Error('Journal patch date differs from canonical daily target');
            if (dailyDate !== null) { archived ??= await archivedDates(); if (archived.uncertain.has(patch.date)) throw new Error('Malformed archive record for this date remains pending'); }
            const retained = target.bytes !== null && retainedJournal(target.bytes);
            const supplement = dailyDate !== null && ((archived!.dates.has(patch.date) && !retained) || (target.bytes === null && patch.date < retainedWindowStart(config, options.now?.() ?? new Date())));
            if (supplement) {
              const workId = `journal_supplement:${patch.operation_id}`;
              const work = (await store.listWork('journal_supplement')).find(item => item.work_id === workId);
              if (work?.state === 'complete') outcome = fileOutcome(patch, 'noop', 'Derived monthly supplement previously verified');
              else {
                await enqueue('journal_supplement', patch.operation_id, { patch, reason: 'Archived or outside retained journal window' });
                outcome = { ...fileOutcome(patch, 'pending', 'Journal supplement queued; target display remains outstanding'), queued_work_ids: [workId] };
              }
            } else if (intent) outcome = await writer.recoverLocked(intent, lock);
            else {
              const content = target.bytes ?? Buffer.alloc(0);
              let desired: Buffer;
              if (patch.mode === 'append') desired = Buffer.concat([content, content.length && content.at(-1) !== 10 ? Buffer.from('\n') : Buffer.alloc(0), Buffer.from(patch.new_text)]);
              else {
                if (!patch.old_text) throw new Error('Exact replacement requires nonempty old_text');
                const old = Buffer.from(patch.old_text);
                const first = content.indexOf(old);
                if (first < 0 || content.indexOf(old, first + 1) >= 0) {
                  outcome = fileOutcome(patch, 'conflict', 'Exact replacement target is missing or ambiguous');
                  if (!await operationSupersession(store, patch.operation_id)) await store.markPatchStatus(patch.operation_id, outcome.status, outcome.reason);
                  outcomes.push(outcome); continue;
                }
                desired = Buffer.concat([content.subarray(0, first), Buffer.from(patch.new_text), content.subarray(first + old.length)]);
              }
              // Freeze full bytes on the current baseline. Semantic replacement
              // or a changed accepted baseline must pass the writer's human
              // confirmation guard; a persisted intent is never rebased.
              outcome = await writer.writeLocked({ operation_id: patch.operation_id, path: target.path, baseline_digest: target.digest,
                desired_bytes: desired, fact_refs: patch.fact_refs, supersedes_operation_id: patch.supersedes_operation_id,
                requires_journal_confirmation: dailyDate !== null && target.bytes !== null && target.digest !== patch.baseline_digest }, lock);
            }
          }
        } catch (error) { const code = storageFailureCode(error); storageCode ??= code; const persisted = await store.getFileIntent(patch.operation_id); outcome = { ...fileOutcome(patch, persisted?.state === 'applied' ? 'applied' : 'pending', message(error)), ...(code ? { failure_scope: 'storage' as const, failure_code: code } : {}) }; }
        outcomes.push(outcome);
        if (!storageCode && !await operationSupersession(store, patch.operation_id)) await store.markPatchStatus(patch.operation_id, outcome.status, outcome.reason);
        if (storageCode) break;
      }
      return outcomes;
    } finally { await lock.release(); }
  }
  async function recovery(outcomes: FileOutcome[] = []): Promise<FileOutcome[]> {
    const seen = new Set(outcomes.map(outcome => outcome.operation_id));
    const patches = (await store.listPendingPatches()).filter(patch => !seen.has(patch.operation_id));
    await applyPatches(patches, outcomes);
    outcomes.forEach(outcome => seen.add(outcome.operation_id));
    if (!hasOperationTime(options) || storageCode) return outcomes;
    if (!store.listPublicationFileIntents) {
      partialReasons.add('Bounded file intent recovery unavailable; history was not enumerated'); return outcomes;
    }
    const pending = await store.listPublicationFileIntents({ schema_version: 1, states: ['prepared', 'pending', 'conflict'], limit: recoveryLimit });
    if (pending.next_cursor) partialReasons.add('Additional pending file intents remain for the next bounded recovery');
    const intents: FileIntent[] = pending.items.filter(intent => !seen.has(intent.operation_id));
    // Prioritize genuinely pending work before any completed operation audit.
    const lock = intents.length ? await acquireWikiLock(config.wiki_root) : null;
    if (intents.length && !lock) {
      outcomes.push(...intents.map(intent => fileOutcome(intent, 'pending', 'Wiki writer is active')));
      return outcomes;
    }
    try {
      for (const intent of intents) {
        if (!hasOperationTime(options) || storageCode) break;
        try { outcomes.push(await writer.recoverLocked(intent, lock!)); }
        catch (error) {
          const code = storageFailureCode(error); storageCode ??= code;
          const persisted = await store.getFileIntent(intent.operation_id);
          outcomes.push({ ...fileOutcome(intent, persisted?.state === 'applied' ? 'applied' : 'pending', message(error)), ...(code ? { failure_scope: 'storage' as const, failure_code: code } : {}) });
          if (storageCode) throw error;
        }
      }
    } finally { if (lock) await lock.release(); }
    if (hasOperationTime(options) && !storageCode) {
      if (!store.getPublicationRecoveryCursor || !store.setPublicationRecoveryCursor) partialReasons.add('Persistent applied file audit cursor unavailable');
      else {
        let after = await store.getPublicationRecoveryCursor('applied_intents');
        const auditLock = await acquireWikiLock(config.wiki_root);
        if (auditLock) try {
          for (let checked = 0; checked < recoveryLimit && hasOperationTime(options) && !storageCode; checked++) {
            const audit = await store.listPublicationFileIntents({ schema_version: 1, states: ['applied'], limit: 1, ...(after ? { after } : {}) });
            const intent = audit.items[0];
            if (intent) {
              // Applied targets remain noops after human edits; audit restores only lost index debt.
              try {
                const reported = await writer.recoverLocked(intent, auditLock);
                if (!outcomes.some(outcome => outcome.operation_id === intent.operation_id)) outcomes.push(reported);
              } catch (error) { storageCode ??= storageFailureCode(error); throw error; }
            }
            after = audit.next_cursor;
            await store.setPublicationRecoveryCursor('applied_intents', after);
            if (!after) break;
          }
        } finally { await auditLock.release(); }

      }
    }
    // Retry semantic deletion owners only AFTER releasing the ordinary writer
    // lock. ArchiveService takes the same lock and rechecks every dependency.
    const deferred = outcomes.filter(outcome => outcome.status === 'pending' && outcome.operation_id.startsWith('archive-delete:'));
    if (deferred.length) {
      const plans = await store.listWork('archive_plan');
      const { createArchiveService, archiveDeleteOperationMatches } = await import('../consumers/archive/index.ts');
      const matches = (work: typeof plans[number], outcome: FileOutcome) => {
        const intent = intents.find(intent => intent.operation_id === outcome.operation_id);
        return intent && typeof work.payload.path === 'string' && typeof work.payload.delete_operation === 'string' &&
          archiveDeleteOperationMatches({ path: work.payload.path, delete_operation: work.payload.delete_operation }, intent);
      };
      const months = new Set(plans.filter(work => deferred.some(outcome => matches(work, outcome)))
        .map(work => String(work.payload.month)));
      for (const month of months) {
        if (!hasOperationTime(options) || storageCode) break;
        try {
          const resumePaths = deferred.filter(outcome => plans.some(work => work.payload.month === month && matches(work, outcome))).map(outcome => outcome.path);
          const archived = await createArchiveService(store, config, { ...options, resumePaths }).run({ month, mode: 'apply' });
          for (const file of archived.files ?? []) if (!outcomes.some(outcome => outcome.operation_id === file.operation_id)) outcomes.push(file);
          for (const outcome of deferred) {
            const plan = plans.find(work => work.payload.month === month && matches(work, outcome));
            if (!plan) continue;
            const intent = await store.getFileIntent(outcome.operation_id);
            const page = archived.pages.find(page => page.path === outcome.path);
            if (intent?.state === 'applied') { outcome.status = 'applied'; outcome.reason = null; }
            else outcome.reason = page?.reason ?? archived.reason ?? outcome.reason;
          }

        } catch (error) { storageCode ??= storageFailureCode(error); if (storageCode) throw error; for (const outcome of deferred) if (plans.some(work => work.payload.month === month && matches(work, outcome))) outcome.reason = message(error); }
      }
    }
    return outcomes;
  }
  async function monthlyOutputs(files: FileOutcome[] = [], current?: FactArtifact, outcomes: PublishResult['consumers'] = []): Promise<PublishResult['consumers']> {
    if (!hasOperationTime(options) || storageCode) { outcomes.push({ schema_version: 1, target: 'monthly', status: 'pending', reason: 'Deadline/storage unavailable before monthly output', ...(storageCode ? { failure_scope: 'storage', failure_code: storageCode } : {}) }); return outcomes; }
    const publicationPage = await store.listReadyBatches('monthly-publish', recoveryLimit);
    // Daily/weekly batches have no semantic monthly file output. Acknowledge
    // only this inapplicable consumer so a bounded page can reach later reviews.
    for (const batch of publicationPage) {
      if (!hasOperationTime(options) || storageCode) break;
      if (!batch.monthly_review) await store.acknowledgeConsumer({ schema_version: 1, consumer: 'monthly-publish', batch_id: batch.batch_id, acknowledged_at: now() });
    }
    const batches = [...new Map([...(current?.monthly_review ? [current] : []), ...publicationPage].filter(batch => batch.monthly_review).map(batch => [batch.batch_id, batch])).values()];
    const displayBatches = [...new Map([...(current ? [current] : []), ...await store.listReadyBatches('monthly-display', recoveryLimit)].map(batch => [batch.batch_id, batch])).values()];
    if (!batches.length && !displayBatches.length) return [];
    const { createMonthlyConsumer } = await import('../consumers/monthly/index.ts');
    const monthly = createMonthlyConsumer(store, config, options);
    for (const batch of batches) {
      if (!hasOperationTime(options) || storageCode) { outcomes.push({ schema_version: 1, target: `monthly-publish:${batch.batch_id}`, status: 'pending', reason: 'Deadline/storage unavailable; accepted monthly output retained' }); continue; }
      let outcome;
      try { outcome = await monthly.publishMonthlyReview(batch); }
      catch (error) { storageCode ??= storageFailureCode(error); outcome = { schema_version: 1 as const, target: 'monthly', status: 'pending' as const, reason: message(error) }; }
      if (outcome.failure_scope === 'storage') storageCode ??= outcome.failure_code ?? 'BOOKKEEPING_STORAGE_FAILURE';
      files.push(...(outcome as typeof outcome & { files?: FileOutcome[] }).files ?? []);
      outcomes.push({ ...outcome, target: `monthly-publish:${batch.batch_id}` });
    }
    // Snapshot the unacknowledged batches, group by month, refresh once per month.
    // Batches arriving while files are rendered remain unacknowledged for the next run.
    const monthsByBatch = new Map<string, string[]>();
    const batchesByMonth = new Map<string, FactArtifact[]>();
    const displayHistory = new Map((await store.listWork('monthly_display')).map(work => [work.work_id, work]));
    for (const batch of displayBatches) {
      if (!hasOperationTime(options) || storageCode) break;
      const months = affectedMonths(batch);
      monthsByBatch.set(batch.batch_id, months);
      for (const month of months) {
        const grouped = batchesByMonth.get(month) ?? [];
        grouped.push(batch); batchesByMonth.set(month, grouped);
        const existing = displayHistory.get(`monthly_display:${batch.batch_id}:${month}`);
        // Older saved work legitimately omits refs. Its exact ready batch is the
        // monthly consumer's compatibility fallback; do not rewrite its identity.
        if (!existing || existing.payload.fact_refs !== undefined || existing.payload.month !== month || existing.payload.batch_id !== batch.batch_id)
          await enqueue('monthly_display', `${batch.batch_id}:${month}`, { month, batch_id: batch.batch_id, fact_refs: batch.facts.map(({ fact_id, revision }) => ({ schema_version: 1, fact_id, revision })) });
      }
    }
    const completedDisplayWork = new Set<string>();
    for (const [month, grouped] of batchesByMonth) {
      if (!hasOperationTime(options) || storageCode) { outcomes.push({ schema_version: 1, target: `monthly-display:${month}`, status: 'pending', reason: 'Deadline/storage unavailable before display' }); continue; }
      let outcome;
      try { outcome = await monthly.refreshMonthlySupplements(month); }
      catch (error) { storageCode ??= storageFailureCode(error); outcome = { schema_version: 1 as const, target: 'monthly', status: 'pending' as const, reason: message(error) }; }
      if (outcome.failure_scope === 'storage') storageCode ??= outcome.failure_code ?? 'BOOKKEEPING_STORAGE_FAILURE';
      files.push(...(outcome as typeof outcome & { files?: FileOutcome[] }).files ?? []);
      outcomes.push({ ...outcome, target: `monthly-display:${month}` });
      if (outcome.status === 'complete') {
        const completed = new Set((await store.listWork('monthly_display', 'complete')).map(work => work.work_id));
        for (const batch of grouped) if (completed.has(`monthly_display:${batch.batch_id}:${month}`)) completedDisplayWork.add(`monthly_display:${batch.batch_id}:${month}`);
      }
    }
    for (const batch of displayBatches) if (hasOperationTime(options) && !storageCode && monthsByBatch.has(batch.batch_id) && monthsByBatch.get(batch.batch_id)!.every(month => completedDisplayWork.has(`monthly_display:${batch.batch_id}:${month}`)))
      await store.acknowledgeConsumer({ schema_version: 1, consumer: 'monthly-display', batch_id: batch.batch_id, acknowledged_at: now() });
    return outcomes;
  }
  async function result(resultId: string | null, batchId: string | null, reused: boolean, exports: { ready: string[]; pending: string[] }, files: FileOutcome[], monthly: PublishResult['consumers']): Promise<PublishResult> {
    const consumers: PublishResult['consumers'] = monthly;
    for (const target of ['analytics', 'monthly', 'evidence']) {
      const batches = await store.listReadyBatches(target, 1);
      consumers.push({ schema_version: 1, target, status: batches.length || exports.pending.length ? 'pending' : 'complete',
        reason: batches.length || exports.pending.length ? 'Consumer output/acknowledgement outstanding; run consume separately' : null });
    }
    const indexWork = await store.listWork('index', 'pending');
    consumers.push({ schema_version: 1, target: 'index', status: indexWork.length || !hasOperationTime(options) ? 'pending' : 'complete', reason: indexWork.length ? 'Successfully written files await index consumption' : !hasOperationTime(options) ? 'Deadline reached; remaining index recovery is pending' : null });
    return { schema_version: 1, ...(storageCode ? { execution_status: 'storage_unavailable' as const } : partialReasons.size ? { execution_status: 'partial' as const } : {}), result_id: resultId, fact_commit: reused ? 'already_committed' : 'committed', batch_id: batchId,
      export_status: batchId ? (exports.ready.includes(batchId) ? 'ready' : 'pending') : exports.pending.length ? 'pending' : 'ready', files,
      consumers,
      pending: [...partialReasons, ...exports.pending.map(id => `export:${id}`), ...files.filter(file => ['pending', 'conflict'].includes(file.status)).map(file => `file:${file.operation_id}`),
        ...files.flatMap(file => file.queued_work_ids ?? []),
        ...consumers.filter(consumer => consumer.status === 'pending' || consumer.status === 'partial').map(consumer => `consumer:${consumer.target}`)] };
  }
  async function runPublication(commit: ReviewCommit | null): Promise<PublishResult> {
    const exports = { ready: [] as string[], pending: [] as string[] };
    const files: FileOutcome[] = [], monthly: PublishResult['consumers'] = [];
    let currentArtifact: FactArtifact | undefined;
    let stage: 'export' | 'recovery' | 'monthly' | 'result' = 'export';
    try {
      // New accepted files are not delayed by older pending or applied intent history.
      if (commit) {
        if (store.getPublicationOutbox) {
          const current = await store.getPublicationOutbox(commit.batch_id);
          if (!current) throw new Error('Committed publication batch is missing');
          await exportEntry(current, exports);
          if (exports.ready.includes(current.batch_id)) currentArtifact = current.artifact;
        } else partialReasons.add('Exact current batch publication lookup unavailable');
        stage = 'recovery'; await applyPatches(commit.patches, files);
      }
      if (storageCode) throw Object.assign(new Error('Shared storage unavailable after committed file operation'), { code: storageCode });
      stage = 'export'; await exportFacts(exports);
      stage = 'recovery'; await recovery(files);
      if (storageCode) throw Object.assign(new Error('Shared storage unavailable during file recovery'), { code: storageCode });
      stage = 'monthly'; await monthlyOutputs(files, currentArtifact, monthly);
      if (storageCode) throw Object.assign(new Error('Shared storage unavailable during monthly publication'), { code: storageCode });
      stage = 'result'; return await result(commit?.result_id ?? null, commit?.batch_id ?? null, commit?.reused ?? true, exports, files, monthly);
    } catch (error) {
      storageCode ??= storageFailureCode(error);
      const receipt: PublishResult = { schema_version: 1, execution_status: storageCode ? 'storage_unavailable' : 'partial',
        result_id: commit?.result_id ?? null, batch_id: commit?.batch_id ?? null,
        fact_commit: commit ? (commit.reused ? 'already_committed' : 'committed') : 'already_committed',
        export_status: commit ? (exports.ready.includes(commit.batch_id) ? 'ready' : 'pending') : exports.pending.length ? 'pending' : 'ready', files, consumers: monthly,
        pending: [...partialReasons, ...exports.pending.map(id => `export:${id}`), `publication:${stage}`],
        continuation: { schema_version: 1, stage, status: 'failed', reason: message(error) } };
      throw Object.assign(error instanceof Error ? error : new Error(message(error)), { receipt });
    }
  }
  return {
    exportFacts: () => { storageCode = null; partialReasons.clear(); return exportFacts(); },
    applyPatches: patches => { storageCode = null; partialReasons.clear(); return applyPatches(patches); },
    async publish(review: ReviewResult): Promise<PublishResult> {
      storageCode = null; partialReasons.clear();
      if (!hasOperationTime(options)) return { schema_version: 1, result_id: review.result_id, batch_id: null, fact_commit: 'pending', export_status: 'pending', files: [], consumers: [], pending: ['Task deadline reached before acceptance'] };
      const commit = await store.commitReview(review);
      return runPublication(commit);
    },
    async resume(): Promise<PublishResult> {
      storageCode = null; partialReasons.clear();
      return runPublication(null);
    },
  };
}
