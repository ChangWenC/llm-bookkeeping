import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,readFile,writeFile,rm } from 'node:fs/promises';
import { dirname,join } from 'node:path';
import { createStore } from '../../src/store/index.ts';
import { createReviewer } from '../../src/review/index.ts';
import { createPublisher } from '../../src/publish/index.ts';
import { runDailyRound } from '../../src/daily-round.ts';
import { PERSONAL_DAILY_ROUND_LIMITS } from '../../src/config.ts';
import { config as cfg,event,collection,bundle,result } from '../store/fixtures.ts';
import type {RuntimeServices,ReviewBundle} from '../../src/contracts/types.ts';
const initial='2026-10-06T12:00:00.000Z';
async function setup(t:test.TestContext,count=2,large=false){
  const config=await cfg(),root=dirname(config.wiki_root);t.after(()=>rm(root,{recursive:true,force:true}));
  config.providers=[{schema_version:1,provider:'codex',account_id:'9007199254740993',enabled:true,roots:[],options:{}}];
  config.daily_round_limits={...PERSONAL_DAILY_ROUND_LIMITS};config.limits.chunk_events=1;if(large){config.limits.bundle_bytes=8192;config.limits.chunk_body_bytes=6000;}
  config.journal_timezone_timeline=[{schema_version:1,effective_from:'1970-01-01T00:00:00Z',timezone:'Europe/Amsterdam',basis:'synthetic'}];
  let clock=Date.parse(initial);const now=()=>new Date(clock),store=await createStore(config,{now});t.after(()=>store.close());
  const rows=Array.from({length:count},(_,i)=>{const e=event(`source:${i}`,large?'Synthetic work '.repeat(300):'Synthetic work',`2026-10-05T${String(9+i).padStart(2,'0')}:00:00.000Z`);if(i===1){e.utc_time={schema_version:1,value:'2026-09-30T10:00:00.000Z',reason:null};e.journal_date={schema_version:1,value:'2026-09-30',reason:null};}
    e.source.provider='codex';e.source.conversation_id=`chat:${i}`;return e;});
  await store.saveCollection({...collection(rows),coverage:[],checkpoints:[]});
  const output=join(root,'round');await mkdir(output,{mode:0o700});const manifest=join(output,'manifest.json');
  const services:RuntimeServices={store,reviewer:createReviewer(store,config),publisher:createPublisher(store,config,{now}),adapters:[],consumers:[]};
  const call=(options:Record<string,string|boolean>={})=>runDailyRound({output,manifest,...options},config,services,{now,collect:async()=>({schema_version:1,capture_status:'unknown'})});
  return {config,store,services,output,manifest,rows,call,advance:(ms:number)=>{clock+=ms;},now};
}
test('expired restricted active reaches terminal with no source guard/body read and unchanged start/count',async t=>{
  const f=await setup(t),first=await f.call();assert.equal(first.state,'review');
  const active=first.active!;assert.equal(active.kind,'source');
  f.config.review_read_exclusions={schema_version:1,events:[{schema_version:1,event_id:f.rows[0].event_id,reason:'Synthetic protected body'}]};
  let guards=0;f.services.store.assertReviewBundleReadable=()=>{guards++;throw new Error('Must not open expired source material');};
  f.advance(7_200_000);const expired=await f.call();
  assert.equal(expired.state,'deadline');assert.equal(expired.terminal,true);assert.equal(guards,0);
  assert.equal(expired.started_at,first.started_at);assert.equal(expired.started_bundles,first.started_bundles);assert.deepEqual(expired.active?.kind,active.kind);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM reviewed_sources').get()!.n,0);
  assert.equal((await f.call()).state,'deadline');assert.equal(guards,0);
});
test('explicit finish preserves original active and exact units while settling consumers without new preparation',async t=>{
  const f=await setup(t),first=await f.call();let prepared=0,consumed=0;
  f.services.reviewer.prepareWithOutcomes=async()=>{prepared++;throw new Error('No new semantic start');};
  f.services.consumers=[{target:'synthetic',consume:async()=>{consumed++;return {schema_version:1,target:'synthetic',status:'complete',acknowledged_batch_ids:[],reason:null};}}];
  const finished=await f.call({finish:true,reason:'Synthetic author stopped'});
  assert.equal(finished.terminal,true);assert.equal(finished.started_at,first.started_at);assert.equal(finished.cutoff,first.cutoff);assert.equal(finished.started_bundles,1);assert.equal(prepared,0);assert.equal(consumed,1);
  const saved=JSON.parse(await readFile(f.manifest,'utf8')).daily_round;
  assert.deepEqual(saved.skip_units,(first.active as any).units);assert.equal(saved.active.bundle_id,(first.active as any).bundle_id);
  assert.equal(saved.active.terminal_disposition,'deferred_unreviewed');assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM reviewed_sources').get()!.n,0);
});
test('journal downstream exception preserves committed receipt and immutable resolution on daily retry',async t=>{
  const f=await setup(t,0),e=event('journal-accepted'),b=bundle([e],'journal-existing'),review=result(b,'journal-existing-result');review.pages=[];
  await f.store.saveCollection({...collection([e],'history','journal-collection'),coverage:[],checkpoints:[]});await f.store.saveBundle(b);await f.store.commitReview(review);
  const first=await f.call();assert.equal(first.state,'journal_review');const material=JSON.parse(await readFile(first.active!.file,'utf8'));
  const resolution={schema_version:1,resolution_id:'exact-journal-resolution',journal_bundle_id:material.journal_bundle_id,created_at:initial,pages:[],dispositions:material.work.map((w:any)=>({schema_version:1,work_id:w.work_id,disposition:'not_needed',baseline_assessment:{schema_version:1,baseline_digest:material.baselines.find((page:any)=>page.path===w.payload.path).digest,summary_text:null,body_evidence_text:'',consistency:'consistent',reason:'Synthetic full absent baseline review'},reason:'Synthetic exact editorial decision'}))};
  const input=join(f.output,'resolution.json');await writeFile(input,JSON.stringify(resolution));
  f.services.publisher.resume=async()=>{throw new Error('Synthetic downstream publisher outage');};
  const failed:any=await f.call({'journal-input':input});assert.equal(failed.state,'publication_pending');assert.equal(failed.receipt.resolution_commit,'committed');assert.equal(failed.receipt.continuation.stage,'resume');assert.equal(failed.accepted.resolution_id,resolution.resolution_id);
  const saved=JSON.parse(await readFile(f.manifest,'utf8')).daily_round;const full=JSON.parse(await readFile(saved.receipts.at(-1).file,'utf8'));assert.equal(full.result.receipt.resolution_id,resolution.resolution_id);
  const retried:any=await f.call({'journal-input':input});assert.equal(retried.state,'publication_pending');assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM journal_resolutions WHERE id=?').get(resolution.resolution_id)!.n,1);
});
test('journal gets a bounded opportunity after four completed six-minute source packets',async t=>{
  const f=await setup(t,8,true);let receipt:any=await f.call();assert.equal(receipt.state,'review');
  for(let i=0;i<4;i++){
    const b:ReviewBundle=JSON.parse(await readFile(receipt.active.file,'utf8')),r=result(b,`source-result:${i}`);r.pages=[];r.created_at=f.now().toISOString();r.candidates[0].occurred_at=b.chunks[0].events[0].utc_time;r.candidates[0].journal_date=b.chunks[0].events[0].journal_date;
    const input=join(f.output,`source-${i}.json`);await writeFile(input,JSON.stringify(r));f.advance(360_000);receipt=await f.call({input});
    if(i<3)assert.equal(receipt.state,'review',JSON.stringify(receipt));
  }
  assert.equal(receipt.state,'journal_review');assert.equal(receipt.started_bundles,5);assert.ok(f.now().getTime()<Date.parse(initial)+6_300_000);
});
test('source publish exception keeps the full committed identity and retry never creates another result or fact',async t=>{
 const f=await setup(t),first:any=await f.call(),b:ReviewBundle=JSON.parse(await readFile(first.active.file,'utf8')),r=result(b,'source-committed-error',false);r.created_at=initial;
 const input=join(f.output,'source-result.json');await writeFile(input,JSON.stringify(r));
 const publish=f.services.publisher.publish.bind(f.services.publisher);let fail=true;
 f.services.publisher.publish=async review=>{const receipt=await publish(review);if(fail)throw Object.assign(new Error('Synthetic downstream failure after commit'),{receipt});return receipt;};
 const failed:any=await f.call({input});assert.equal(failed.state,'publication_pending');assert.equal(failed.receipt.fact_commit,'committed');assert.equal(failed.accepted.result_id,r.result_id);assert.equal(failed.active.bundle_id,b.bundle_id);
 fail=false;await f.call({input});assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM results WHERE id=?').get(r.result_id)!.n,1);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM facts').get()!.n,0);
 const manifest=JSON.parse(await readFile(f.manifest,'utf8')).daily_round;const full=await Promise.all(manifest.receipts.filter((row:any)=>row.stage==='acceptance').map(async(row:any)=>JSON.parse(await readFile(row.file,'utf8'))));assert.equal(full[0].result.receipt.result_id,r.result_id);
});
test('at ninety minutes journal is prioritized before another source even before four completions',async t=>{
 const f=await setup(t),first:any=await f.call(),b:ReviewBundle=JSON.parse(await readFile(first.active.file,'utf8')),r=result(b,'source-late-journal');r.pages=[];r.candidates[0].occurred_at=b.chunks[0].events[0].utc_time;r.candidates[0].journal_date=b.chunks[0].events[0].journal_date;
 const input=join(f.output,'late-result.json');await writeFile(input,JSON.stringify(r));f.advance(5_400_000);
 const next:any=await f.call({input});assert.equal(next.state,'journal_review');assert.equal(next.started_bundles,2);assert.equal(JSON.parse(await readFile(f.manifest,'utf8')).daily_round.completed_source_bundles,1);
});
test('old manifest resumes additively without resetting cutoff/start/count/active identity',async t=>{
 const f=await setup(t),first:any=await f.call(),old=JSON.parse(await readFile(f.manifest,'utf8'));
 for(const key of ['completed_source_bundles','journal_checked_after_source','continuations','unavailable'])delete old.daily_round[key];
 await writeFile(f.manifest,JSON.stringify(old));f.advance(30_000);const resumed:any=await f.call();
 assert.equal(resumed.active.bundle_id,first.active.bundle_id);assert.equal(resumed.started_at,first.started_at);assert.equal(resumed.cutoff,first.cutoff);assert.equal(resumed.started_bundles,first.started_bundles);assert.equal(resumed.remaining_ms,first.remaining_ms-30_000);
 const updated=JSON.parse(await readFile(f.manifest,'utf8')).daily_round;assert.deepEqual(updated.skip_units,old.daily_round.skip_units);assert.equal(updated.completed_source_bundles,0);assert.deepEqual(updated.continuations,{});
});
test('finish near original deadline omits potentially slow full status without resetting time',async t=>{
 const f=await setup(t),first:any=await f.call();let reads=0;f.services.store.status=async()=>{reads++;f.advance(180_000);return {synthetic_slow_status:true};};
 f.advance(7_100_000);const finished:any=await f.call({finish:true,reason:'Close original run before timeout'});
 assert.equal(reads,0);assert.equal(finished.terminal,true);assert.equal(finished.status,null);assert.match(finished.status_omitted_reason,/near original task deadline/);assert.equal(finished.remaining_ms,100_000);assert.equal(finished.task_deadline,first.task_deadline);
});

