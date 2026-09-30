import { constants } from 'node:fs';
import { mkdir, lstat, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BookkeepingConfig, Consumer, Store } from '../../contracts/types.ts';
import { canonical, digest } from '../../analytics/serialization.ts';
import { createSafeWikiWriter, readWikiTarget, syncDirectory, type WriterOptions } from '../../publish/files.ts';

export const evidencePath = (batchId: string): string => `wiki/personal/_evidence/bookkeeping/batches/${digest(batchId)}.json`;
export interface EvidenceOptions extends WriterOptions { max_batches?: number }

/** Ready accepted facts only; raw source fragments never enter the Wiki mirror. */
export function createEvidenceConsumer(store: Store, config: BookkeepingConfig, options: EvidenceOptions = {}): Consumer {
  const limit = options.max_batches ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Evidence max_batches must be an integer from 1 to 100');
  const writer = createSafeWikiWriter(store, config, options);
  const directory = join(config.data_dir, 'consumers', 'evidence');
  const cursorPath = join(directory, 'cursor.json');
  async function cursorDirectory(): Promise<void> {
    for (const path of [join(config.data_dir, 'consumers'), directory]) {
      await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe evidence cursor directory');
    }
  }
  async function readCursor(): Promise<string | undefined> {
    await cursorDirectory();
    let handle;
    try {
      handle = await open(cursorPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      if ((await handle.stat()).size > 4096) return undefined;
      const value = JSON.parse(await handle.readFile('utf8'));
      return value.schema_version === 1 && typeof value.after_batch_id === 'string' ? value.after_batch_id : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined;
      throw error;
    } finally { await handle?.close(); }
  }
  async function saveCursor(after: string | null): Promise<void> {
    const temporary = join(directory, `.cursor-${randomUUID()}.tmp`);
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify({ schema_version: 1, after_batch_id: after })); await handle.sync(); }
    finally { await handle.close(); }
    try { await rename(temporary, cursorPath); await syncDirectory(directory); }
    finally { await unlink(temporary).catch(() => {}); }
  }
  return { target: 'evidence', async consume() {
    try {
    // Cursor is a disposable optimization, never an acknowledgement. Wrap so
    // conflicted old batches remain retryable without blocking newer batches.
    let cursor = await readCursor();
    let batches = await store.listReadyBatches('evidence', limit + 1, cursor);
    if (!batches.length && cursor) { cursor = undefined; batches = await store.listReadyBatches('evidence', limit + 1); }
    const selected = batches.slice(0, limit), failures: string[] = [];
    for (const batch of selected) {
      const path = evidencePath(batch.batch_id), bytes = Buffer.from(canonical(batch) + '\n');
      const operation = `evidence:${batch.batch_id}`;
      try {
        await store.enqueueWork({ schema_version: 1, work_id: operation, kind: 'evidence', lane: 'history', state: 'pending',
          payload: { batch_id: batch.batch_id, path }, reason: 'Ready accepted batch awaits immutable Wiki mirror', migration_key: null,
          updated_at: (options.now?.() ?? new Date()).toISOString() });
        const output = await writer.write({ operation_id: operation, path, baseline_digest: 'absent', desired_bytes: bytes,
          fact_refs: batch.facts.map(({ fact_id, revision }) => ({ schema_version: 1, fact_id, revision })) });
        if (output.status === 'pending') throw new Error(output.reason ?? 'Evidence write is pending');
        // Applied intents are noops after a human edit. Verify actual output
        // before ack; never overwrite a changed immutable mirror to repair it.
        const current = await readWikiTarget(config.wiki_root, path);
        if (!current.bytes?.equals(bytes)) throw new Error(output.reason ?? 'Immutable Wiki evidence differs; preserve manual content');
        await store.completeWork(operation);
        await store.acknowledgeConsumer({ schema_version: 1, consumer: 'evidence', batch_id: batch.batch_id,
          acknowledged_at: (options.now?.() ?? new Date()).toISOString() });
      } catch (error) {
        const reason = (error as Error).message; failures.push(`${batch.batch_id}: ${reason}`);
        await store.enqueueWork({ schema_version: 1, work_id: `evidence:${batch.batch_id}`, kind: 'evidence', lane: 'history', state: 'pending',
          payload: { batch_id: batch.batch_id, path }, reason, migration_key: null, updated_at: (options.now?.() ?? new Date()).toISOString() });
      }
    }
    await saveCursor(selected.at(-1)?.batch_id ?? null);
    // A continuation can have skipped earlier failed batches. Check the head
    // with one row before claiming the entire consumer is caught up.
    const outstanding = batches.length > limit || (await store.listReadyBatches('evidence', 1)).length > 0;
    return { schema_version: 1, target: 'evidence', status: outstanding ? selected.length > failures.length ? 'partial' : 'pending' : 'complete',
      reason: outstanding ? failures.length ? failures.join('; ') : 'Bounded Wiki evidence mirror has further ready batches' : null };
    } catch (error) {
      return { schema_version: 1, target: 'evidence', status: 'pending', reason: (error as Error).message };
    }
  } };
}
