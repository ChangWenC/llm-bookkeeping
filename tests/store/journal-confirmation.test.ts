import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {createStore,digest} from '../../src/store/index.ts';
import {createReviewer} from '../../src/review/index.ts';
import {acquireWikiLock} from '../../src/publish/lock.ts';
import {strongAssessment} from './fixtures.ts';
import {config,bundle,result,event} from './fixtures.ts';
import type {FileIntent,JournalUserDecision} from '../../src/contracts/types.ts';
async function setup() {
 const c=await config(),s=await createStore(c),b=bundle();await s.saveBundle(b);const commit=await s.commitReview(result(b)),patch=commit.patches[0],old='Original domestic conclusion\n',next='Proposed interpretation\n';
 await mkdir(dirname(join(c.wiki_root,patch.path)),{recursive:true});await writeFile(join(c.wiki_root,patch.path),old);
 const intent:FileIntent={schema_version:1,operation_id:patch.operation_id,path:patch.path,baseline_digest:digest(old),desired_digest:digest(next),backup_bytes_base64:Buffer.from(old).toString('base64'),desired_bytes_base64:Buffer.from(next).toString('base64'),fact_refs:patch.fact_refs,state:'prepared',created_at:'2026-10-11T12:00:00Z'};
 const lock=await acquireWikiLock(c.wiki_root);assert(lock);return {c,s,commit,intent,old,next,lock};
}
const decision=(p:NonNullable<Awaited<ReturnType<Awaited<ReturnType<typeof createStore>>['getJournalConfirmation']>>>,kind:'confirm'|'keep_existing'='confirm'):JournalUserDecision=>({schema_version:1,decision_id:'user:'+p.proposal_id+':'+kind,proposal_id:p.proposal_id,proposal_digest:p.proposal_digest,decision:kind,basis:'explicit_user_response',baseline_digest:p.baseline_digest,fact_refs:p.fact_refs,work_ids:p.work_ids,reason:'Explicit synthetic user response',response_source:'synthetic chat response',response_content:'Confirm this exact proposed change'});
test('stable pending proposal freezes full bytes, exact refs and work; automatic preparation cannot consume it; explicit confirmation precedes file completion',async()=>{
 const {s,c,intent,old,next,lock}=await setup();try {
 const request={schema_version:1 as const,intent,current_baseline_digest:intent.baseline_digest,old_text:old,new_text:next,reason:'Existing journal semantic replacement',requires_confirmation:true};
 const guard=await s.ensureJournalConfirmation(request,lock);assert.equal(guard.status,'awaiting_user_confirmation');assert.equal((await s.ensureJournalConfirmation({...request,requires_confirmation:false},lock)).proposal_id,guard.proposal_id);
 const proposal=await s.getJournalConfirmation(guard.proposal_id!);assert(proposal);assert.deepEqual(proposal.fact_refs,intent.fact_refs);assert.equal(proposal.old_text,old);assert.equal(proposal.new_text,next);assert.equal((await createReviewer(s,c).prepareJournalWork!({schema_version:1,cutoff:'2026-10-11T12:00:00Z'})).work.length,0);
 await assert.rejects(s.decideJournalConfirmation({...decision(proposal),basis:'automatic_result' as any},lock),/explicit user response/);
 await s.saveFileIntent(intent);const approved=await s.decideJournalConfirmation(decision(proposal),lock);assert.equal(approved.status,'confirmed');assert.equal((await s.validateJournalConfirmation(intent,lock)).status,'confirmed');assert.equal((await s.listWork('journal_confirmation'))[0].state,'pending');
 await writeFile(join(c.wiki_root,intent.path),next);await s.updateFileIntent(intent.operation_id,'applied');assert.equal((await s.listWork('journal_publication'))[0].state,'complete');assert.equal((await s.listWork('journal_confirmation'))[0].state,'complete');assert.equal((await s.getJournalConfirmation(proposal.proposal_id))!.state,'confirmed');
 }finally{await lock.release();s.close();}
});
test('changed page invalidates confirmation and re-enables exact bounded journal preparation without inheriting approval',async()=>{
 const {s,c,intent,old,next,lock}=await setup();try {
 const initial=await s.ensureJournalConfirmation({schema_version:1,intent,current_baseline_digest:intent.baseline_digest,old_text:old,new_text:next,reason:'Existing journal semantic replacement',requires_confirmation:true},lock),proposal=await s.getJournalConfirmation(initial.proposal_id!);assert(proposal);await s.decideJournalConfirmation(decision(proposal),lock);
 const changed='Human current edit\n';await writeFile(join(c.wiki_root,intent.path),changed);assert.equal((await s.validateJournalConfirmation(intent,lock)).status,'stale');assert.equal((await s.listWork('journal_publication'))[0].payload.awaiting_user_confirmation,false);
 const current=await createReviewer(s,c).prepareJournalWork!({schema_version:1,cutoff:'2026-10-11T12:00:00Z'});assert.equal(current.work.length,1);assert.equal(current.baselines[0].digest,digest(changed));
 const fresh={...intent,baseline_digest:digest(changed),backup_bytes_base64:Buffer.from(changed).toString('base64')};const guard=await s.ensureJournalConfirmation({schema_version:1,intent:fresh,current_baseline_digest:fresh.baseline_digest,old_text:changed,new_text:next,reason:'Existing journal semantic replacement',requires_confirmation:true},lock);assert.notEqual(guard.proposal_id,initial.proposal_id);assert.equal(guard.status,'awaiting_user_confirmation');assert.equal((await s.getJournalConfirmation(initial.proposal_id!))!.state,'stale');
 }finally{await lock.release();s.close();}
});
test('later exact replacement/retraction invalidates a previously confirmed fact; keep_existing is a separate terminal human choice',async()=>{
 const {s,c,intent,old,next,lock}=await setup();try {
 const guard=await s.ensureJournalConfirmation({schema_version:1,intent,current_baseline_digest:intent.baseline_digest,old_text:old,new_text:next,reason:'Existing journal semantic replacement',requires_confirmation:true},lock),p=await s.getJournalConfirmation(guard.proposal_id!);assert(p);
 const wrong={...decision(p),fact_refs:[{...p.fact_refs[0],revision:99}]};await assert.rejects(s.decideJournalConfirmation(wrong,lock),/exact frozen proposal/);
 const kept=await s.decideJournalConfirmation(decision(p,'keep_existing'),lock);assert.equal(kept.status,'keep_existing');assert.equal((await s.listWork('journal_publication'))[0].payload.user_decision,'keep_existing');assert.notEqual((await s.listWork('journal_publication'))[0].payload.disposition,'already_present');assert.equal(await s.getOperationSupersession(intent.operation_id),'terminal:'+kept.decision_id);
 const b=bundle([event('correction')],'correction');b.existing_facts=s.lookupFactRevisions(intent.fact_refs);await s.saveBundle(b);const r=result(b,'correction');r.pages=[];r.candidates[0].disposition='retract';r.candidates[0].target_refs=intent.fact_refs;await s.commitReview(r);
 assert.equal((await s.decideJournalConfirmation({...decision(p),decision_id:'after-retraction'},lock)).status,'stale');
 }finally{await lock.release();s.close();}
});