test('global storage failure preserves the complete committed error receipt and stops before further manifest writes',async t=>{
 const f=await setup(t),first:any=await f.call(),b:ReviewBundle=JSON.parse(await readFile(first.active.file,'utf8')),r=result(b,'storage-accepted',false);r.created_at=initial;
 const input=join(f.output,'storage-result.json');await writeFile(input,JSON.stringify(r));
 const before=await readFile(f.manifest,'utf8'),publish=f.services.publisher.publish.bind(f.services.publisher);let consumed=0;
 f.services.consumers=[{target:'must-not-run',consume:async()=>{consumed++;throw new Error('No later shared writes');}}];
 f.services.publisher.publish=async review=>{const receipt=await publish(review);throw Object.assign(new Error('Synthetic quota failure'),{code:'EDQUOT',receipt});};
 await assert.rejects(f.call({input}),error=>{const full=(error as any).receipt;assert.equal((error as any).code,'EDQUOT');assert.equal(full.fact_commit,'committed');assert.equal(full.result_id,r.result_id);assert.equal(typeof full.batch_id,'string');return true;});
 assert.equal(await readFile(f.manifest,'utf8'),before);assert.equal(consumed,0);
 assert.equal((await f.store.acceptedReviewIdentity(b.bundle_id))?.result_id,r.result_id);
});

