import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { FactArtifact, FileIntent, ReviewCommit, ReviewResult, WorkItem } from '../contracts/types.ts';
import { canonical, digest } from '../analytics/serialization.ts';
import { fileSha256, fileSha256Sync } from './file-hash.ts';
import { utc } from './domain.ts';

export interface MetadataBatchRecoveryPlan {
 schema_version: 1;
 batch_id: string;
 before_sha256: string;
 plan_id: string;
 affected_months: string[];
 work_ids: string[];
 original_intents: FileIntent[];
 noop_intents: FileIntent[];
 proof: { result_id: string; facts_unchanged: true; review_marks_unchanged: true };
}
export interface RestoredMetadataOperation { original_operation_id: string; restore_operation_id: string }
interface RecoveryStore {
 db: DatabaseSync;
 path: string;
 transaction<T>(operation: () => T): T;
 putWork(item: WorkItem): void;
}
const rows = (db: DatabaseSync, table: string) => db.prepare(`SELECT * FROM ${table}`).all().map(row => canonical(row)).sort();
const objects = <T>(db: DatabaseSync, table: string): T[] => db.prepare(`SELECT json FROM ${table} ORDER BY rowid`).all().map(row => JSON.parse(String(row.json)));
const assert: (condition: unknown, reason: string) => asserts condition = (condition, reason) => { if (!condition) throw new Error('Metadata batch recovery: ' + reason); };
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function inspect(store: RecoveryStore, before: DatabaseSync, batchId: string, sha: string): MetadataBatchRecoveryPlan {
 assert(before.prepare('PRAGMA integrity_check').get()?.integrity_check === 'ok', 'before snapshot integrity failed');
 assert(before.prepare("SELECT value FROM metadata WHERE key='schema'").get()?.value === '1', 'unsupported before snapshot schema');
 for (const table of ['facts','reviewed_units','reviewed_spans','reviewed_sources'])
  assert(same(rows(store.db,table),rows(before,table)), table + ' changed since before snapshot');
 const oldResults=before.prepare('SELECT * FROM results ORDER BY id').all();
 for (const old of oldResults) assert(same(store.db.prepare('SELECT * FROM results WHERE id=?').get(old.id!),old),'prior accepted result changed');
 const newResults=store.db.prepare('SELECT * FROM results ORDER BY id').all().filter(row=>!oldResults.some(old=>old.id===row.id));
 assert(newResults.length===1,'expected exactly one new accepted result');
 const accepted=JSON.parse(String(newResults[0].json)) as ReviewResult, commit=JSON.parse(String(newResults[0].commit_json)) as ReviewCommit;
 assert(accepted.schema_version===1 && commit.schema_version===1 && commit.result_id===accepted.result_id && commit.batch_id===batchId && accepted.chunks.length===0 && accepted.candidates.length===0 && commit.facts.length===0,'batch is not page-only zero-business review');
 assert(accepted.analysis===undefined && accepted.monthly_review===undefined,'semantic summary present');
 assert(commit.patches.every(patch=>patch.fact_refs.length===0) && accepted.pages.every(page=>page.candidate_ids.length===0),'business page references present');
 const oldOutbox=before.prepare('SELECT id,json FROM outbox ORDER BY id').all();
 for(const old of oldOutbox)assert(same(store.db.prepare('SELECT id,json FROM outbox WHERE id=?').get(old.id!),old),'prior immutable artifact changed');
 const added=store.db.prepare('SELECT id,json,status FROM outbox ORDER BY id').all().filter(row=>!oldOutbox.some(old=>old.id===row.id));
 assert(added.length===1 && added[0].id===batchId && added[0].status==='ready','expected exactly one new ready artifact');
 const artifact=JSON.parse(String(added[0].json)) as FactArtifact;
 assert(artifact.schema_version===1 && artifact.batch_id===batchId && artifact.facts.length===0 && artifact.analysis===undefined && artifact.monthly_review===undefined,'artifact contains business facts or semantic summary');
 const months=[...new Set(artifact.affected_months ?? artifact.affected_dates.map(day=>day.slice(0,7)))].sort();
 assert(months.every(month=>/^\d{4}-\d{2}$/.test(month)),'invalid affected month');
 const oldWork=new Map(objects<WorkItem>(before,'work').map(item=>[item.work_id,item]));
 const work=objects<WorkItem>(store.db,'work');
 const derivedKinds=new Set(['date','week','month','monthly_display','prepare_monthly']);
 const selected=work.filter(item=>!oldWork.has(item.work_id) && item.payload.batch_id===batchId && (derivedKinds.has(item.kind) || (item.kind==='consumer' && ['analytics','monthly'].includes(String(item.payload.consumer)))));
 for(const item of work.filter(item=>!oldWork.has(item.work_id) && item.kind==='prepare_monthly' && !item.payload.batch_id)) {
  const month=String(item.payload.month);
  if(!months.includes(month) || item.work_id!=='prepare-monthly:missing-monthly-page:'+month)continue;
  assert(item.updated_at>=artifact.created_at,'missing-month work predates batch');
  const cause=selected.some(cause=>cause.kind==='monthly_display' && cause.payload.month===month);
  const competing=work.some(other=>other.kind==='monthly_display' && other.payload.month===month && other.payload.batch_id!==batchId && (other.state!=='complete' || !oldWork.has(other.work_id)));
  assert(cause && !competing,'missing-month work has no unique batch cause: '+month);
  selected.push(item);
 }
 const oldIntents=new Map(objects<FileIntent>(before,'intents').map(intent=>[intent.operation_id,intent]));
 const intents=objects<FileIntent>(store.db,'intents');
 const identity=(intent: FileIntent)=>({...intent,state:null,reason:null});
 for(const [id,old]of oldIntents)assert(intents.some(current=>current.operation_id===id && same(identity(current),identity(old))),'prior immutable file intent changed');
 const originals=intents.filter(intent=>!oldIntents.has(intent.operation_id) && intent.operation_id.startsWith('monthly-supplement:') && months.some(month=>intent.operation_id.startsWith('monthly-supplement:'+month+':')));
 for(const intent of originals) {
  const month=intent.operation_id.split(':')[1];
  assert(intent.state==='applied' && intent.backup_bytes_base64!==null && intent.desired_bytes_base64!==null,'monthly intent is not an applied modification with saved bytes');
  const noop=intent.baseline_digest===intent.desired_digest && intent.backup_bytes_base64===intent.desired_bytes_base64;
  if(noop) {
   for(const ref of intent.fact_refs) {
    assert(ref.schema_version===1 && typeof ref.fact_id==='string' && ref.fact_id.length>0 && Number.isSafeInteger(ref.revision) && ref.revision>0,'invalid noop fact reference');
    const prior=before.prepare('SELECT * FROM facts WHERE id=? AND revision=?').get(ref.fact_id,ref.revision);
    const current=store.db.prepare('SELECT * FROM facts WHERE id=? AND revision=?').get(ref.fact_id,ref.revision);
    assert(prior && current && same(prior,current),'noop fact reference not present unchanged in before snapshot');
    const fact=JSON.parse(String(prior.json));
    assert(fact.schema_version===1 && fact.fact_id===ref.fact_id && fact.revision===ref.revision,'noop fact reference identity differs from saved revision');
   }
  } else assert(intent.fact_refs.length===0,'changed monthly append contains fact references');
  assert(intent.created_at>=artifact.created_at,'monthly intent predates batch');
  const baselineBytes=Buffer.from(intent.backup_bytes_base64!,'base64'),baseline=baselineBytes.toString('utf8');
  const body='## 补记与更正\n\n当前没有待展示的有效补记。\n\n';
  const block=`<!-- bookkeeping:monthly-supplement:start month=${month} digest=${digest(body)} -->\n${body}<!-- bookkeeping:monthly-supplement:end -->`;
  const expected=Buffer.from(`${baseline}${baseline.endsWith('\n') ? '\n' : '\n\n'}${block}\n`);
  assert(baselineBytes.equals(Buffer.from(baseline)) && (expected.equals(Buffer.from(intent.desired_bytes_base64!,'base64')) || noop),'monthly intent is not exactly an empty derived append or unchanged noop');
  assert(intent.path===`wiki/personal/journals/reviews/回顾_${month.replace('-','_')}.md`,'unexpected monthly target path');
  assert(selected.some(item=>item.kind==='monthly_display' && item.payload.month===month),'monthly intent has no exact batch display work');
  assert(intents.filter(other=>!oldIntents.has(other.operation_id) && other.path===intent.path && !other.operation_id.startsWith('metadata-recovery:')).length===1,'competing new intent for monthly path');
  assert(digest(Buffer.from(intent.backup_bytes_base64!,'base64'))===intent.baseline_digest && digest(Buffer.from(intent.desired_bytes_base64!,'base64'))===intent.desired_digest,'intent backup bytes do not match digests');
  const index=work.find(item=>item.work_id==='index:'+intent.operation_id);
  if(index && !oldWork.has(index.work_id))selected.push(index);
 }
 const base={schema_version:1 as const,batch_id:batchId,before_sha256:sha,affected_months:months,work_ids:[...new Set(selected.map(item=>item.work_id))].sort(),original_intents:originals.filter(intent=>intent.baseline_digest!==intent.desired_digest),noop_intents:originals.filter(intent=>intent.baseline_digest===intent.desired_digest),proof:{result_id:accepted.result_id,facts_unchanged:true as const,review_marks_unchanged:true as const}};
 return {...base,plan_id:'metadata-recovery:'+digest(canonical(base))};
}
async function withBefore<T>(store: RecoveryStore, beforePath: string, operation: (before: DatabaseSync, sha: string)=>T): Promise<T> {
 assert(isAbsolute(beforePath) && resolve(beforePath)!==resolve(store.path),'before snapshot must be a separate absolute path');
 assert(!existsSync(beforePath+'-wal') || statSync(beforePath+'-wal').size===0,'before snapshot has an active WAL');
 const sha=await fileSha256(beforePath),before=new DatabaseSync(beforePath,{readOnly:true});
 try { before.exec('BEGIN');const result=operation(before,sha);before.exec('ROLLBACK');assert(await fileSha256(beforePath)===sha,'before snapshot changed during inspection');return result; }
 finally { before.close(); }
}
export async function planMetadataBatchRecovery(store: RecoveryStore, batchId: string, beforePath: string): Promise<MetadataBatchRecoveryPlan> {
 return withBefore(store,beforePath,(before,sha)=>store.transaction(()=>inspect(store,before,batchId,sha)));
}
export async function applyMetadataBatchRecovery(store: RecoveryStore, plan: MetadataBatchRecoveryPlan, beforePath: string, restored: RestoredMetadataOperation[], at: string): Promise<{schema_version:1; audit_work_id:string; closed_work_ids:string[]}> {
 utc(at);
 return withBefore(store,beforePath,(before,sha)=>store.transaction(()=>{
  const current=inspect(store,before,plan.batch_id,sha);
  assert(same(current,plan),'recovery plan changed; inspect again');
  assert(restored.length===plan.original_intents.length && new Set(restored.map(item=>item.original_operation_id)).size===restored.length,'restoration set must exactly match planned original intents');
  for(const original of plan.original_intents) {
   const receipt=restored.find(item=>item.original_operation_id===original.operation_id)!;
   const row=store.db.prepare('SELECT json FROM intents WHERE id=?').get(receipt.restore_operation_id);
   assert(row,'missing saved restoration intent');const replacement=JSON.parse(String(row.json)) as FileIntent;
   assert(replacement.operation_id.startsWith('metadata-recovery:') && replacement.state==='applied' && replacement.path===original.path && replacement.baseline_digest===original.desired_digest && replacement.desired_digest===original.baseline_digest && replacement.desired_bytes_base64===original.backup_bytes_base64 && replacement.backup_bytes_base64===original.desired_bytes_base64 && replacement.fact_refs.length===0,'restoration does not prove exact original backup bytes');
  }
  assert(fileSha256Sync(beforePath)===sha,'before snapshot changed before cancellation');
  const auditId=plan.plan_id+':audit';
  store.putWork({schema_version:1,work_id:auditId,kind:'metadata_recovery_audit',lane:'history',state:'complete',payload:{batch_id:plan.batch_id,before_sha256:sha,plan_id:plan.plan_id,closed_work_ids:plan.work_ids,restored_operations:restored,consumer_scopes:['analytics','monthly','monthly-display'],business_facts_changed:false,review_coverage_changed:false},reason:'Canceled spurious derived scheduling from a proven page-only metadata batch; original accepted artifacts and file intents retained',migration_key:null,updated_at:at});
  for(const id of plan.work_ids) {
   const row=store.db.prepare('SELECT json FROM work WHERE id=?').get(id)!;const item=JSON.parse(String(row.json)) as WorkItem;
   store.db.prepare("UPDATE work SET state='complete',json=? WHERE id=?").run(canonical({...item,state:'complete',reason:'Canceled spurious metadata-only period work; audit '+auditId,updated_at:at}),id);
  }
  for(const consumer of ['analytics','monthly','monthly-display'])store.db.prepare('INSERT OR IGNORE INTO acks VALUES(?,?,?)').run(consumer,plan.batch_id,canonical({schema_version:1,consumer,batch_id:plan.batch_id,acknowledged_at:at}));
  return {schema_version:1,audit_work_id:auditId,closed_work_ids:plan.work_ids};
 }));
}
