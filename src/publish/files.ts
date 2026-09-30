import { constants } from 'node:fs';
import { lstat, realpath, mkdir, open, rename, unlink } from 'node:fs/promises';
import { relative, resolve, join, dirname, isAbsolute, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { BookkeepingConfig, Store, FileIntent, FileOutcome, FactRef } from '../contracts/types.ts';
import { acquireWikiLock, assertWikiLockHeld, type WikiLock } from './lock.ts';

export const digestBytes = (bytes: Uint8Array | null): string => bytes === null ? 'absent' : createHash('sha256').update(bytes).digest('hex');
export type FaultStage = 'before_intent' | 'after_intent' | 'before_target' | 'after_target' | 'after_file_registered' | 'after_export_rename';
export interface WriterOptions { now?: () => Date; fault?: (stage: FaultStage, operation: string) => void | Promise<void> }
export interface SafeWriteRequest { operation_id: string; path: string; baseline_digest: string; desired_bytes: Uint8Array | null; fact_refs?: FactRef[]; archive_delete_verified?: boolean }
export interface TargetSnapshot { path: string; absolute: string; bytes: Buffer | null; digest: string }
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** Reject lexical traversal AND every symlink below the canonical Wiki root. */
export async function resolveWikiPath(wikiRoot: string, input: string, createParents = false): Promise<{ path: string; absolute: string }> {
  if (!input || input.includes('\0') || input.includes('\\') || input.split('/').includes('..')) throw new Error('Unsafe Wiki path');
  const root = await realpath(wikiRoot);
  const absolute = isAbsolute(input) ? resolve(input) : resolve(root, input);
  const path = relative(root, absolute);
  if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error('Target is outside Wiki root');
  const parts = path.split(sep);
  if (parts.includes('raw')) throw new Error('raw source material is read-only');
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    let stat;
    try { stat = await lstat(current); }
    catch (error) {
      if (!isMissing(error)) throw error;
      if (createParents && i < parts.length - 1) {
        try { await mkdir(current); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
        stat = await lstat(current);
      } else continue;
    }
    if (stat.isSymbolicLink()) throw new Error('Symlink Wiki target or ancestor rejected');
    if (i < parts.length - 1 && !stat.isDirectory()) throw new Error('Wiki ancestor is not a directory');
    if (i === parts.length - 1 && !stat.isFile()) throw new Error('Wiki target is not a regular file');
  }
  return { path, absolute };
}
export async function readWikiTarget(wikiRoot: string, path: string): Promise<TargetSnapshot> {
  const target = await resolveWikiPath(wikiRoot, path);
  let bytes: Buffer | null = null;
  try {
    const handle = await open(target.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { bytes = await handle.readFile(); } finally { await handle.close(); }
  } catch (error) { if (!isMissing(error)) throw error; }
  return { ...target, bytes, digest: digestBytes(bytes) };
}
export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}
function outcome(intent: Pick<FileIntent, 'operation_id' | 'path'>, status: FileOutcome['status'], reason: string | null = null): FileOutcome {
  return { schema_version: 1, operation_id: intent.operation_id, path: intent.path, status, reason };
}
export class SafeWikiWriter {
  private store: Store;
  private config: BookkeepingConfig;
  private options: WriterOptions;
  constructor(store: Store, config: BookkeepingConfig, options: WriterOptions = {}) { this.store = store; this.config = config; this.options = options; }
  private async assertLock(lock: WikiLock): Promise<void> {
    if (lock.root !== await realpath(this.config.wiki_root)) throw new Error('Writer lock belongs to a different Wiki');
    await assertWikiLockHeld(lock);
  }
  async write(request: SafeWriteRequest): Promise<FileOutcome> {
    const lock = await acquireWikiLock(this.config.wiki_root);
    if (!lock) return outcome(request, 'pending', 'Wiki writer is active');
    try { return await this.writeLocked(request, lock); } finally { await lock.release(); }
  }
  async writeLocked(request: SafeWriteRequest, lock: WikiLock): Promise<FileOutcome> {
    await this.assertLock(lock);
    const existing = await this.store.getFileIntent(request.operation_id);
    if (existing) {
      const normalized = await resolveWikiPath(this.config.wiki_root, request.path);
      if (existing.path !== normalized.path || existing.desired_digest !== digestBytes(request.desired_bytes)) return outcome(existing, 'conflict', 'Operation ID reused with different target or bytes');
      return this.recoverLocked(existing, lock, request.archive_delete_verified);
    }
    const target = await readWikiTarget(this.config.wiki_root, request.path);
    const parts = target.path.split(sep);
    if (/^daily_\d{4}\.jsonl$/.test(parts.at(-1)!) || (target.bytes !== null && parts.includes('daily_journals') && parts.includes('_evidence'))) throw new Error('Existing journal archive is immutable');
    if (target.digest !== request.baseline_digest) return outcome(request, 'conflict', 'Target changed before intent; exact baseline required');
    const intent: FileIntent = { schema_version: 1, operation_id: request.operation_id, path: target.path,
      baseline_digest: target.digest, desired_digest: digestBytes(request.desired_bytes),
      desired_bytes_base64: request.desired_bytes === null ? null : Buffer.from(request.desired_bytes).toString('base64'),
      backup_bytes_base64: target.bytes?.toString('base64') ?? null, state: 'prepared',
      fact_refs: request.fact_refs ?? [], created_at: (this.options.now?.() ?? new Date()).toISOString(), reason: null };
    await this.options.fault?.('before_intent', intent.operation_id);
    await this.store.saveFileIntent(intent);
    await this.options.fault?.('after_intent', intent.operation_id);
    return this.recoverLocked(intent, lock, request.archive_delete_verified);
  }
  async recoverLocked(intent: FileIntent, lock: WikiLock, archiveDeleteVerified = false): Promise<FileOutcome> {
    await this.assertLock(lock);
    // Completed writes remain noops even when a person edited the file afterwards.
    if (intent.state === 'applied') {
      await this.queueIndex(intent);
      return outcome(intent, 'noop');
    }
    const desired = intent.desired_bytes_base64 === null ? null : Buffer.from(intent.desired_bytes_base64, 'base64');
    const backup = intent.backup_bytes_base64 === null ? null : Buffer.from(intent.backup_bytes_base64, 'base64');
    if (digestBytes(desired) !== intent.desired_digest || digestBytes(backup) !== intent.baseline_digest) throw new Error('Corrupt FileIntent bytes/digests');
    const target = await readWikiTarget(this.config.wiki_root, intent.path);
    if (target.digest === intent.desired_digest) {
      await this.register(intent);
      return outcome(intent, 'noop');
    }
    // A saved deletion is not evidence that its semantic prerequisites still
    // hold. Only ArchiveService, after checking them under this lock, may delete.
    // An already absent target above can still repair post-unlink registration.
    if (intent.operation_id.startsWith('archive-delete:') && desired === null && !archiveDeleteVerified)
      return outcome(intent, 'pending', 'Archive deletion requires dependency revalidation');
    if (target.digest !== intent.baseline_digest) {
      await this.store.updateFileIntent(intent.operation_id, 'conflict', 'Target is neither saved old nor desired content');
      return outcome(intent, 'conflict', 'Target is neither saved old nor desired content; draft and backup retained');
    }
    await this.options.fault?.('before_target', intent.operation_id);
    const destination = await resolveWikiPath(this.config.wiki_root, intent.path, true);
    let temp: string | null = null;
    try {
      if (desired !== null) {
        temp = join(dirname(destination.absolute), `.bookkeeping-${randomUUID()}.tmp`);
        const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await handle.writeFile(desired); await handle.sync(); } finally { await handle.close(); }
      }
      // Revalidate paths and bytes immediately before mutation, including changes
      // made during temp writing. An uncoordinated cross-device writer has no CAS guarantee.
      const latest = await readWikiTarget(this.config.wiki_root, intent.path);
      if (latest.digest !== intent.baseline_digest) {
        if (latest.digest === intent.desired_digest) { await this.register(intent); return outcome(intent, 'noop'); }
        await this.store.updateFileIntent(intent.operation_id, 'conflict', 'Manual change before atomic replacement');
        return outcome(intent, 'conflict', 'Manual change before atomic replacement');
      }
      if (desired === null) await unlink(destination.absolute);
      else { await rename(temp!, destination.absolute); temp = null; }
      await syncDirectory(dirname(destination.absolute));
      await this.options.fault?.('after_target', intent.operation_id);
      await this.register(intent);
      return outcome(intent, 'applied');
    } finally { if (temp) await unlink(temp).catch(() => {}); }
  }
  private async register(intent: FileIntent): Promise<void> {
    await this.store.updateFileIntent(intent.operation_id, 'applied');
    await this.options.fault?.('after_file_registered', intent.operation_id);
    await this.queueIndex(intent);
  }
  private async queueIndex(intent: FileIntent): Promise<void> {
    if (intent.baseline_digest === intent.desired_digest) return;
    await this.store.enqueueWork({ schema_version: 1, work_id: `index:${intent.operation_id}`, kind: 'index', lane: 'live', state: 'pending',
      payload: { path: intent.path, operation_id: intent.operation_id, digest: intent.desired_digest }, reason: null, migration_key: null,
      updated_at: (this.options.now?.() ?? new Date()).toISOString() });
  }
}
export const createSafeWikiWriter = (store: Store, config: BookkeepingConfig, options?: WriterOptions): SafeWikiWriter => new SafeWikiWriter(store, config, options);
