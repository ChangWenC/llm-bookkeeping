import test from 'node:test';
import assert from 'node:assert/strict';
import {dirname,join} from 'node:path';
import {rm,readFile} from 'node:fs/promises';
import {createStore,canonical} from '../../src/store/index.ts';
import {createReviewer} from '../../src/review/index.ts';
import {createPublisher,acquireWikiLock} from '../../src/publish/index.ts';
import {monthlyPath} from '../../src/consumers/archive/records.ts';
import {config,event,collection,bundle,result} from '../store/fixtures.ts';
import type {ReviewBundle,ReviewResult,WorkItem} from '../../src/contracts/types.ts';
const cutoff='2026-10-07T12:00:00.000Z',now=()=>new Date(cutoff),month='2026-09';
const work=(id:string):WorkItem=>({schema_version:1,work_id:id,kind:'prepare_monthly',lane:'history',state:'pending',payload:{month,body_sentinel:'SYNTHETIC-WORK-BODY-NOT-MATERIAL'},reason:'Synthetic frozen monthly work',migration_key:null,updated_at:'2026-10-01T00:00:00.000Z'});
function review(b:ReviewBundle,id:string,status:'complete'|'partial'='complete'):ReviewResult {
 const context=b.monthly_context!;
 return {schema_version:1,result_id:id,bundle_id:b.bundle_id,chunks:b.chunks.map(c=>({schema_version:1,chunk_id:c.chunk_id,status,reviewed_event_ids:[],zero_facts:status==='complete',reason:status==='complete'?null:'Synthetic incomplete work acknowledgement'})),candidates:[],pages:[],created_at:cutoff,monthly_review:{schema_version:1,month,summary:context.work_only?'Synthetic raw work acknowledgement; never a new summary.':'Synthetic frozen monthly conclusion.',fact_refs:context.facts.map(f=>({schema_version:1,fact_id:f.fact_id,revision:f.revision})),supplement_text:'',coverage_status:'partial',completed_work_ids:status==='complete'?context.prepared_work_ids:[],completed_archive_context_ids:[]}};
}
async function fixture(t:any,count:number,withFact:boolean) {
 const c=await config();t.after(()=>rm(dirname(c.wiki_root),{recursive:true,force:true}));const s=await createStore(c,{now});t.after(()=>s.close());
 if(withFact){const e=event('frozen-fact-source','Synthetic source body never used in work-only material.'),b=bundle([e],'source'),r=result(b,'source-result');r.pages=[];await s.saveCollection(collection([e]));await s.saveBundle(b);await s.commitReview(r);}
 const ids=Array.from({length:count},(_,i)=>'frozen-work:'+String(i).padStart(3,'0'));for(const id of ids)await s.enqueueWork(work(id));
 const reviewer=createReviewer(s,c),publisher=createPublisher(s,c,{now}),request={kind:'monthly' as const,lane:'history' as const,period:month,cutoff};const first=(await reviewer.prepare(request))[0];const page=first.monthly_context!.facts_page!;
 await s.enqueueWork(work('late-work'));
 return {c,s,ids,reviewer,publisher,request,first,page};
}
for(const [count,withFact] of [[40,true],[65,false]] as const)test(`${count} exact frozen monthly work closes in bounded pages without new facts or repeated summary`,async(t)=>{
 const {c,s,ids,reviewer,publisher,request,first,page}=await fixture(t,count,withFact);assert.equal(first.monthly_context!.prepared_work_ids!.length,32);
 assert.equal((await reviewer.prepare({...request,fact_snapshot:page.snapshot_id,fact_offset:page.offset}))[0].bundle_id,first.bundle_id,'unaccepted scoped first prepare stable despite late work');
 const snapshot=canonical(s.getFactMaterial(page.snapshot_id)),factRows=s.db.prepare('SELECT id,revision,json FROM facts ORDER BY id,revision').all();const firstInput=review(first,'initial'),firstReceipt=await publisher.publish(firstInput);assert.equal(firstReceipt.fact_commit,'committed');
 const initialArtifact=canonical((await s.getPublicationOutbox(firstReceipt.batch_id!))!.artifact),initialResult=canonical(await s.getReviewResult(firstInput.result_id)),reads=[...s.getFactMaterialReads(page.snapshot_id)];let packetCount=1;
 while((await s.factMaterialProgress(page.snapshot_id))!.pending_work_count>0 && packetCount<5){
  const req={...request,work_only:true,fact_snapshot:page.snapshot_id,fact_offset:page.total};
  const methods=['readEffectiveFacts','listCoverage','lookupFactRevisions','effectiveFactRefsAt'] as const,originals=methods.map(k=>s[k]);for(const k of methods)(s as any)[k]=()=>{throw new Error('Work-only preparation cannot read facts or coverage/source material');};
  const parse=JSON.parse;JSON.parse=(text:string,...args:any[])=>{assert(!text.includes('SYNTHETIC-WORK-BODY-NOT-MATERIAL'),'work payloads are not material');assert(!text.includes('Synthetic source body'),'source bodies are not work material');return (parse as any)(text,...args);};
  let b:ReviewBundle;try{b=(await reviewer.prepare(req))[0];assert.equal((await reviewer.prepare(req))[0].bundle_id,b.bundle_id,'unaccepted work packet stable');}finally{JSON.parse=parse;methods.forEach((k,i)=>(s as any)[k]=originals[i]);}
  const context=b.monthly_context!;assert.equal(context.work_only,true);assert.equal(context.facts.length,0);assert.equal(context.manual_baselines.length,0);assert.equal(context.archive_contexts?.length??0,0);assert.equal(context.facts_page!.snapshot_id,page.snapshot_id);assert.equal(b.cutoff,cutoff);assert(context.prepared_work_ids!.length>0&&context.prepared_work_ids!.length<=32);assert(context.prepared_work_ids!.every(id=>ids.includes(id)));assert(!context.prepared_work_ids!.includes('late-work'));
  const input=review(b,'work:'+packetCount++),accepted=await publisher.publish(input);assert.equal(accepted.fact_commit,'committed');assert.equal((await s.getPublicationOutbox(accepted.batch_id!))!.artifact.monthly_review!.summary,'Synthetic frozen monthly conclusion.');assert.equal((await s.getReviewResult(input.result_id))!.monthly_review!.summary,input.monthly_review!.summary,'raw work note remains accepted unchanged');
 }
 assert.equal(packetCount,Math.ceil(count/32));assert.equal((await s.factMaterialProgress(page.snapshot_id))!.pending_work_count,0);assert.deepEqual((await s.listWork('prepare_monthly','pending')).map(w=>w.work_id),['late-work']);assert.equal(canonical(s.getFactMaterial(page.snapshot_id)),snapshot);assert.deepEqual([...s.getFactMaterialReads(page.snapshot_id)],reads);assert.deepEqual(s.db.prepare('SELECT id,revision,json FROM facts ORDER BY id,revision').all(),factRows);assert.equal((s.db.prepare('SELECT COUNT(*) AS n FROM semantic_material_pages WHERE snapshot_id=?').get(page.snapshot_id) as any).n,1,'work packets do not create semantic pages');
 const text=await readFile(join(c.wiki_root,monthlyPath(month)),'utf8');assert.equal(text.split('Synthetic frozen monthly conclusion.').length-1,1);assert(!text.includes('Synthetic raw work acknowledgement'));await publisher.publish(firstInput);assert.equal(canonical(await s.getReviewResult(firstInput.result_id)),initialResult);assert.equal(canonical((await s.getPublicationOutbox(firstReceipt.batch_id!))!.artifact),initialArtifact);
});
test('partial and accepted-but-unpublished work pages preserve frozen debt and retry identity',async(t)=>{
 const {s,ids,reviewer,publisher,request,first,page,c}=await fixture(t,40,true);await publisher.publish(review(first,'initial'));const req={...request,work_only:true,fact_snapshot:page.snapshot_id,fact_offset:page.total};const b=(await reviewer.prepare(req))[0];
 const partial=review(b,'partial','partial');await publisher.publish(partial);assert.equal((await s.factMaterialProgress(page.snapshot_id))!.pending_work_count,8);const debt=(await s.monthlySemanticStatus(cutoff,cutoff)).months.find(item=>item.month===month)!;assert.deepEqual(debt.continuation,{schema_version:1,snapshot_id:page.snapshot_id,cutoff,offset:page.total,next_offset:null,total:page.total},'all refs read retains original frozen work continuation');const retry=(await reviewer.prepare(req))[0];assert.notEqual(retry.bundle_id,b.bundle_id);assert.equal((await reviewer.prepare(req))[0].bundle_id,retry.bundle_id);
 const input=review(retry,'complete-held'),lock=await acquireWikiLock(c.wiki_root);try{const receipt=await publisher.publish(input);assert.equal(receipt.fact_commit,'committed');assert.equal((await s.factMaterialProgress(page.snapshot_id))!.pending_work_count,8);assert.equal((await reviewer.prepare(req))[0].bundle_id,retry.bundle_id,'accepted unpublished work page retains identity');}finally{await lock!.release();}
 const raw=canonical(await s.getReviewResult(input.result_id));await publisher.publish(input);assert.equal((await s.factMaterialProgress(page.snapshot_id))!.pending_work_count,0);assert.equal(canonical(await s.getReviewResult(input.result_id)),raw);assert((await s.listWork('prepare_monthly','pending')).some(w=>w.work_id==='late-work'));assert.equal(ids.length,40);
});
test('metadata progress retains missing original work/archive IDs and rejects work-only without exact eligibility',async(t)=>{
 const {s,reviewer,request}=await fixture(t,1,false);const missing=s.freezeFactMaterial('monthly',month,cutoff,[],['missing-work'],['missing-archive']);
 const parse=JSON.parse;JSON.parse=()=>{throw new Error('progress cannot read body JSON');};try{const proof=await s.factMaterialProgress(missing);assert.equal(proof!.pending_work_count,1);assert.equal(proof!.pending_archive_context_count,1);}finally{JSON.parse=parse;}
 await assert.rejects(reviewer.prepare({...request,work_only:true,fact_snapshot:missing,fact_offset:0}),/requires all frozen refs read/);await assert.rejects(reviewer.prepare({...request,work_only:true,page_paths:['wiki/private.md'],fact_snapshot:missing,fact_offset:0}),/without page\/archive/);await assert.rejects(reviewer.prepare({...request,kind:'daily',work_only:true,fact_snapshot:missing,fact_offset:0}),/work_only requires monthly/);
});

