import test from 'node:test';
import assert from 'node:assert/strict';
import {dirname} from 'node:path';
import {rm} from 'node:fs/promises';
import {createStore,canonical,digest} from '../../src/store/index.ts';
import {createReviewer} from '../../src/review/index.ts';
import {config,event,collection,bundle,result} from './fixtures.ts';
import type {ReviewBundle,ReviewResult} from '../../src/contracts/types.ts';

async function material(t:any) {
 const c=await config();t.after(()=>rm(dirname(c.wiki_root),{recursive:true,force:true}));
 const s=await createStore(c);t.after(()=>s.close());const e=event('synthetic-month-source'),b=bundle([e],'month-source'),r=result(b,'month-source-result');r.pages=[];
 await s.saveCollection(collection([e]));await s.saveBundle(b);await s.commitReview(r);
 await s.enqueueWork({schema_version:1,work_id:'frozen-month-work',kind:'prepare_monthly',lane:'history',state:'pending',payload:{month:'2026-09'},reason:'Synthetic pending monthly semantic work',migration_key:null,updated_at:'2026-10-01T00:00:00Z'});
 const reviewer=createReviewer(s,c),request={kind:'monthly' as const,lane:'history' as const,period:'2026-09',cutoff:'2026-10-07T12:00:00Z'};
 const prepared=(await reviewer.prepare(request))[0];assert.equal(prepared.chunks.length,1,'normal factory produces a single semantic chunk');
 return {s,c,reviewer,request,prepared};
}
function monthly(b:ReviewBundle,id:string,statuses:('complete'|'partial'|'deferred')[],summary='Synthetic complete monthly conclusion'):ReviewResult {
 return {schema_version:1,result_id:id,bundle_id:b.bundle_id,chunks:statuses.map((status,i)=>({schema_version:1,chunk_id:b.chunks[i].chunk_id,status,reviewed_event_ids:[],zero_facts:status==='complete',reason:status==='complete'?null:'Synthetic deferred material'})),candidates:[],pages:[],created_at:'2026-10-07T12:00:00Z',monthly_review:{schema_version:1,month:'2026-09',summary,fact_refs:b.monthly_context!.facts.map(({fact_id,revision})=>({schema_version:1,fact_id,revision})),supplement_text:'',coverage_status:b.monthly_context!.coverage_status,completed_work_ids:[],completed_archive_context_ids:[]}};
}
for(const secondary of ['partial','omitted'] as const) test(`public saved multi-chunk monthly ${secondary} cannot mark aggregate refs or close frozen work`,async(t)=>{
 const {s,prepared}=await material(t),b=structuredClone(prepared);b.bundle_id='synthetic-multi-'+secondary;b.chunks.push({...structuredClone(b.chunks[0]),chunk_id:'synthetic-second-'+secondary});await s.saveBundle(b);
 const r=monthly(b,'mixed-'+secondary,secondary==='partial'?['complete','partial']:['complete']);const commit=await s.commitReview(r);
 assert.equal(s.getFactMaterialReads(b.monthly_context!.facts_page!.snapshot_id).size,0);
 assert.equal((await s.commitReview(r)).reused,true,'accepted partial retry remains immutable/idempotent');
 assert.equal((await s.getPublicationOutbox(commit.batch_id))!.artifact.monthly_review!.summary,r.monthly_review!.summary);
 const invalid=structuredClone(b);invalid.bundle_id='invalid-closure-'+secondary;await s.saveBundle(invalid);const bad={...r,bundle_id:invalid.bundle_id,result_id:'invalid-result-'+secondary,monthly_review:{...r.monthly_review!,completed_work_ids:['frozen-month-work']}};
 await assert.rejects(s.commitReview(bad),/every prepared semantic chunk/);assert.equal(await s.acceptedReviewIdentity(invalid.bundle_id),null);
 const full=structuredClone(b);full.bundle_id='complete-multi-'+secondary;await s.saveBundle(full);const complete=monthly(full,'complete-'+secondary,['complete','complete']);await s.commitReview(complete);
 assert.equal(s.getFactMaterialReads(b.monthly_context!.facts_page!.snapshot_id).size,b.monthly_context!.facts.length);
});
for(const first of ['partial','omitted'] as const) test(`monthly ${first} acceptance permits fresh complete result with same frozen material and immutable prior history`,async(t)=>{
 const {s,reviewer,request,prepared}=await material(t),r=monthly(prepared,'first-'+first,first==='partial'?['partial']:[],'Synthetic draft conclusion');const commit=await s.commitReview(r);
 const oldResult=canonical(await s.getReviewResult(r.result_id)),oldArtifact=canonical(await s.getPublicationOutbox(commit.batch_id));
 // Reproduce an earlier new-schema draft page without rewriting any accepted result.
 const context=prepared.monthly_context!,page=context.facts_page!,sources=context.manual_baselines.filter(p=>p.path!=='wiki/personal/journals/reviews/回顾_2026_09.md').map(p=>({path:p.path,digest:p.digest,content:p.content}));
 const legacyId=digest(canonical({offset:page.offset,sources,archives:context.archive_contexts?.map(i=>({work_id:i.work_id,original_digest:i.original_digest,content_excerpt:i.content_excerpt})),archive_page:context.archive_context_page}));
 s.db.prepare('INSERT OR IGNORE INTO semantic_material_pages VALUES(?,?,?,?,?)').run(page.snapshot_id,legacyId,page.offset,'monthly',canonical(r.monthly_review));
 const next=(await reviewer.prepare({...request,fact_snapshot:page.snapshot_id,fact_offset:page.offset}))[0];assert.notEqual(next.bundle_id,prepared.bundle_id,'accepted same-material attempt needs a fresh bundle identity even before file publication');
 assert.equal((await reviewer.prepare({...request,fact_snapshot:page.snapshot_id,fact_offset:page.offset}))[0].bundle_id,next.bundle_id,'unaccepted repeat prepare is stable');
 const complete=monthly(next,'second-'+first,['complete'],'Synthetic final corrected conclusion');const accepted=await s.commitReview(complete);
 assert.equal((await reviewer.prepare({...request,fact_snapshot:page.snapshot_id,fact_offset:page.offset}))[0].bundle_id,next.bundle_id,'complete accepted same material must reuse its bundle for publication recovery');
 const getBundle=s.getBundle;s.getBundle=async()=>{throw new Error('Accepted publication retry must not reread saved material');};try{assert.equal((await s.commitReview(complete)).reused,true);}finally{s.getBundle=getBundle;}
 assert.equal((await s.getPublicationOutbox(accepted.batch_id))!.artifact.monthly_review!.summary,complete.monthly_review!.summary);
 assert.equal(canonical(await s.getReviewResult(r.result_id)),oldResult);assert.equal(canonical(await s.getPublicationOutbox(commit.batch_id)),oldArtifact);
 assert.equal((s.db.prepare('SELECT json FROM semantic_material_pages WHERE snapshot_id=? AND material_id=?').get(page.snapshot_id,legacyId) as any).json,canonical(r.monthly_review));
 assert.equal(s.getFactMaterialReads(page.snapshot_id).size,context.facts.length);
});
test('exact fact material progress proves holes across snapshots without pending work or body parsing',async(t)=>{
 const {s}=await material(t),refs=[0,1,2].map(i=>({schema_version:1 as const,fact_id:'synthetic-frozen-'+i,revision:1}));
 const a=s.freezeFactMaterial('monthly','2026-09','2026-10-07T12:00:00Z',refs),b=s.freezeFactMaterial('monthly','2026-09','2026-10-07T13:00:00Z',refs.slice(1)),empty=s.freezeFactMaterial('monthly','2026-08','2026-10-07T12:00:00Z',[]);
 s.markFactMaterialRead(a,[refs[0],refs[2]]);s.markFactMaterialRead(b,refs.slice(1));s.db.prepare("UPDATE work SET state='done'").run();
 const parse=JSON.parse;JSON.parse=()=>{throw new Error('metadata progress must not hydrate body/facts/saved bundle/work');};
 try {assert.deepEqual(await s.factMaterialProgress(a),{schema_version:1,snapshot_id:a,cutoff:'2026-10-07T12:00:00Z',total:3,first_unread_offset:1,pending_work_count:0,pending_archive_context_count:0});assert.equal((await s.factMaterialProgress(b))!.first_unread_offset,null);assert.deepEqual(await s.factMaterialProgress(empty),{schema_version:1,snapshot_id:empty,cutoff:'2026-10-07T12:00:00Z',total:0,first_unread_offset:null,pending_work_count:0,pending_archive_context_count:0});assert.equal(await s.factMaterialProgress('missing'),null);} finally {JSON.parse=parse;}
 s.markFactMaterialRead(a,[refs[1]]);assert.equal((await s.factMaterialProgress(a))!.first_unread_offset,null);
});

