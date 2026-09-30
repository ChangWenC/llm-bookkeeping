import { mkdir, open, rename, readFile, readdir, rm, lstat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, dirname, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { BookkeepingConfig, Store, Publisher, PublishResult, ReviewResult, JournalPatch, FileOutcome, FactArtifact } from '../contracts/types.ts';
import { acquireWikiLock } from './lock.ts';
import { SafeWikiWriter, digestBytes, readWikiTarget, syncDirectory, type WriterOptions } from './files.ts';
import { canonicalDailyDate, retainedJournal, retainedWindowStart } from './journals.ts';
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
  async function enqueue(kind: string, id: string, payload: Record<string, unknown>, reason: string | null = null): Promise<void> {
    await store.enqueueWork({ schema_version: 1, work_id: `${kind}:${id}`, kind, lane: 'live', state: 'pending', payload, reason, migration_key: null, updated_at: now() });
  }
  async function queueConsumers(artifact: FactArtifact): Promise<void> {
    const months = [...new Set([...artifact.affected_dates, ...artifact.affected_weeks].map(date => date.slice(0, 7)))].sort();
    for (const consumer of ['analytics', 'monthly']) await enqueue('consumer', `${consumer}:${artifact.batch_id}`, { consumer, batch_id: artifact.batch_id,
      affected_dates: artifact.affected_dates, affected_weeks: artifact.affected_weeks, affected_months: months });
    for (const [kind, periods] of [['date', artifact.affected_dates], ['week', artifact.affected_weeks], ['month', months]] as const)
      for (const period of periods) await enqueue(kind, `${artifact.batch_id}:${period}`, { period, batch_id: artifact.batch_id });
  }
  async function exportFacts(): Promise<{ ready: string[]; pending: string[] }> {
    const ready: string[] = [], pending: string[] = [];
    for (const entry of await store.listOutbox()) {
      let candidate: string | null = null;
      try {
        const parent = join(config.data_dir, 'facts', 'batches');
        await mkdir(parent, { recursive: true, mode: 0o700 });
        const destination = join(parent, hash(entry.batch_id));
        const file = join(destination, 'artifact.json');
        const bytes = Buffer.from(`${canonical(entry.artifact)}\n`);
        let existing: Buffer | null = null;
        try { existing = await readFile(file); } catch (error) { if (!missing(error)) throw error; }
        if (existing === null) {
          candidate = join(parent, `.export-${randomUUID()}`);
          await mkdir(candidate, { mode: 0o700 });
          const handle = await open(join(candidate, 'artifact.json'), 'wx', 0o600);
          try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
          await syncDirectory(candidate);
          try { await rename(candidate, destination); candidate = null; }
          catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
          await syncDirectory(parent);
          await options.fault?.('after_export_rename', entry.batch_id);
          existing = await readFile(file);
        }
        if (!existing.equals(bytes)) throw new Error('Immutable fact batch content conflict');
        await store.markExportReady(entry.batch_id, file);
        await queueConsumers(entry.artifact);
        for (const work of await store.listWork('export', 'pending')) if (work.work_id === `export:${entry.batch_id}`) await store.completeWork(work.work_id);
        ready.push(entry.batch_id);
      } catch (error) {
        pending.push(entry.batch_id);
        // Keep a specific visible reason independent of the Wiki/LLM stage.
        await enqueue('export', entry.batch_id, { batch_id: entry.batch_id }, message(error));
      } finally { if (candidate) await rm(candidate, { recursive: true, force: true }); }
    }
    return { ready, pending };
  }
  async function archivedDates(): Promise<Set<string>> {
    const result = new Set<string>();
    const add = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(add); return; }
      if (!value || typeof value !== 'object') return;
      const record = value as Record<string, unknown>;
      if (typeof record.date === 'string' && record.retention !== 'pinned' && validDate(record.date)) result.add(record.date);
      for (const key of ['archived_dates', 'entries', 'records', 'journals']) {
        if (key === 'archived_dates' && Array.isArray(record[key])) {
          for (const date of record[key]) if (typeof date === 'string' && validDate(date)) result.add(date);
        } else add(record[key]);
      }
    };
    try { add(JSON.parse(await readFile(join(config.data_dir, 'retention', 'state.json'), 'utf8'))); }
    catch (error) { if (!missing(error)) throw error; }
    // Store work is reconstructible evidence; local retention state is only a projection.
    for (const work of await store.listWork('archive', 'complete')) add(work.payload);
    const folder = join(config.wiki_root, 'wiki', 'personal', '_evidence', 'daily_journals');
    async function scan(path: string): Promise<void> {
      let entries;
      try { entries = await readdir(path, { withFileTypes: true }); } catch (error) { if (missing(error)) return; throw error; }
      for (const entry of entries) {
        const file = join(path, entry.name);
        if (entry.isSymbolicLink()) throw new Error('Symlink archive metadata rejected');
        if (entry.isDirectory()) await scan(file);
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) if (line.trim()) add(JSON.parse(line));
        } else if (entry.isFile() && entry.name.endsWith('.json')) add(JSON.parse(await readFile(file, 'utf8')));
      }
    }
    // The configured archive location itself may not follow a symlink.
    let parent = config.wiki_root;
    for (const part of ['wiki', 'personal', '_evidence', 'daily_journals']) {
      parent = join(parent, part);
      try { if ((await lstat(parent)).isSymbolicLink()) throw new Error('Symlink archive metadata rejected'); } catch (error) { if (!missing(error)) throw error; }
    }
    await scan(folder);
    return result;
  }
  async function applyPatches(patches: JournalPatch[]): Promise<FileOutcome[]> {
    if (!patches.length) return [];
    const lock = await acquireWikiLock(config.wiki_root);
    if (!lock) {
      const outcomes = patches.map(patch => fileOutcome(patch, 'pending', 'Wiki writer is active'));
      for (const outcome of outcomes) await store.markPatchStatus(outcome.operation_id, outcome.status, outcome.reason);
      return outcomes;
    }
    const outcomes: FileOutcome[] = [];
    try {
      let archived: Set<string> | null = null;
      for (const patch of patches) {
        let outcome: FileOutcome;
        try {
          const intent = await store.getFileIntent(patch.operation_id);
          if (intent) outcome = await writer.recoverLocked(intent, lock);
          else {
            if (!validDate(patch.date)) throw new Error('Invalid journal calendar date');
            const target = await readWikiTarget(config.wiki_root, patch.path);
            const dailyDate = canonicalDailyDate(target.path, target.bytes);
            if (dailyDate !== null && dailyDate !== patch.date) throw new Error('Journal patch date differs from canonical daily target');
            if (dailyDate !== null) archived ??= await archivedDates();
            const retained = target.bytes !== null && retainedJournal(target.bytes);
            const supplement = dailyDate !== null && ((archived!.has(patch.date) && !retained) || (target.bytes === null && patch.date < retainedWindowStart(config, options.now?.() ?? new Date())));
            if (supplement) {
              await enqueue('journal_supplement', patch.operation_id, { patch, reason: 'Archived or outside retained journal window' });
              outcome = fileOutcome(patch, 'noop', 'Facts retained; journal supplement queued without recreating daily Markdown');
            } else {
              const content = target.bytes ?? Buffer.alloc(0);
              let desired: Buffer;
              if (patch.mode === 'append') desired = Buffer.concat([content, content.length && content.at(-1) !== 10 ? Buffer.from('\n') : Buffer.alloc(0), Buffer.from(patch.new_text)]);
              else {
                if (!patch.old_text) throw new Error('Exact replacement requires nonempty old_text');
                const old = Buffer.from(patch.old_text);
                const first = content.indexOf(old);
                if (first < 0 || content.indexOf(old, first + 1) >= 0) {
                  outcome = fileOutcome(patch, 'conflict', 'Exact replacement target is missing or ambiguous');
                  await store.markPatchStatus(patch.operation_id, outcome.status, outcome.reason);
                  outcomes.push(outcome); continue;
                }
                desired = Buffer.concat([content.subarray(0, first), Buffer.from(patch.new_text), content.subarray(first + old.length)]);
              }
              // One local recomputation on the current manual baseline. No model
              // re-review and no subsequent forced rebase of the persisted intent.
              outcome = await writer.writeLocked({ operation_id: patch.operation_id, path: target.path, baseline_digest: target.digest,
                desired_bytes: desired, fact_refs: patch.fact_refs }, lock);
            }
          }
        } catch (error) { outcome = fileOutcome(patch, 'pending', message(error)); }
        await store.markPatchStatus(patch.operation_id, outcome.status, outcome.reason);
        outcomes.push(outcome);
      }
      return outcomes;
    } finally { await lock.release(); }
  }
  async function recovery(): Promise<FileOutcome[]> {
    // Includes review commits that crashed before their first FileIntent.
    const patches = await store.listPendingPatches();
    const outcomes = await applyPatches(patches);
    const seen = new Set(outcomes.map(outcome => outcome.operation_id));
    const intents = (await store.listFileIntents()).filter(intent => !seen.has(intent.operation_id));
    if (!intents.length) return outcomes;
    const lock = await acquireWikiLock(config.wiki_root);
    if (!lock) return outcomes.concat(intents.filter(intent => intent.state !== 'applied').map(intent => fileOutcome(intent, 'pending', 'Wiki writer is active')));
    try {
      for (const intent of intents) {
        try { outcomes.push(await writer.recoverLocked(intent, lock)); }
        catch (error) { outcomes.push(fileOutcome(intent, 'pending', message(error))); }
      }
    } finally { await lock.release(); }
    return outcomes;
  }
  async function result(resultId: string | null, batchId: string | null, reused: boolean, exports: { ready: string[]; pending: string[] }, files: FileOutcome[]): Promise<PublishResult> {
    const consumers: PublishResult['consumers'] = [];
    for (const target of ['analytics', 'monthly']) {
      const batches = await store.listReadyBatches(target);
      consumers.push({ schema_version: 1, target, status: batches.length || exports.pending.length ? 'pending' : 'complete',
        reason: batches.length || exports.pending.length ? 'Consumer output/acknowledgement outstanding; run consume separately' : null });
    }
    const indexWork = await store.listWork('index', 'pending');
    consumers.push({ schema_version: 1, target: 'index', status: indexWork.length ? 'pending' : 'complete', reason: indexWork.length ? 'Successfully written files await index consumption' : null });
    return { schema_version: 1, result_id: resultId, fact_commit: reused ? 'already_committed' : 'committed', batch_id: batchId,
      export_status: exports.pending.length ? 'pending' : 'ready', files,
      consumers,
      pending: [...exports.pending.map(id => `export:${id}`), ...files.filter(file => ['pending', 'conflict'].includes(file.status)).map(file => `file:${file.operation_id}`),
        ...consumers.filter(consumer => consumer.status === 'pending').map(consumer => `consumer:${consumer.target}`)] };
  }
  return {
    exportFacts, applyPatches,
    async publish(review: ReviewResult): Promise<PublishResult> {
      const commit = await store.commitReview(review);
      const exports = await exportFacts();
      const files = await recovery();
      return result(commit.result_id, commit.batch_id, commit.reused, exports, files);
    },
    async resume(): Promise<PublishResult> {
      const exports = await exportFacts();
      const files = await recovery();
      return result(null, null, true, exports, files);
    },
  };
}