test('a correct body substring cannot silently close a new semantic correction when its complete summary contradicts it',async()=>{
 const c=await config(),s=await createStore(c),first=bundle([event('original')],'original');await s.saveBundle(first);const original=result(first,'original');original.pages=[];const fact=(await s.commitReview(original)).facts[0];
 const b=bundle([event('clarification','明确国内结论')],'clarification'),path=b.baselines[0].path,text='---\nsummary: 合法W猜测覆盖原国内结论\n---\n明确国内结论\n';b.existing_facts=[fact];b.baselines=[{schema_version:1,path,digest:digest(text),content:text}];await mkdir(dirname(join(c.wiki_root,path)),{recursive:true});await writeFile(join(c.wiki_root,path),text);await s.saveBundle(b);
 const r=result(b,'clarification');r.pages=[];r.candidates[0].disposition='replace';r.candidates[0].content='明确国内结论';r.candidates[0].target_refs=[{schema_version:1,fact_id:fact.fact_id,revision:1}];r.journal_dispositions=[{schema_version:1,candidate_id:r.candidates[0].candidate_id,date:'2026-09-30',path,disposition:'already_present',evidence_text:'明确国内结论',reason:'Correct substring exists'}];
 const committed=await s.commitReview(r);assert.equal(committed.facts.length,1);const work=(await s.listWork('journal_publication')).find(w=>(w.payload.fact_ref as any).revision===2)!;assert.equal(work.state,'deferred');assert.match(work.reason!,/semantic correction/);s.close();
});
test('complete baseline assessment checks exact summary and body location while unknown or conflicting semantic declarations retain debt',async()=>{
 for(const [label,summary,evidence,consistency,complete] of [['wrong-summary','wrong','Correct body','consistent',false],['header-evidence','"Correct header"','Correct header','consistent',false],['unknown','"Correct header"','Correct body','unknown',false],['conflicting','"Correct header"','Correct body','conflicting',false],['consistent','"Correct header"','Correct body','consistent',true]] as const){
 const c=await config(),s=await createStore(c),b=bundle([event(label)],label),path=b.baselines[0].path,text='---\nsummary: "Correct header"\n---\nCorrect body\n';b.baselines=[{schema_version:1,path,digest:digest(text),content:text}];await mkdir(dirname(join(c.wiki_root,path)),{recursive:true});await writeFile(join(c.wiki_root,path),text);await s.saveBundle(b);const r=result(b,label);r.pages=[];r.journal_dispositions=[{schema_version:1,candidate_id:r.candidates[0].candidate_id,date:'2026-09-30',path,disposition:'already_present',evidence_text:evidence,reason:'Synthetic full page review',baseline_assessment:{...strongAssessment(text),summary_text:summary,body_evidence_text:evidence,consistency}}];
 await s.commitReview(r);assert.equal((await s.listWork('journal_publication'))[0].state,complete?'complete':'deferred',label);s.close();}
});