test('first zero-ref frozen monthly work cannot become work-only before a complete accepted conclusion',async(t)=>{
 const {s,reviewer,request,page,first,publisher}=await fixture(t,65,false);
 assert.equal(await s.hasCompleteMonthlyConclusion(page.snapshot_id),false);
 const continuation=(await s.monthlySemanticStatus(cutoff,cutoff)).months.find(item=>item.month===month)!.continuation!;assert.equal(continuation.snapshot_id,page.snapshot_id);assert.equal(continuation.offset,0);assert.equal(continuation.next_offset,null);
 await assert.rejects(reviewer.prepare({...request,work_only:true,fact_snapshot:page.snapshot_id,fact_offset:0}),/accepted complete conclusion/);
 const regular=(await reviewer.prepare({...request,fact_snapshot:page.snapshot_id,fact_offset:0}))[0];assert.equal(regular.bundle_id,first.bundle_id);assert.equal(regular.monthly_context!.work_only,undefined);await publisher.publish(review(first,'first-complete'));assert.equal(await s.hasCompleteMonthlyConclusion(page.snapshot_id),true);
});

test('a newer complete snapshot prevents old work-only preparation and preprepared commit without changing accepted history',async(t)=>{
 const {s,reviewer,publisher,request,first,page,c}=await fixture(t,65,false);
 await publisher.publish(review(first,'old-initial'));
 const workRequest={...request,work_only:true,fact_snapshot:page.snapshot_id,fact_offset:page.total};
 const prepared=(await reviewer.prepare(workRequest))[0];
 const laterCutoff='2026-10-07T13:00:00.000Z';
 const fresh=(await reviewer.prepare({...request,cutoff:laterCutoff}))[0];
 assert.notEqual(fresh.monthly_context!.facts_page!.snapshot_id,page.snapshot_id);
 const input=review(fresh,'new-snapshot');input.monthly_review!.summary='Synthetic newer snapshot conclusion.';
 await publisher.publish(input);
 const bytes=await readFile(join(c.wiki_root,monthlyPath(month)),'utf8');
 const oldProgress=await s.factMaterialProgress(page.snapshot_id),results=s.db.prepare('SELECT id,json,commit_json FROM results ORDER BY id').all(),outbox=s.db.prepare('SELECT id,json FROM outbox ORDER BY id').all();
 await assert.rejects(reviewer.prepare(workRequest),/superseded/);
 await assert.rejects(s.commitReview(review(prepared,'stale-prepared')),/superseded/);
 assert.deepEqual(await s.factMaterialProgress(page.snapshot_id),oldProgress);
 assert.deepEqual(s.db.prepare('SELECT id,json,commit_json FROM results ORDER BY id').all(),results);
 assert.deepEqual(s.db.prepare('SELECT id,json FROM outbox ORDER BY id').all(),outbox);
 assert.equal(await readFile(join(c.wiki_root,monthlyPath(month)),'utf8'),bytes);
});
