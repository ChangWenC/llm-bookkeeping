import { constants } from 'node:fs';
import { lstat, realpath, mkdir, open, rename, unlink } from 'node:fs/promises';
import { relative, resolve, join, dirname, isAbsolute, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { BookkeepingConfig, Store, FileIntent, FileOutcome, FactRef, JournalConfirmationGuard } from '../contracts/types.ts';
import { acquireWikiLock, assertWikiLockHeld, type WikiLock } from './lock.ts';
import { markStorageFailure } from '../storage-errors.ts';
import { isSemanticJournal, journalChangeKind, journalPrivacyChanged } from './journals.ts';

/** Attach write provenance at the filesystem mutation, never at a source read. */
export async function localWrite<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) { throw markStorageFailure(error, 'local_write'); }
}

export const digestBytes = (bytes: Uint8Array | null): string => bytes === null ? 'absent' : createHash('sha256').update(bytes).digest('hex');
export type FaultStage = 'before_intent' | 'after_intent' | 'before_target' | 'after_target' | 'after_file_registered' | 'after_export_rename';
export interface WriterOptions { now?: () => Date; remaining_ms?: () => number; fault?: (stage: FaultStage, operation: string) => void | Promise<void> }
export const hasOperationTime = (options: Pick<WriterOptions, 'remaining_ms'>): boolean => (options.remaining_ms?.() ?? Infinity) > 0;
export interface SafeWriteRequest { operation_id: string; path: string; baseline_digest: string; desired_bytes: Uint8Array | null; fact_refs?: FactRef[]; archive_delete_verified?: boolean; supersedes_operation_id?: string; requires_journal_confirmation?: boolean }
export interface TargetSnapshot { path: string; absolute: string; bytes: Buffer | null; digest: string }
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
// Internal ArchiveService handoff after its full lock-held dependency checks.
// JSON/caller flags cannot manufacture this lock-object-bound capability, and
// recovery never persists it: ArchiveService must prove dependencies again.
const archiveDeletionProofs = new WeakMap<WikiLock, Map<string, { path: string; digest: string }>>();
export function registerArchiveDeletionVerification(lock: WikiLock, operationId: string, path: string, digest: string): void {
  const proofs = archiveDeletionProofs.get(lock) ?? new Map();
  proofs.set(operationId, { path, digest }); archiveDeletionProofs.set(lock, proofs);
}

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
        try { await localWrite(() => mkdir(current)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
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
  await localWrite(async () => {
    const handle = await open(path, constants.O_RDONLY);
    try { await handle.sync(); } finally { await handle.close(); }
  });
}
function outcome(intent: Pick<FileIntent, 'operation_id' | 'path'>, status: FileOutcome['status'], reason: string | null = null): FileOutcome {
  return { schema_version: 1, operation_id: intent.operation_id, path: intent.path, status, reason };
}
/** Optional only for compatibility with older Store ports; concrete SQLite implements it. */
export async function operationSupersession(store: Store, operationId: string): Promise<string | null> {
  return (store as Store & { getOperationSupersession?(id: string): Promise<string | null> }).getOperationSupersession?.(operationId) ?? null;
}
export async function supersededOutcome(store: Store, operation: Pick<FileIntent, 'operation_id' | 'path'>): Promise<FileOutcome | null> {
  const replacement = await operationSupersession(store, operation.operation_id);
  return replacement ? outcome(operation, 'pending', `Operation retired or superseded by ${replacement}; original remains terminal`) : null;
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
  private guardOutcome(intent: FileIntent, guard: JournalConfirmationGuard): FileOutcome | null {
    if (guard.status === 'confirmed' || guard.status === 'not_required') return null;
    return { ...outcome(intent, 'pending', `${guard.status}: ${guard.reason ?? 'Exact journal change requires an explicit user decision'}${guard.proposal_id ? ` (${guard.proposal_id})` : ''}`), queued_work_ids: guard.work_ids };
  }
  /** Recovery can prove this maintenance origin and shape from saved work; no
   * caller-controlled flag or operation-name prefix alone grants exemption. */
  private async archiveLinkMaintenance(intent: FileIntent, backup: Buffer, desired: Buffer): Promise<boolean> {
    if (!intent.operation_id.startsWith('archive-link:')) return false;
    const { rewriteLinks } = await import('../consumers/archive/index.ts');
    for (const work of await this.store.listWork('archive_plan')) {
      const plan = work.payload;
      if (!Array.isArray(plan.links) || typeof plan.path !== 'string' || typeof plan.date !== 'string' || typeof plan.month !== 'string' || typeof plan.archive_path !== 'string' || typeof plan.archive_base64 !== 'string') continue;
      const link = plan.links.find(link => link && typeof link === 'object' && link.operation_id === intent.operation_id && link.path === intent.path && link.digest === intent.baseline_digest && link.desired_base64 === intent.desired_bytes_base64);
      if (!link) continue;
      const oldText = backup.toString('utf8');
      if (!Buffer.from(oldText).equals(backup) || !Buffer.from(rewriteLinks(oldText, plan.path, plan.date, plan.month)).equals(desired)) return false;
      const archive = await readWikiTarget(this.config.wiki_root, plan.archive_path);
      return archive.digest === digestBytes(Buffer.from(plan.archive_base64, 'base64'));
    }
    return false;
  }
  private async monthlyManagedMaintenance(intent: FileIntent, backup: Buffer, desired: Buffer): Promise<boolean> {
    const match = intent.path.match(/^wiki\/personal\/journals\/reviews\/回顾_(\d{4})_(0[1-9]|1[0-2])\.md$/);
    if (!match) return false;
    const month = `${match[1]}-${match[2]}`, oldText = backup.toString('utf8'), newText = desired.toString('utf8');
    if (!Buffer.from(oldText).equals(backup) || !Buffer.from(newText).equals(desired)) return false;
    const { isManagedMonthlyChange, updateManagedBlock, monthlyReviewBody } = await import('../consumers/monthly/blocks.ts');
    const sha = (text: string) => digestBytes(Buffer.from(text));
    if (intent.operation_id === `monthly-supplement:${month}:${sha(`${intent.baseline_digest}:${sha(newText)}:${JSON.stringify(intent.fact_refs)}`)}`)
      return isManagedMonthlyChange(oldText, newText, 'monthly-supplement', month);
    const suffix = `:${sha(intent.baseline_digest)}`;
    if (!intent.operation_id.startsWith('monthly-review:') || !intent.operation_id.endsWith(suffix) || !this.store.getPublicationOutbox) return false;
    const batchId = intent.operation_id.slice('monthly-review:'.length, -suffix.length), entry = await this.store.getPublicationOutbox(batchId);
    if (entry?.status !== 'ready' || entry.artifact.monthly_review?.month !== month || JSON.stringify(intent.fact_refs) !== JSON.stringify(entry.artifact.monthly_review.fact_refs) || !isManagedMonthlyChange(oldText, newText, 'monthly-review', month)) return false;
    return updateManagedBlock(oldText, 'monthly-review', month, monthlyReviewBody(entry.artifact.monthly_review)) === newText;
  }
  private async metadataRecoveryMaintenance(intent: FileIntent, backup: Buffer, desired: Buffer): Promise<boolean> {
    if (!/^metadata-recovery:[a-f0-9]{64}$/.test(intent.operation_id) || intent.fact_refs.length || !this.store.getPublicationOutbox) return false;
    const work = (await this.store.listWork('metadata_batch_file_recovery')).find(work => work.payload.restore_operation_id === intent.operation_id);
    if (!work || work.schema_version !== 1 || work.work_id !== `metadata-batch-file-recovery:${intent.operation_id}` || work.kind !== 'metadata_batch_file_recovery' || work.lane !== 'history' || !['pending', 'complete'].includes(work.state) || work.migration_key !== null) return false;
    const audit = work.payload;
    if (typeof audit.original_operation_id !== 'string' || typeof audit.batch_id !== 'string' || typeof audit.plan_sha !== 'string' || !/^[a-f0-9]{64}$/.test(audit.plan_sha) || typeof audit.before_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(audit.before_sha256) || typeof audit.month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(audit.month)) return false;
    const original = await this.store.getFileIntent(audit.original_operation_id), entry = await this.store.getPublicationOutbox(audit.batch_id);
    if (!original || original.operation_id !== audit.original_operation_id || original.state !== 'applied' || original.fact_refs.length || original.path !== intent.path || original.backup_bytes_base64 === null || original.desired_bytes_base64 === null || original.baseline_digest !== intent.desired_digest || original.desired_digest !== intent.baseline_digest || original.backup_bytes_base64 !== intent.desired_bytes_base64 || original.desired_bytes_base64 !== intent.backup_bytes_base64) return false;
    if (!entry || entry.artifact.facts.length || entry.artifact.analysis || entry.artifact.monthly_review || !(entry.artifact.affected_months ?? entry.artifact.affected_dates.map(date => date.slice(0, 7))).includes(audit.month)) return false;
    if (intent.path !== `wiki/personal/journals/reviews/回顾_${audit.month.replace('-', '_')}.md` || !original.operation_id.startsWith(`monthly-supplement:${audit.month}:`)) return false;
    const sha = (text: string) => digestBytes(Buffer.from(text));
    if (intent.operation_id !== `metadata-recovery:${sha(JSON.stringify([audit.batch_id, audit.before_sha256, original.operation_id, original.baseline_digest, original.desired_digest]))}`) return false;
    const body = '## 补记与更正\n\n当前没有待展示的有效补记。\n\n';
    const suffix = `${desired.at(-1) === 10 ? '\n' : '\n\n'}<!-- bookkeeping:monthly-supplement:start month=${audit.month} digest=${sha(body)} -->\n${body}<!-- bookkeeping:monthly-supplement:end -->\n`;
    return !desired.includes(Buffer.from('<!-- bookkeeping:monthly-supplement:')) && backup.equals(Buffer.concat([desired, Buffer.from(suffix)]));
  }
  private async confirmJournal(intent: FileIntent, lock: WikiLock, requiresConfirmation = false): Promise<FileOutcome | null> {
    if (intent.backup_bytes_base64 === null || intent.desired_bytes_base64 === null) return null;
    const backup = Buffer.from(intent.backup_bytes_base64, 'base64'), desired = Buffer.from(intent.desired_bytes_base64, 'base64');
    if (!isSemanticJournal(intent.path, backup)) return null;
    const kind = journalChangeKind(backup, desired);
    if (kind === 'metadata' || !journalPrivacyChanged(backup, desired) && (await this.archiveLinkMaintenance(intent, backup, desired) || await this.monthlyManagedMaintenance(intent, backup, desired) || await this.metadataRecoveryMaintenance(intent, backup, desired))) return null;
    if (!this.store.ensureJournalConfirmation) {
      return outcome(intent, 'pending', 'awaiting_user_confirmation: Journal confirmation Store port unavailable');
    }
    const guard = await this.store.ensureJournalConfirmation({ schema_version: 1, intent, current_baseline_digest: intent.baseline_digest,
      old_text: backup.toString('utf8'), new_text: desired.toString('utf8'), requires_confirmation: requiresConfirmation || intent.journal_confirmation_required === true || kind === 'replace',
      reason: kind === 'replace' ? 'Existing journal body, summary or privacy would be changed' : 'Existing journal append requires explicit confirmation when its baseline or accepted facts conflict' }, lock);
    return this.guardOutcome(intent, guard);
  }
  private async validateJournal(intent: FileIntent, lock: WikiLock): Promise<FileOutcome | null> {
    const backup = intent.backup_bytes_base64 === null ? null : Buffer.from(intent.backup_bytes_base64, 'base64');
    const desired = intent.desired_bytes_base64 === null ? null : Buffer.from(intent.desired_bytes_base64, 'base64');
    if (!backup || !desired || !isSemanticJournal(intent.path, backup) || journalChangeKind(backup, desired) === 'metadata' || !journalPrivacyChanged(backup, desired) && (await this.archiveLinkMaintenance(intent, backup, desired) || await this.monthlyManagedMaintenance(intent, backup, desired) || await this.metadataRecoveryMaintenance(intent, backup, desired))) return null;
    if (!this.store.validateJournalConfirmation) return this.confirmJournal(intent, lock);
    return this.guardOutcome(intent, await this.store.validateJournalConfirmation(intent, lock));
  }
  async write(request: SafeWriteRequest): Promise<FileOutcome> {
    if (!hasOperationTime(this.options)) return this.deadlineOutcome(request);
    const terminal = await supersededOutcome(this.store, request);
    if (terminal) return terminal;
    const lock = await acquireWikiLock(this.config.wiki_root);
    if (!lock) return outcome(request, 'pending', 'Wiki writer is active');
    try { return await this.writeLocked(request, lock); } finally { await lock.release(); }
  }
  async writeLocked(request: SafeWriteRequest, lock: WikiLock): Promise<FileOutcome> {
    if (!hasOperationTime(this.options)) return this.deadlineOutcome(request);
    await this.assertLock(lock);
    const terminal = await supersededOutcome(this.store, request);
    if (terminal) return terminal;
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
      fact_refs: request.fact_refs ?? [], created_at: (this.options.now?.() ?? new Date()).toISOString(), reason: null,
      ...(request.requires_journal_confirmation ? { journal_confirmation_required: true } : {}),
      ...(request.supersedes_operation_id ? { supersedes_operation_id: request.supersedes_operation_id } : {}) };
    await this.options.fault?.('before_intent', intent.operation_id);
    const superseded = await supersededOutcome(this.store, intent);
    if (superseded) return superseded;
    await this.store.saveFileIntent(intent);
    await this.options.fault?.('after_intent', intent.operation_id);
    const confirmation = await this.confirmJournal(intent, lock, request.requires_journal_confirmation);
    if (confirmation) return confirmation;
    return this.recoverLocked(intent, lock, request.archive_delete_verified);
  }
  async recoverLocked(intent: FileIntent, lock: WikiLock, archiveDeleteVerified = false): Promise<FileOutcome> {
    if (!hasOperationTime(this.options)) return outcome(intent, intent.state === 'applied' ? 'noop' : 'pending', intent.state === 'applied' ? null : 'Task deadline reached; saved file intent retained');
    await this.assertLock(lock);
    const terminal = await supersededOutcome(this.store, intent);
    if (terminal) return terminal;
    if ((intent.state as string) === 'superseded') return outcome(intent, 'pending', 'Superseded FileIntent remains terminal');
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
    if (desired === null && (intent.operation_id.startsWith('archive-delete:') || isSemanticJournal(intent.path, backup))) {
      const proof = archiveDeletionProofs.get(lock)?.get(intent.operation_id);
      if (!archiveDeleteVerified || !proof || proof.path !== intent.path || proof.digest !== intent.baseline_digest)
        return outcome(intent, 'pending', 'Journal deletion requires ArchiveService dependency revalidation under this exact writer lock');
    }
    if (target.digest !== intent.baseline_digest) {
      await this.store.updateFileIntent(intent.operation_id, 'conflict', 'Target is neither saved old nor desired content');
      return outcome(intent, 'conflict', 'Target is neither saved old nor desired content; draft and backup retained');
    }
    const confirmation = await this.confirmJournal(intent, lock);
    if (confirmation) return confirmation;
    await this.options.fault?.('before_target', intent.operation_id);
    if (!hasOperationTime(this.options)) return outcome(intent, 'pending', 'Task deadline reached before atomic target operation; intent retained');
    const destination = await resolveWikiPath(this.config.wiki_root, intent.path, true);
    let temp: string | null = null;
    try {
      if (desired !== null) {
        temp = join(dirname(destination.absolute), `.bookkeeping-${randomUUID()}.tmp`);
        await localWrite(async () => {
          const handle = await open(temp!, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try { await handle.writeFile(desired); await handle.sync(); } finally { await handle.close(); }
        });
      }
      // Revalidate paths and bytes immediately before mutation, including changes
      // made during temp writing. An uncoordinated cross-device writer has no CAS guarantee.
      const superseded = await supersededOutcome(this.store, intent);
      if (superseded) return superseded;
      const validated = await this.validateJournal(intent, lock);
      if (validated) return validated;
      // No awaited authorization or Store check remains after this baseline read.
      // The final read/rename interval still cannot provide cross-device CAS.
      const latest = await readWikiTarget(this.config.wiki_root, intent.path);
      if (latest.digest !== intent.baseline_digest) {
        if (latest.digest === intent.desired_digest) { await this.register(intent); return outcome(intent, 'noop'); }
        await this.store.updateFileIntent(intent.operation_id, 'conflict', 'Manual change before atomic replacement');
        return outcome(intent, 'conflict', 'Manual change before atomic replacement');
      }
      if (desired === null) await localWrite(() => unlink(destination.absolute));
      else { await localWrite(() => rename(temp!, destination.absolute)); temp = null; }
      await syncDirectory(dirname(destination.absolute));
      await this.options.fault?.('after_target', intent.operation_id);
      await this.register(intent);
      return outcome(intent, 'applied');
    } finally { if (temp) await unlink(temp).catch(() => {}); }
  }
  private async register(intent: FileIntent): Promise<void> {
    if (await operationSupersession(this.store, intent.operation_id)) throw new Error('Operation was superseded before file registration');
    await this.store.updateFileIntent(intent.operation_id, 'applied');
    await this.options.fault?.('after_file_registered', intent.operation_id);
    await this.queueIndex(intent);
  }
  private async queueIndex(intent: FileIntent): Promise<void> {
    if (!hasOperationTime(this.options)) return;
    if (intent.baseline_digest === intent.desired_digest) return;
    await this.store.enqueueWork({ schema_version: 1, work_id: `index:${intent.operation_id}`, kind: 'index', lane: 'live', state: 'pending',
      payload: { path: intent.path, operation_id: intent.operation_id, digest: intent.desired_digest }, reason: null, migration_key: null,
      updated_at: (this.options.now?.() ?? new Date()).toISOString() });
  }
  private async deadlineOutcome(request: Pick<FileIntent, 'operation_id' | 'path'>): Promise<FileOutcome> {
    const existing = await this.store.getFileIntent(request.operation_id);
    return outcome(request, existing?.state === 'applied' ? 'noop' : 'pending', existing?.state === 'applied' ? null : 'Task deadline reached before file operation');
  }
}
export const createSafeWikiWriter = (store: Store, config: BookkeepingConfig, options?: WriterOptions): SafeWikiWriter => new SafeWikiWriter(store, config, options);