test('a changed exact read exclusion clears only candidate tokens and resumes unaccepted safe peers',async t=>{
 const f=await setup(t,3,true),first:any=await f.call();assert.equal(first.state,'review');
 const b:ReviewBundle=JSON.parse(await readFile(first.active.file,'utf8')),r=result(b,'exclusion-scope-accepted',false);r.created_at=initial;
 const input=join(f.output,'exclusion-result.json');await writeFile(input,JSON.stringify(r));
 f.config.review_read_exclusions={schema_version:1,events:[{schema_version:1,event_id:f.rows[1].event_id,reason:'Synthetic newly protected source'}]};
 const reopened=await createStore(f.config,{now:f.now});t.after(()=>reopened.close());f.services.store=reopened;f.services.reviewer=createReviewer(reopened,f.config);f.services.publisher=createPublisher(reopened,f.config,{now:f.now});
 const next:any=await f.call({input});assert.equal(next.state,'review');assert.equal(next.started_at,first.started_at);assert.equal(next.cutoff,first.cutoff);assert.equal(next.started_bundles,2);
 const material:ReviewBundle=JSON.parse(await readFile(next.active.file,'utf8'));assert.deepEqual(material.chunks.flatMap(c=>c.events.map(e=>e.event_id)),[f.rows[2].event_id]);
 assert.equal((await f.store.acceptedReviewIdentity(b.bundle_id))?.result_id,r.result_id);
});
