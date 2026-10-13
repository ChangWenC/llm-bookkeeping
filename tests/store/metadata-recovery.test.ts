import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createStore, digest, canonical } from '../../src/store/index.ts';
import { config, bundle, collection, event, result, value } from './fixtures.ts';
import type { FileIntent, WorkItem, FactRevision } from '../../src/contracts/types.ts';

const at='2026-10-02T14:00:00Z';
async function fixture(priorFacts: FactRevision[] = []) {
 const c=await config(),s=await createStore(c),b=bundle();await s.saveBundle(b);
 for(const fact of priorFacts)s.db.prepare('INSERT INTO facts VALUES(?,?,?,?)').run(fact.fact_id,fact.revision,canonical(fact),fact.recorded_at);
 const before=(await s.backup(join(c.wiki_root,'backups'))).path;
 const r={...result(b,'metadata-only',false),chunks:[],unit_dispositions:[],pages:[{schema_version:1 as const,suggestion_id:'meta',date:'2026-09-30',path:b.baselines[0].path,baseline_digest:'absent',mode:'append' as const,old_text:null,new_text:'Synthetic metadata',candidate_ids:[]}]};
 const accepted=await s.commitReview(r),batch=accepted.batch_id;
 // Synthetic reproduction of the accepted pre-fix artifact. Production artifacts remain immutable.
 const artifact=(await s.listOutbox())[0].artifact;artifact.affected_dates=['1990-01-01','1991-01-01'];artifact.affected_weeks=['1990-01-01'];artifact.affected_months=['1990-01','1991-01'];s.db.prepare('UPDATE outbox SET json=? WHERE id=?').run(canonical(artifact),batch);await s.markExportReady(batch,join(c.data_dir,'accepted.json'));
 const work=(id:string,kind:string,payload:Record<string,unknown>):WorkItem=>({schema_version:1,work_id:id,kind,lane:'history',state:'pending',payload,reason:null,migration_key:null,updated_at:at});
 for(const month of artifact.affected_months)await s.enqueueWork(work('display:'+batch+':'+month,'monthly_display',{month,batch_id:batch}));
 await s.enqueueWork(work('month:'+batch,'month',{period:'1991-01',batch_id:batch}));
 await s.enqueueWork(work('prepare-monthly:missing-monthly-page:1991-01','prepare_monthly',{kind:'monthly',month:'1991-01'}));
 await s.enqueueWork(work('other-pending','journal_suggestion',{batch_id:batch}));
 const baseline=Buffer.from('Synthetic original monthly page\n'),body='## 补记与更正\n\n当前没有待展示的有效补记。\n\n';
 const desired=Buffer.from(baseline.toString()+'\n'+`<!-- bookkeeping:monthly-supplement:start month=1990-01 digest=${digest(body)} -->\n${body}<!-- bookkeeping:monthly-supplement:end -->\n`);
 const original:FileIntent={schema_version:1,operation_id:'monthly-supplement:1990-01:synthetic',path:'wiki/personal/journals/reviews/回顾_1990_01.md',baseline_digest:digest(baseline),desired_digest:digest(desired),backup_bytes_base64:baseline.toString('base64'),desired_bytes_base64:desired.toString('base64'),state:'applied',fact_refs:[],created_at:at,reason:null};
 await s.saveFileIntent(original);await s.enqueueWork(work('index:'+original.operation_id,'index',{path:original.path,operation_id:original.operation_id,digest:original.desired_digest}));
 return {c,s,b,before,batch,original,accepted};
}
async function restore(f:Awaited<ReturnType<typeof fixture>>) {
 const replacement={...f.original,operation_id:'metadata-recovery:'+f.batch+':original',baseline_digest:f.original.desired_digest,desired_digest:f.original.baseline_digest,backup_bytes_base64:f.original.desired_bytes_base64,desired_bytes_base64:f.original.backup_bytes_base64};await f.s.saveFileIntent(replacement);
 return [{original_operation_id:f.original.operation_id,restore_operation_id:replacement.operation_id}];
}
test('metadata recovery plans are read-only, allow capture/prepare changes, and precisely cancel derived debt after saved exact restoration',async()=>{
 const f=await fixture();try {
 const originals={result:await f.s.getReviewResult('metadata-only'),outbox:await f.s.listOutbox(),patches:await f.s.listPendingPatches(),intent:await f.s.getFileIntent(f.original.operation_id)};
 await f.s.saveCollection(collection([event('later-capture')]));await f.s.saveBundle(bundle([event('later-capture')],'later-preparation'));
 const beforeWork=await f.s.listWork(),plan=await f.s.planMetadataBatchRecovery(f.batch,f.before);assert.deepEqual(await f.s.listWork(),beforeWork);assert.equal(plan.original_intents.length,1);assert.ok(plan.work_ids.includes('prepare-monthly:missing-monthly-page:1991-01'));assert.ok(!plan.work_ids.includes('other-pending'));
 await assert.rejects(f.s.applyMetadataBatchRecovery(plan,f.before,[],at),/restoration set/);assert.deepEqual(await f.s.listWork(),beforeWork);
 const receipt=await restore(f),applied=await f.s.applyMetadataBatchRecovery(plan,f.before,receipt,at);assert.equal(applied.closed_work_ids.length,plan.work_ids.length);assert.equal((await f.s.listWork()).find(item=>item.work_id==='other-pending')!.state,'pending');
 assert.deepEqual(await f.s.getReviewResult('metadata-only'),originals.result);assert.deepEqual(await f.s.listOutbox(),originals.outbox);assert.deepEqual(await f.s.listPendingPatches(),originals.patches);assert.deepEqual(await f.s.getFileIntent(f.original.operation_id),originals.intent);
 for(const consumer of ['analytics','monthly','monthly-display'])assert.deepEqual(await f.s.listReadyBatches(consumer),[]);assert.equal((await f.s.listReadyBatches('evidence')).length,1);assert.equal((await f.s.listWork('metadata_recovery_audit'))[0].payload.review_coverage_changed,false);
 await f.s.applyMetadataBatchRecovery(plan,f.before,receipt,at);assert.equal((await f.s.listWork('metadata_recovery_audit')).length,1);
 }finally{f.s.close();}
});
test('metadata recovery refuses changed facts, review marks, another accepted batch and ambiguous missing-month work',async()=>{
 for(const kind of ['fact','review','batch','missing']) {
  const f=await fixture();try {
   if(kind==='fact')f.s.db.prepare('INSERT INTO facts VALUES(?,?,?,?)').run('new-fact',1,'{}',at);
   if(kind==='review')f.s.db.prepare('INSERT INTO reviewed_units VALUES(?,?,?)').run('daily','history','later-event');
   if(kind==='batch'){const b=bundle([],'second');await f.s.saveBundle(b);await f.s.commitReview(result(b,'second',false));}
   if(kind==='missing')await f.s.enqueueWork({schema_version:1,work_id:'ambiguous-display',kind:'monthly_display',lane:'history',state:'pending',payload:{month:'1991-01',batch_id:'other'},reason:null,migration_key:null,updated_at:at});
   const before=await f.s.listWork();await assert.rejects(f.s.planMetadataBatchRecovery(f.batch,f.before),/changed|exactly one|unique batch cause/);assert.deepEqual(await f.s.listWork(),before);
  }finally{f.s.close();}
 }
});
test('metadata recovery rejects stale preview and restoration with different backup bytes before changing work or acknowledgements',async()=>{
 const f=await fixture();try {
 const plan=await f.s.planMetadataBatchRecovery(f.batch,f.before),receipt=await restore(f),row=await f.s.getFileIntent(receipt[0].restore_operation_id);await f.s.updateFileIntent(row!.operation_id,'pending','not yet restored');
 await assert.rejects(f.s.applyMetadataBatchRecovery(plan,f.before,receipt,at),/exact original backup/);assert.equal((await f.s.listReadyBatches('monthly-display')).length,1);
 await f.s.updateFileIntent(row!.operation_id,'applied');await f.s.enqueueWork({schema_version:1,work_id:'new-related-work',kind:'date',lane:'history',state:'pending',payload:{batch_id:f.batch,period:'1990-01-01'},reason:null,migration_key:null,updated_at:at});await assert.rejects(f.s.applyMetadataBatchRecovery(plan,f.before,receipt,at),/plan changed/);assert.equal((await f.s.listWork('metadata_recovery_audit')).length,0);
 }finally{f.s.close();}
});