test('prior complete semantic page remains immutable and contributes once after forward compatibility',async(t)=>{
 const {s,prepared}=await material(t),r=monthly(prepared,'old-complete',['complete']);await s.commitReview(r);
 const context=prepared.monthly_context!,page=context.facts_page!,row=s.db.prepare('SELECT material_id,json FROM semantic_material_pages WHERE snapshot_id=?').get(page.snapshot_id) as {material_id:string;json:string};
 // Model an earlier complete row: its accepted proof remains in results/bundles.
 s.db.prepare('UPDATE semantic_material_pages SET material_id=? WHERE snapshot_id=? AND material_id=?').run(row.material_id.slice('monthly-complete:'.length),page.snapshot_id,row.material_id);
 const same=structuredClone(prepared);same.bundle_id='synthetic-compatible-complete';await s.saveBundle(same);const commit=await s.commitReview({...r,result_id:'compatible-complete',bundle_id:same.bundle_id});
 assert.equal((await s.getPublicationOutbox(commit.batch_id))!.artifact.monthly_review!.summary,r.monthly_review!.summary,'complete old page is not double accumulated');
 const changed=structuredClone(prepared);changed.bundle_id='synthetic-changed-final';await s.saveBundle(changed);await assert.rejects(s.commitReview({...r,result_id:'changed-final',bundle_id:changed.bundle_id,monthly_review:{...r.monthly_review!,summary:'Invalid attempt to rewrite complete conclusion'}}),/semantic content conflict/);
 assert.equal((s.db.prepare('SELECT COUNT(*) AS n FROM semantic_material_pages WHERE snapshot_id=?').get(page.snapshot_id) as any).n,1);
});

test('old draft with identical final content cannot become a duplicate complete page on later aggregation',async(t)=>{
 const {s,prepared}=await material(t),draft=monthly(prepared,'equal-draft',['partial']);await s.commitReview(draft);
 const full=structuredClone(prepared);full.bundle_id='equal-full';await s.saveBundle(full);const r=monthly(full,'equal-final',['complete']);await s.commitReview(r);
 const page=full.monthly_context!.facts_page!,row=s.db.prepare('SELECT material_id,json FROM semantic_material_pages WHERE snapshot_id=?').get(page.snapshot_id) as any;
 s.db.prepare('INSERT INTO semantic_material_pages VALUES(?,?,?,?,?)').run(page.snapshot_id,row.material_id.slice('monthly-complete:'.length),page.offset,'monthly',row.json);
 const again=structuredClone(full);again.bundle_id='equal-again';await s.saveBundle(again);const commit=await s.commitReview({...r,result_id:'equal-again-result',bundle_id:again.bundle_id});
 assert.equal((await s.getPublicationOutbox(commit.batch_id))!.artifact.monthly_review!.summary,r.monthly_review!.summary);
});