test('fact replacement invalidates get and original decision retry, releases awaiting work and does not inherit prior confirmation',async()=>{
 const {s,c,intent,old,next,lock}=await setup();try {
 const guard=await s.ensureJournalConfirmation({schema_version:1,intent,current_baseline_digest:intent.baseline_digest,old_text:old,new_text:next,reason:'Existing journal semantic replacement',requires_confirmation:true},lock),proposal=await s.getJournalConfirmation(guard.proposal_id!);assert(proposal);const d=decision(proposal);await s.decideJournalConfirmation(d,lock);
 const b=bundle([event('later-fact')],'later-fact');b.existing_facts=s.lookupFactRevisions(intent.fact_refs);await s.saveBundle(b);const r=result(b,'later-fact');r.pages=[];r.candidates[0].disposition='replace';r.candidates[0].target_refs=intent.fact_refs;await s.commitReview(r);
 assert.equal((await s.getJournalConfirmation(proposal.proposal_id))!.state,'stale');assert.equal((await s.decideJournalConfirmation(d,lock)).status,'stale');assert.equal((await s.listWork('journal_publication')).find(w=>w.payload.operation_id===intent.operation_id)!.payload.awaiting_user_confirmation,false);
 const prepared=await createReviewer(s,c).prepareJournalWork!({schema_version:1,cutoff:'2026-10-11T12:00:00Z'});assert(prepared.work.length>0);
 }finally{await lock.release();s.close();}
});

test('new user decisions require actual response evidence while stored legacy accepted decision retries remain compatible',async()=>{
 const {s,intent,old,next,lock}=await setup();try{const guard=await s.ensureJournalConfirmation({schema_version:1,intent,current_baseline_digest:intent.baseline_digest,old_text:old,new_text:next,reason:'Exact synthetic replacement',requires_confirmation:true},lock),proposal=(await s.getJournalConfirmation(guard.proposal_id!))!,full=decision(proposal),legacy={...full};delete legacy.response_source;delete legacy.response_content;await assert.rejects(s.decideJournalConfirmation(legacy,lock),/response_source and response_content/);const receipt=await s.decideJournalConfirmation(full,lock),key='journal-user-decision:'+full.decision_id;s.db.prepare('UPDATE metadata SET value=? WHERE key=?').run(JSON.stringify({decision:legacy,receipt}),key);assert.deepEqual(await s.decideJournalConfirmation(legacy,lock),receipt);}finally{await lock.release();s.close();}
});
