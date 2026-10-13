import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {config,event,bundle,result,collection} from '../store/fixtures.ts';
import {createStore} from '../../src/store/index.ts';
import {createReviewer} from '../../src/review/index.ts';
import {createPublisher,digestBytes} from '../../src/publish/index.ts';
import {executeCommand,parseArgs} from '../../src/cli.ts';
import {runDailyRound} from '../../src/daily-round.ts';
import type {RuntimeServices} from '../../src/contracts/types.ts';
test('actual SQLite clarification unit cannot disappear; journal user decision and finish outcomes preserve independent stages',async t=>{
 const c=await config(),root=dirname(c.wiki_root),clock='2026-10-11T12:00:00Z',s=await createStore(c,{now:()=>new Date(clock)});
 t.after(async()=>{s.close();await rm(root,{recursive:true,force:true});});
 const clarification=event('clarification','An explicit synthetic correction.'),resume=event('resume','Unrelated synthetic resume activity.'),b=bundle([clarification,resume],'oct11-real-stage');
 const path=b.baselines[0].path,old='---\nsummary: Confirmed conclusion\ntype: journal\n---\nOriginal confirmed body.\n';await mkdir(dirname(join(c.wiki_root,path)),{recursive:true});await writeFile(join(c.wiki_root,path),old);b.baselines=[{schema_version:1,path,digest:digestBytes(Buffer.from(old)),content:old}];
 await s.saveCollection(collection([clarification,resume]));await s.saveBundle(b);
 const review=result(b,'oct11-result');review.candidates[0].event_refs=[{schema_version:1,event_id:resume.event_id}];review.candidates[0].analytics_projection.value!.event_refs=review.candidates[0].event_refs;review.unit_dispositions=undefined;Object.assign(review.pages[0],{mode:'replace',old_text:'Original confirmed body.',new_text:'A proposed different body.'});
 await assert.rejects(s.commitReview(review),/Primary unit lacks/);assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM results').get()!.n,0);
 review.unit_dispositions=[{schema_version:1,units:[{schema_version:1,event_id:clarification.event_id,start_byte:0,end_byte:Buffer.byteLength(clarification.body!)}],disposition:'defer',fact_refs:[],reason:'Clarification is not resolved by unrelated resume activity'}];
 const publisher=createPublisher(s,c,{now:()=>new Date(clock)}),published=await publisher.publish(review);assert.equal(published.fact_commit,'committed');assert.equal(published.export_status,'ready');assert.equal(published.files.find(item=>item.path===path)?.status,'pending');assert.equal(await readFile(join(c.wiki_root,path),'utf8'),old);
 assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM reviewed_sources WHERE source_id=?").get(clarification.event_id)!.n,0);assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM reviewed_sources WHERE source_id=? AND lane='live'").get(resume.event_id)!.n,1);
 const actualStatus=await s.status();assert.ok(Number((actualStatus.journal_publication as any).pending)>0);assert.ok(Number(actualStatus.pending_patches)>0);assert.ok('conflicting_patches' in actualStatus);
 const services={store:s,adapters:[],reviewer:createReviewer(s,c),publisher,consumers:[{target:'index',consume:async()=>({schema_version:1,status:'pending',target:'index',reason:'Synthetic QMD outage'})}]} as RuntimeServices;
 const output=join(root,'round'),manifest=join(output,'manifest.json');await runDailyRound({output,manifest},c,services,{now:()=>new Date(clock),collect:async()=>({execution_status:'unknown'})});
 const finished=await runDailyRound({output,manifest,finish:true,reason:'Synthetic stop'},c,services,{now:()=>new Date(clock),collect:async()=>{throw new Error('No recapture on finish');}});
 assert.equal(finished.stage_outcomes.journal.status,'partial');assert.equal(finished.stage_outcomes.index.status,'partial');assert.equal(finished.stage_outcomes.file_publication.status,'partial');assert.equal(finished.overall_status,'partial');
 const proposal=(await s.listWork('journal_confirmation'))[0].payload.proposal as any,proposalDir=join(root,'proposal');
 const saved=await executeCommand(parseArgs(['journal-proposal','--id',proposal.proposal_id,'--output',proposalDir]),c,services,clock) as any;assert.equal(JSON.stringify(saved).includes('Original confirmed body.'),false);const material=JSON.parse(await readFile(saved.file,'utf8'));assert.equal(material.old_text,old);
 const decision={schema_version:1,decision_id:'human:synthetic',proposal_id:proposal.proposal_id,proposal_digest:proposal.proposal_digest,decision:'confirm',basis:'explicit_user_response',baseline_digest:proposal.baseline_digest,fact_refs:proposal.fact_refs,work_ids:proposal.work_ids,reason:'Synthetic explicit user-response fixture',response_source:'synthetic cooperative chat',response_content:'I confirm this exact proposed change.'};const input=join(root,'decision.json');
 await writeFile(input,JSON.stringify({...decision,basis:'automatic_review'}));await assert.rejects(executeCommand(parseArgs(['journal-decide','--input',input]),c,services,clock),/explicit user response/);assert.equal(await readFile(join(c.wiki_root,path),'utf8'),old);
 await writeFile(input,JSON.stringify(decision));const accepted=await executeCommand(parseArgs(['journal-decide','--input',input]),c,services,clock) as any;assert.equal(accepted.status,'confirmed');await publisher.resume();assert.match(await readFile(join(c.wiki_root,path),'utf8'),/A proposed different body/);assert.equal((await publisher.publish(review)).fact_commit,'already_committed');assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM results').get()!.n,1);
});

test('three slow synchronous context stages make stable semantic progress instead of rotating empty tokens',async t=>{
 const c=await config(),s=await createStore(c);t.after(async()=>{s.close();await rm(dirname(c.wiki_root),{recursive:true,force:true});});await s.saveCollection(collection([event('slow-primary')]));
 let clock=0;const calls={facts:0,coverage:0,context:0};t.mock.method(performance,'now',()=>clock);
 const facts=s.getScopedReviewFacts.bind(s);s.getScopedReviewFacts=(...args)=>{calls.facts++;const output=facts(...args);clock+=6000;return output;};
 const coverage=s.listReviewCoverage.bind(s);s.listReviewCoverage=async(...args)=>{calls.coverage++;const output=await coverage(...args);clock+=6000;return output;};
 const context=s.getContextEvents.bind(s);s.getContextEvents=(...args)=>{calls.context++;const output=context(...args);clock+=6000;return output;};
 const r=createReviewer(s,c),scope={kind:'daily' as const,lane:'history' as const,source:'synthetic',range:collection([]).coverage[0].query_range,cutoff:'2026-10-01T00:00:00.000Z',selection_basis:'event_time' as const,max_bundles:1};let continuation:any;const frontiers:string[]=[];
 for(let i=0;i<3;i++){clock=0;const prepared=await r.prepareWithOutcomes!({...scope,candidate_continuation:continuation});assert.equal(prepared.bundles.length,0);const candidate=prepared.providers[0].preparation!;assert.equal(candidate.state,'more');assert.equal(candidate.progress?.advanced,true);frontiers.push(candidate.progress!.frontier);continuation=candidate.continuation;assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM reviewed_sources').get()!.n,0);}
 clock=0;const ready=await r.prepareWithOutcomes!({...scope,candidate_continuation:continuation});assert.equal(ready.providers[0].preparation?.state,'ready');assert.equal(ready.bundles[0].chunks[0].events[0].event_id,'slow-primary');assert.deepEqual(calls,{facts:1,coverage:1,context:1});assert.equal(new Set(frontiers).size,3);
});
