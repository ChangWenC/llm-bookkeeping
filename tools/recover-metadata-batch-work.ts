import { constants } from 'node:fs';
import { open, mkdir, lstat, chmod, link, unlink } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { absolutePath, canonicalLocation, loadConfig, validateDataLocation } from '../src/config.ts';
import type { BookkeepingConfig } from '../src/contracts/types.ts';
import { createStore } from '../src/store/index.ts';
import type { MetadataBatchRecoveryPlan, RestoredMetadataOperation } from '../src/store/metadata-recovery.ts';

const MAX_PRIVATE_JSON_BYTES = 16 * 1024 * 1024;
async function privateLocation(path: string, config: BookkeepingConfig): Promise<void> {
  absolutePath(path, 'recovery material');
  validateDataLocation(await canonicalLocation(path), await canonicalLocation(config.wiki_root), await Promise.all(config.providers.flatMap(provider => provider.roots).map(canonicalLocation)));
}
async function readPrivateJson(path: string, config: BookkeepingConfig): Promise<any> {
  await privateLocation(path, config);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_PRIVATE_JSON_BYTES) throw new Error('Recovery JSON must be a regular file at most 16 MiB');
    const bytes = Buffer.alloc(MAX_PRIVATE_JSON_BYTES + 1); let used = 0;
    while (used < bytes.length) { const part = await handle.read(bytes, used, bytes.length - used, used); if (!part.bytesRead) break; used += part.bytesRead; }
    if (used > MAX_PRIVATE_JSON_BYTES) throw new Error('Recovery JSON exceeds 16 MiB');
    return JSON.parse(bytes.subarray(0, used).toString('utf8'));
  } finally { await handle.close(); }
}
async function savePrivatePlan(path: string, plan: MetadataBatchRecoveryPlan, config: BookkeepingConfig): Promise<void> {
  await privateLocation(path, config); const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const parent = await lstat(directory); if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Recovery output parent must be a real private directory');
  if ((parent.mode & 0o077) !== 0) throw new Error('Recovery output requires a private parent directory (0700); shared-directory permissions are preserved');
  const bytes = JSON.stringify(plan) + '\n'; if (Buffer.byteLength(bytes) > MAX_PRIVATE_JSON_BYTES) throw new Error('Recovery plan exceeds 16 MiB; no partial output saved');
  const temporary = join(directory, '.' + basename(path) + '.recovery-' + randomUUID());
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(bytes); await handle.sync(); await handle.close();
    try { await link(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await readPrivateJson(path, config);
      if (JSON.stringify(existing) !== JSON.stringify(plan)) throw new Error('Existing saved recovery plan differs; choose a new explicit output');
      await chmod(path, 0o600);
    }
    const parentHandle = await open(directory, 'r'); try { await parentHandle.sync(); } finally { await parentHandle.close(); }
  } finally { await handle.close(); await unlink(temporary).catch(() => {}); }
}
function counts(plan: MetadataBatchRecoveryPlan) {
  return { affected_months: plan.affected_months.length, derived_work: plan.work_ids.length, original_files: plan.original_intents.length, unchanged_files: plan.noop_intents.length };
}
function validatePlan(value: any, batchId: string): asserts value is MetadataBatchRecoveryPlan {
  if (!value || value.schema_version !== 1 || value.batch_id !== batchId || typeof value.plan_id !== 'string' || typeof value.before_sha256 !== 'string'
    || !Array.isArray(value.affected_months) || !Array.isArray(value.work_ids) || !Array.isArray(value.original_intents) || !Array.isArray(value.noop_intents)
    || value.proof?.facts_unchanged !== true || value.proof?.review_marks_unchanged !== true) throw new Error('Saved plan schema or batch does not match');
}
function validateReceipt(value: any, batchId: string): RestoredMetadataOperation[] {
  if (!value || value.schema_version !== 1 || value.mode !== 'apply' || value.batch_id !== batchId || !Array.isArray(value.restored_operations)
    || value.restored_operations.length > 100 || value.restored_operations.some((item: any) => !item || typeof item.original_operation_id !== 'string' || typeof item.restore_operation_id !== 'string')) throw new Error('File receipt schema or batch does not match');
  return value.restored_operations;
}
/** Coordinator-only wrapper: private saved proof goes through the Store owner's exact validation. */
export async function runMetadataBatchWorkRecovery(args: string[]) {
  const values: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!['--config', '--bad-batch', '--before-db', '--preview', '--apply', '--output', '--plan', '--file-receipt'].includes(key) || key in values) throw new Error('Unknown or duplicate work recovery option');
    if (['--preview', '--apply'].includes(key)) values[key] = true;
    else { const value = args[++index]; if (!value || value.startsWith('--')) throw new Error('Missing work recovery option value'); values[key] = value; }
  }
  if (!values['--config'] || !values['--bad-batch'] || !values['--before-db'] || !!values['--preview'] === !!values['--apply']) throw new Error('Supply --config ABS --bad-batch ID --before-db ABS and exactly one --preview|--apply');
  if (values['--preview'] ? !values['--output'] || values['--plan'] || values['--file-receipt'] : !values['--plan'] || !values['--file-receipt'] || values['--output']) throw new Error('Preview requires only --output ABS; apply requires only --plan ABS --file-receipt ABS');
  absolutePath(values['--before-db'] as string, 'before-db');
  const config = await loadConfig(values['--config'] as string), batchId = values['--bad-batch'] as string;
  const plan = values['--apply'] ? await readPrivateJson(values['--plan'] as string, config) : null;
  const receipt = values['--apply'] ? await readPrivateJson(values['--file-receipt'] as string, config) : null;
  if (values['--apply']) validatePlan(plan, batchId);
  const restored = values['--apply'] ? validateReceipt(receipt, batchId) : null;
  if (values['--preview']) await privateLocation(values['--output'] as string, config);
  const database = await lstat(join(config.data_dir, 'bookkeeping.sqlite'));
  if (!database.isFile() || database.isSymbolicLink()) throw new Error('Recovery requires an existing regular current database');
  const store = await createStore(config);
  try {
    if (values['--preview']) {
      const inspected = await store.planMetadataBatchRecovery(batchId, values['--before-db'] as string);
      await savePrivatePlan(values['--output'] as string, inspected, config);
      return { schema_version: 1, mode: 'preview', batch_id: batchId, plan_id: inspected.plan_id, before_sha256: inspected.before_sha256, counts: counts(inspected), plan_saved: true };
    }
    const at = new Date().toISOString();
    const applied = await store.applyMetadataBatchRecovery(plan!, values['--before-db'] as string, restored!, at);
    return { schema_version: 1, mode: 'apply', batch_id: batchId, plan_id: plan!.plan_id, audit_work_id: applied.audit_work_id, at, counts: { ...counts(plan!), closed_work: applied.closed_work_ids.length, restored_files: restored!.length } };
  } finally { store.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(JSON.stringify(await runMetadataBatchWorkRecovery(process.argv.slice(2))) + '\n'); }
  catch (error) { process.stderr.write((error instanceof Error ? error.message : 'Metadata work recovery failed') + '\n'); process.exitCode = 1; }
}
