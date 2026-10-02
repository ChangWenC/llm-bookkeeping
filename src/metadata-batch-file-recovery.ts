import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { absolutePath } from './config.ts';
import type { BookkeepingConfig, FactArtifact, FileIntent, ReviewResult, WorkItem } from './contracts/types.ts';
import { createStore } from './store/index.ts';
import { SafeWikiWriter, digestBytes, readWikiTarget } from './publish/files.ts';
import type { WriterOptions } from './publish/files.ts';
import { acquireWikiLock } from './publish/lock.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
async function fileSha(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}
const parse = <T>(row: any): T => JSON.parse(row.json);
function ensure(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function intentShape(intent: FileIntent) { return { ...intent, state: null, reason: null }; }
function checkDatabase(db: DatabaseSync): void {
  ensure((db.prepare('PRAGMA integrity_check').get() as any)?.integrity_check === 'ok', 'Recovery database integrity check failed');
  ensure((db.prepare("SELECT value FROM metadata WHERE key='schema'").get() as any)?.value === '1', 'Unsupported recovery database schema');
}
function emptyAppend(intent: FileIntent, month: string): boolean {
  if (intent.backup_bytes_base64 === null || intent.desired_bytes_base64 === null || intent.fact_refs.length) return false;
  const backup = Buffer.from(intent.backup_bytes_base64, 'base64'), desired = Buffer.from(intent.desired_bytes_base64, 'base64');
  if (digestBytes(backup) !== intent.baseline_digest || digestBytes(desired) !== intent.desired_digest) return false;
  const body = '## 补记与更正\n\n当前没有待展示的有效补记。\n\n';
  const suffix = `${backup.at(-1) === 10 ? '\n' : '\n\n'}<!-- bookkeeping:monthly-supplement:start month=${month} digest=${sha(body)} -->\n${body}<!-- bookkeeping:monthly-supplement:end -->\n`;
  return !backup.includes(Buffer.from('<!-- bookkeeping:monthly-supplement:')) && desired.equals(Buffer.concat([backup, Buffer.from(suffix)]));
}
interface Selection { original_operation_id: string; operation_id: string; month: string; path: string; baseline_digest: string; desired_digest: string; original: FileIntent }
export interface MetadataFileRecoveryPlan {
  schema_version: 1; batch_id: string; before_sha256: string; plan_sha: string;
  selected: Selection[]; skipped: { operation_id: string; reason: string }[];
}
/** Coordinator-only proof; SQLite is read-only and only immutable intent identities are compared. */
export async function planMetadataFileRecovery(config: BookkeepingConfig, batchId: string, beforePath: string): Promise<MetadataFileRecoveryPlan> {
  absolutePath(beforePath, 'before-db'); ensure(batchId.length > 0, 'Explicit bad batch ID required');
  const currentPath = await realpath(join(config.data_dir, 'bookkeeping.sqlite')), before = await realpath(beforePath);
  ensure(currentPath !== before, 'Before snapshot must be a separate consistent database');
  const beforeSha = await fileSha(before);
  const oldDb = new DatabaseSync(before, { readOnly: true }), db = new DatabaseSync(currentPath, { readOnly: true });
  try {
    oldDb.exec('BEGIN'); db.exec('BEGIN'); checkDatabase(oldDb); checkDatabase(db);
    ensure(!oldDb.prepare('SELECT 1 FROM outbox WHERE id=?').get(batchId), 'Bad batch already exists in before snapshot');
    const artifactRow = db.prepare('SELECT json FROM outbox WHERE id=?').get(batchId) as any;
    ensure(artifactRow, 'Bad batch does not exist'); const artifact = parse<FactArtifact>(artifactRow);
    ensure(artifact.schema_version === 1 && artifact.batch_id === batchId, 'Bad batch identity is invalid');
    const accepted = db.prepare("SELECT json,commit_json FROM results WHERE json_extract(commit_json,'$.batch_id')=?").all(batchId) as any[];
    ensure(accepted.length === 1, 'Recovery requires one accepted result for the bad batch');
    const result = parse<ReviewResult>(accepted[0]);
    ensure(result.chunks.length === 0 && result.candidates.length === 0 && !result.analysis && !result.monthly_review && artifact.facts.length === 0 && !artifact.analysis && !artifact.monthly_review, 'Batch contains business review or facts; recovery prohibited');
    const commit = JSON.parse(accepted[0].commit_json);
    ensure(commit.result_id === result.result_id && commit.batch_id === batchId && Array.isArray(commit.facts) && !commit.facts.length, 'Batch commit identity or facts are invalid');
    // Reject later business changes: monthly supplements fold all facts, not just this batch.
    const oldFacts = oldDb.prepare('SELECT id,revision,json FROM facts ORDER BY id,revision').all();
    ensure(JSON.stringify(oldFacts) === JSON.stringify(db.prepare('SELECT id,revision,json FROM facts ORDER BY id,revision').all()), 'Facts changed since before snapshot; recovery requires separate review');
    const oldBatches = new Map((oldDb.prepare('SELECT id,json FROM outbox').all() as any[]).map(row => [row.id, row.json]));
    const currentBatches = db.prepare('SELECT id,json FROM outbox').all() as any[];
    ensure([...oldBatches.keys()].every(id => currentBatches.some(row => row.id === id)), 'Prior immutable batch missing');
    for (const row of currentBatches) {
      if (oldBatches.has(row.id)) ensure(oldBatches.get(row.id) === row.json, 'Prior immutable batch changed');
      else ensure(row.id === batchId, 'Another batch exists after before snapshot');
    }
    const priorResults = oldDb.prepare('SELECT id,content,commit_json FROM results').all() as any[];
    const priorResultIds = new Set(priorResults.map(row => row.id));
    ensure((db.prepare('SELECT id FROM results').all() as any[]).every(row => priorResultIds.has(row.id) || row.id === result.result_id), 'Another accepted result exists after before snapshot');
    for (const row of priorResults) {
      const current = db.prepare('SELECT content,commit_json FROM results WHERE id=?').get(row.id) as any;
      ensure(current?.content === row.content && current?.commit_json === row.commit_json, 'Prior accepted result changed or missing');
    }
    const oldIntents = new Map((oldDb.prepare('SELECT id,json FROM intents').all() as any[]).map(row => [row.id, parse<FileIntent>(row)]));
    const intents = (db.prepare('SELECT json FROM intents ORDER BY id').all() as any[]).map(row => parse<FileIntent>(row));
    for (const [id, previous] of oldIntents) {
      const current = intents.find(intent => intent.operation_id === id);
      ensure(current && JSON.stringify(intentShape(current)) === JSON.stringify(intentShape(previous)), 'Prior immutable intent changed or missing');
    }
    const months = new Set(artifact.affected_months ?? artifact.affected_dates.map(date => date.slice(0, 7)));
    const display = (db.prepare("SELECT json FROM work WHERE kind='monthly_display'").all() as any[]).map(row => parse<WorkItem>(row));
    const newIntents = intents.filter(intent => !oldIntents.has(intent.operation_id));
    const selected: Selection[] = [], skipped: MetadataFileRecoveryPlan['skipped'] = [];
    for (const intent of newIntents.filter(intent => intent.operation_id.startsWith('monthly-supplement:'))) {
      const match = intent.operation_id.match(/^monthly-supplement:(\d{4}-(?:0[1-9]|1[0-2])):[a-f0-9]{64}$/);
      const month = match?.[1];
      let reason: string | null = null;
      if (!month || !months.has(month) || !display.some(work => work.payload.batch_id === batchId && work.payload.month === month)) reason = 'No exact bad-batch affected-month display evidence';
      else if (intent.path !== `wiki/personal/journals/reviews/回顾_${month.replace('-', '_')}.md`) reason = 'Unexpected monthly target';
      else if (intent.state !== 'applied') reason = 'Original intent is not applied; cannot retire its recovery';
      else if (!Number.isFinite(Date.parse(intent.created_at)) || !Number.isFinite(Date.parse(artifact.created_at)) || Date.parse(intent.created_at) < Date.parse(artifact.created_at)) reason = 'Intent predates bad batch';
      else if (!emptyAppend(intent, month)) reason = 'Change is not solely an empty derived append';
      else if (newIntents.some(peer => peer.path === intent.path && peer.operation_id !== intent.operation_id && !peer.operation_id.startsWith('metadata-recovery:'))) reason = 'Competing new intent on this target';
      else if (display.some(work => work.payload.month === month && work.payload.batch_id !== batchId && typeof work.payload.batch_id === 'string' && !oldBatches.has(work.payload.batch_id))) reason = 'Competing post-snapshot display batch';
      if (reason) { skipped.push({ operation_id: intent.operation_id, reason }); continue; }
      const operationId = 'metadata-recovery:' + sha(JSON.stringify([batchId, beforeSha, intent.operation_id, intent.baseline_digest, intent.desired_digest]));
      selected.push({ original_operation_id: intent.operation_id, operation_id: operationId, month: month!, path: intent.path, baseline_digest: intent.baseline_digest, desired_digest: intent.desired_digest, original: intent });
    }
    ensure(selected.length <= 100, 'Recovery exceeds 100-file bound; use separate reviewed tooling');
    ensure(beforeSha === await fileSha(before), 'Before snapshot changed during proof');
    const identity = { batch_id: batchId, before_sha256: beforeSha, artifact_sha: sha(artifactRow.json), result_sha: sha(accepted[0].json), selected, skipped };
    return { schema_version: 1, batch_id: batchId, before_sha256: beforeSha, plan_sha: sha(JSON.stringify(identity)), selected, skipped };
  } finally { db.close(); oldDb.close(); }
}

/** Counts/digests only: never expose saved manual or generated file text in receipts. */
export async function previewMetadataFileRecovery(config: BookkeepingConfig, batchId: string, beforePath: string) {
  const plan = await planMetadataFileRecovery(config, batchId, beforePath);
  const files = await Promise.all(plan.selected.map(async item => ({ original_operation_id: item.original_operation_id, operation_id: item.operation_id, month: item.month,
    current_matches_generated: (await readWikiTarget(config.wiki_root, item.path)).digest === item.desired_digest })));
  return { schema_version: 1, mode: 'preview', batch_id: batchId, before_sha256: plan.before_sha256, plan_sha: plan.plan_sha, files, skipped: plan.skipped };
}
export async function applyMetadataFileRecovery(config: BookkeepingConfig, batchId: string, beforePath: string, expectedPlanSha: string, options: WriterOptions = {}) {
  const plan = await planMetadataFileRecovery(config, batchId, beforePath);
  ensure(expectedPlanSha === plan.plan_sha, 'Recovery proof changed or expected plan SHA missing');
  const store = await createStore(config), outcomes: { original_operation_id: string; operation_id: string; status: string; reason: string | null }[] = [];
  try {
    const lock = await acquireWikiLock(config.wiki_root);
    if (!lock) return { schema_version: 1, mode: 'apply', batch_id: batchId, plan_sha: plan.plan_sha, outcomes: [], pending: plan.selected.length, reason: 'Wiki writer is active' };
    try {
      const writer = new SafeWikiWriter(store, config, options);
      for (const item of plan.selected) {
        try {
          const original = await store.getFileIntent(item.original_operation_id);
          ensure(original?.state === 'applied' && JSON.stringify(intentShape(original)) === JSON.stringify(intentShape(item.original)), 'Original applied intent changed');
          const existing = await store.getFileIntent(item.operation_id);
          ensure(!existing || (existing.path === item.path && existing.baseline_digest === item.desired_digest && existing.desired_digest === item.baseline_digest && existing.desired_bytes_base64 === item.original.backup_bytes_base64 && existing.backup_bytes_base64 === item.original.desired_bytes_base64), 'Existing restoration intent does not match proof');
          if (!existing && (await readWikiTarget(config.wiki_root, item.path)).digest !== item.desired_digest) {
            outcomes.push({ original_operation_id: item.original_operation_id, operation_id: item.operation_id, status: 'conflict', reason: 'Current bytes differ from generated bytes; manual edits preserved' }); continue;
          }
          const auditId = 'metadata-batch-file-recovery:' + item.operation_id;
          await store.enqueueWork({ schema_version: 1, work_id: auditId, kind: 'metadata_batch_file_recovery', lane: 'history', state: 'pending', migration_key: null,
            payload: { batch_id: batchId, original_operation_id: item.original_operation_id, restore_operation_id: item.operation_id, before_sha256: plan.before_sha256, plan_sha: plan.plan_sha, month: item.month }, reason: 'Restore proven empty derived append through new writer operation', updated_at: (options.now?.() ?? new Date()).toISOString() });
          const outcome = await writer.writeLocked({ operation_id: item.operation_id, path: item.path, baseline_digest: item.desired_digest, desired_bytes: Buffer.from(item.original.backup_bytes_base64!, 'base64') }, lock);
          const verified = ['applied', 'noop'].includes(outcome.status) && (await readWikiTarget(config.wiki_root, item.path)).digest === item.baseline_digest;
          if (verified) await store.completeWork(auditId);
          outcomes.push({ original_operation_id: item.original_operation_id, operation_id: item.operation_id, status: verified ? outcome.status : outcome.status === 'noop' ? 'conflict' : outcome.status, reason: verified ? null : outcome.reason ?? 'Restored bytes are no longer current; audit remains pending' });
        } catch (error) { outcomes.push({ original_operation_id: item.original_operation_id, operation_id: item.operation_id, status: 'pending', reason: error instanceof Error ? error.message : String(error) }); }
      }
    } finally { await lock.release(); }
    return { schema_version: 1, mode: 'apply', batch_id: batchId, plan_sha: plan.plan_sha, outcomes, skipped: plan.skipped, restored_operations: outcomes.filter(item => ['applied', 'noop'].includes(item.status)).map(item => ({ original_operation_id: item.original_operation_id, restore_operation_id: item.operation_id })) };
  } finally { store.close(); }
}