test('applied monthly noop intents retain existing blocks and require no restoration pair',async()=>{
 const f=await fixture();try {
 const noOp={...f.original,operation_id:'monthly-supplement:1991-01:noop',path:'wiki/personal/journals/reviews/回顾_1991_01.md',baseline_digest:f.original.desired_digest,desired_digest:f.original.desired_digest,backup_bytes_base64:f.original.desired_bytes_base64};await f.s.saveFileIntent(noOp);
 const plan=await f.s.planMetadataBatchRecovery(f.batch,f.before);assert.equal(plan.original_intents.length,1);assert.deepEqual(plan.noop_intents,[noOp]);await f.s.applyMetadataBatchRecovery(plan,f.before,await restore(f),at);assert.deepEqual(await f.s.getFileIntent(noOp.operation_id),noOp);
 }finally{f.s.close();}
});

const priorFacts: FactRevision[]=['existing:one','existing:two'].map(fact_id=>({schema_version:1,fact_id,revision:1,event_refs:[],content:'Synthetic existing immutable fact',subject:'Roy',occurred_at:value('1991-01-01T12:00:00Z'),journal_date:value('1991-01-01'),kind:'fact',analytics_projection:{schema_version:1,value:null,reason:'Not projected'},action:'assert',target_refs:[],scope:[],attribution:{},recorded_at:'2026-01-01T00:00:00Z'}));
const priorRefs=priorFacts.map(fact=>({schema_version:1 as const,fact_id:fact.fact_id,revision:fact.revision}));
function referencedNoop(f:Awaited<ReturnType<typeof fixture>>,refs=priorRefs): FileIntent {return {...f.original,operation_id:'monthly-supplement:1991-01:referenced-noop',path:'wiki/personal/journals/reviews/回顾_1991_01.md',baseline_digest:f.original.desired_digest,desired_digest:f.original.desired_digest,backup_bytes_base64:f.original.desired_bytes_base64,fact_refs:refs};}
test('unchanged applied monthly noop may retain two exact preexisting immutable fact references without restoring bytes or changing facts',async()=>{
 const f=await fixture(priorFacts);try {
 const noop=referencedNoop(f);await f.s.saveFileIntent(noop);const factsBefore=f.s.db.prepare('SELECT * FROM facts ORDER BY id,revision').all();
 const plan=await f.s.planMetadataBatchRecovery(f.batch,f.before);assert.deepEqual(plan.noop_intents,[noop]);assert.equal(plan.original_intents.length,1);await f.s.applyMetadataBatchRecovery(plan,f.before,await restore(f),at);
 assert.deepEqual(await f.s.getFileIntent(noop.operation_id),noop);assert.deepEqual(f.s.db.prepare('SELECT * FROM facts ORDER BY id,revision').all(),factsBefore);
 }finally{f.s.close();}
});
test('monthly noop rejects unknown/new fact references and changed appends still reject all fact references',async()=>{
 for(const kind of ['unknown','revision','new','append']) {
  const f=await fixture(priorFacts);try {
   if(kind==='new'){const added={...priorFacts[0],fact_id:'new:after-backup'};f.s.db.prepare('INSERT INTO facts VALUES(?,?,?,?)').run(added.fact_id,added.revision,canonical(added),added.recorded_at);await f.s.saveFileIntent(referencedNoop(f,[{schema_version:1,fact_id:added.fact_id,revision:1}]));}
   else if(kind==='append'){const row={...f.original,fact_refs:priorRefs};f.s.db.prepare('UPDATE intents SET json=? WHERE id=?').run(canonical(row),row.operation_id);}
   else await f.s.saveFileIntent(referencedNoop(f,kind==='unknown'?[{schema_version:1,fact_id:'unknown',revision:1}]:[{schema_version:1,fact_id:priorFacts[0].fact_id,revision:2}]));
   const work=await f.s.listWork();await assert.rejects(f.s.planMetadataBatchRecovery(f.batch,f.before),/fact reference|facts changed/);assert.deepEqual(await f.s.listWork(),work);assert.equal((await f.s.listReadyBatches('monthly-display')).length,1);
  }finally{f.s.close();}
 }
});
