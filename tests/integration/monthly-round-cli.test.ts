import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,writeFile,mkdir,rm } from 'node:fs/promises';
import { dirname,join } from 'node:path';
import { runCli } from '../../src/cli.ts';
import { createStore } from '../../src/store/index.ts';
import { config as cfg,event,collection,bundle,result } from '../store/fixtures.ts';
import type {ReviewBundle} from '../../src/contracts/types.ts';
const started='2026-10-07T12:00:00.000Z';
async function setup(t:test.TestContext,contentRepeats=35){
 const config=await cfg(),root=dirname(config.wiki_root);t.after(()=>rm(root,{recursive:true,force:true}));config.providers=[];config.journal_timezone_timeline=[{schema_version:1,effective_from:'1970-01-01T00:00:00Z',timezone:'Europe/Amsterdam',basis:'synthetic'}];
 config.limits.bundle_bytes=8192;config.limits.chunk_body_bytes=4096;
 const output=join(root,'monthly');await mkdir(output,{mode:0o700});const manifest=join(output,'manifest.json'),configPath=join(root,'config.json');await writeFile(configPath,JSON.stringify(config));
 let clock=Date.parse(started);
 const cli=async(extra:string[]=[],expected=0)=>{let stdout='',stderr='';const code=await runCli(['monthly-round','--manifest',manifest,'--output',output,'--config',configPath,...extra],{now:()=>new Date(clock).toISOString(),stdout:s=>stdout+=s,stderr:s=>stderr+=s});assert.equal(code,expected,stderr);return JSON.parse(stdout);};
 const store=await createStore(config,{now:()=>new Date(clock)});
 for(const month of ['2026-08','2026-09']){
  for(let i=0;i<6;i++){const e=event(`${month}:${i}`,'Synthetic event',`${month}-${String(10+i).padStart(2,'0')}T09:00:00.000Z`),b=bundle([e],`seed:${month}:${i}`),r=result(b,`accepted:${month}:${i}`);b.cutoff=started;r.created_at=started;r.pages=[];r.candidates[0].content='Synthetic professional ledger. '.repeat(contentRepeats);r.candidates[0].occurred_at=e.utc_time;r.candidates[0].journal_date=e.journal_date;await store.saveCollection({...collection([e],'history',`collect:${month}:${i}`),coverage:[],checkpoints:[]});await store.saveBundle(b);await store.commitReview(r);}
  await store.enqueueWork({schema_version:1,work_id:`monthly:${month}`,kind:'prepare_monthly',lane:'history',state:'pending',payload:{month,batch_id:`synthetic:${month}`},reason:'Synthetic pending monthly review',migration_key:null,updated_at:started});
 }
 await store.enqueueWork({schema_version:1,work_id:'monthly:2026-10',kind:'prepare_monthly',lane:'history',state:'pending',payload:{month:'2026-10',batch_id:'synthetic-current'},reason:'Current month stays pending',migration_key:null,updated_at:started});store.close();
 return {config,output,manifest,cli,advance:(ms:number)=>{clock+=ms;}};
}
test('actual monthly CLI/SQLite rotates previous complete month then older debt with frozen evidence pages and exact published work',async t=>{
 const f=await setup(t);let receipt=await f.cli();assert.equal(receipt.state,'monthly_review');assert.equal(receipt.active.month,'2026-09');
 const scopes=new Map<string,{snapshot:string;cutoff:string;offsets:number[]}>(),months:string[]=[];let iterations=0;
 while(receipt.state==='monthly_review'&&iterations++<12){
  const active=receipt.active,b:ReviewBundle=JSON.parse(await readFile(active.file,'utf8')),context=b.monthly_context!;months.push(active.month);
  const page=context.facts_page!;assert.ok(page);
  const previous=scopes.get(active.month);if(previous){assert.equal(page.snapshot_id,previous.snapshot);assert.equal(page.cutoff,previous.cutoff);assert.ok(!previous.offsets.includes(page.offset));previous.offsets.push(page.offset);}else scopes.set(active.month,{snapshot:page.snapshot_id,cutoff:page.cutoff,offsets:[page.offset]});
  const r={schema_version:1,result_id:`monthly-result:${active.bundle_id}`,bundle_id:active.bundle_id,chunks:b.chunks.map(chunk=>({schema_version:1,chunk_id:chunk.chunk_id,status:'complete',reviewed_event_ids:[],zero_facts:true,reason:null})),candidates:[],pages:[],created_at:started,monthly_review:{schema_version:1,month:active.month,summary:`Synthetic accepted ${active.month} page ${page.offset}`,fact_refs:context.facts.map(fact=>({schema_version:1,fact_id:fact.fact_id,revision:fact.revision})),supplement_text:'',coverage_status:context.coverage_status,completed_work_ids:context.prepared_work_ids??[],completed_archive_context_ids:[]}};
  const input=join(f.output,`result-${iterations}.json`);await writeFile(input,JSON.stringify(r));receipt=await f.cli(['--input',input]);
 }
 assert.equal(receipt.terminal,true);assert.equal(receipt.state,'complete');assert.deepEqual(months.slice(0,2),['2026-09','2026-08']);assert.ok(scopes.get('2026-09')!.offsets.length>1,'Bounded facts create actual continuation');assert.ok(scopes.get('2026-08')!.offsets.length>1);
 const store=await createStore(f.config);try{
  const work=await store.listWork('prepare_monthly');
  assert.equal(work.find(w=>w.work_id==='monthly:2026-10')!.state,'pending');
  for(const month of ['2026-08','2026-09']){
   assert.equal(work.find(w=>w.work_id===`monthly:${month}`)!.state,'complete',JSON.stringify({month,work,reads:store.db.prepare('SELECT * FROM fact_material_reads').all()}));
   const scope=scopes.get(month)!;
   assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM fact_material_reads WHERE snapshot_id=?').get(scope.snapshot)!.n,6);
  }
  const status=await store.monthlySemanticStatus!(started);assert.ok(status.months.some(month=>month.month==='2026-10'&&!month.eligible));
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM facts').get()!.n,12,'Monthly semantics allocate no duplicate facts');
  const text=await readFile(join(f.config.wiki_root,'wiki/personal/journals/reviews/回顾_2026_09.md'),'utf8');assert.ok(text.includes('Synthetic accepted 2026-09'));
 }finally{store.close();}
});
test('monthly finish keeps original clocks/active; current or preceding month cannot be archive target',async t=>{
 const f=await setup(t);const invalid=await f.cli(['--archive-month','2026-09'],2);assert.equal(invalid.error.kind,'invalid_input');
 const first=await f.cli();f.advance(30_000);const stopped=await f.cli(['--finish','--reason','Synthetic early stop']);assert.equal(stopped.terminal,true);assert.equal(stopped.active.bundle_id,first.active.bundle_id);assert.equal(stopped.started_bundles,first.started_bundles);assert.equal(stopped.started_at,first.started_at);assert.equal(stopped.cutoff,first.cutoff);assert.equal(stopped.remaining_ms,first.remaining_ms-30_000);assert.equal(stopped.active.terminal_disposition,'deferred_unreviewed');
 const store=await createStore(f.config);try{assert.equal((await store.listWork('prepare_monthly')).find(w=>w.work_id==='monthly:2026-09')!.state,'pending');}finally{store.close();}
});
test('month selection follows actual start rather than an earlier frozen evidence cutoff',async t=>{
 const f=await setup(t),receipt=await f.cli(['--cutoff','2026-09-30T12:00:00.000Z']);assert.equal(receipt.active.month,'2026-09');assert.equal(receipt.cutoff,'2026-09-30T12:00:00.000Z');assert.equal(receipt.started_at,started);
});
test('calendar month selection explicitly uses configured timezone across a UTC month boundary',async()=>{
 const {previousMonth}=await import('../../src/monthly-round.ts');
 assert.equal(previousMonth('2026-10-01T00:30:00Z','America/Los_Angeles'),'2026-08');
 assert.equal(previousMonth('2026-10-01T00:30:00Z','Europe/Amsterdam'),'2026-09');
});

for(const mode of ['omitted','partial'] as const)test(`actual monthly CLI retains frozen unread page after accepted ${mode} chunk review`,async t=>{
 const f=await setup(t),first=await f.cli(),b:ReviewBundle=JSON.parse(await readFile(first.active.file,'utf8')),context=b.monthly_context!;
 assert.ok(b.chunks.length>0);
 const chunks=mode==='omitted'?[]:b.chunks.map(chunk=>({schema_version:1,chunk_id:chunk.chunk_id,status:'partial',reviewed_event_ids:[],zero_facts:false,reason:'Synthetic unread material'}));
 const review={schema_version:1,result_id:`monthly-incomplete:${mode}`,bundle_id:b.bundle_id,chunks,candidates:[],pages:[],created_at:started,monthly_review:{schema_version:1,month:first.active.month,summary:'Synthetic partial semantic note',fact_refs:[],supplement_text:'',coverage_status:'partial',completed_work_ids:[],completed_archive_context_ids:[]}};
 const input=join(f.output,'partial-result.json');await writeFile(input,JSON.stringify(review));
 const accepted=await f.cli(['--input',input]);assert.equal(accepted.state,'monthly_material_deferred');assert.equal(accepted.terminal,false);assert.equal(accepted.active.bundle_id,first.active.bundle_id);assert.deepEqual(accepted.active.facts_page,first.active.facts_page);assert.equal(accepted.active.accepted.result_id,review.result_id);
 const stored=JSON.parse(await readFile(f.manifest,'utf8')).monthly_round;assert.equal(stored.months[first.active.month].done,false);assert.equal(stored.months[first.active.month].facts_page,null);
 const store=await createStore(f.config);try{assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM fact_material_reads WHERE snapshot_id=?').get(context.facts_page!.snapshot_id)!.n,0);assert.equal((await store.listWork('prepare_monthly')).find(w=>w.work_id===`monthly:${first.active.month}`)!.state,'pending');}finally{store.close();}
 const again=await f.cli();assert.equal(again.state,'monthly_material_deferred');assert.equal(again.started_bundles,first.started_bundles);
});

test('actual monthly round cannot mark oversized frozen fact holes done after accepting visible chunks',async t=>{
 const f=await setup(t,120);let receipt=await f.cli(),steps=0;
 while(receipt.state==='monthly_review'&&steps++<20){
  const b:ReviewBundle=JSON.parse(await readFile(receipt.active.file,'utf8')),context=b.monthly_context!;
  const review={schema_version:1,result_id:`oversize-visible:${b.bundle_id}`,bundle_id:b.bundle_id,chunks:b.chunks.map(chunk=>({schema_version:1,chunk_id:chunk.chunk_id,status:'complete',reviewed_event_ids:[],zero_facts:true,reason:null})),candidates:[],pages:[],created_at:started,monthly_review:{schema_version:1,month:context.month,summary:'Synthetic complete review of visible material only',fact_refs:context.facts.map(f=>({schema_version:1,fact_id:f.fact_id,revision:f.revision})),supplement_text:'',coverage_status:'partial',completed_work_ids:context.prepared_work_ids??[],completed_archive_context_ids:[]}};
  const input=join(f.output,`oversize-${steps}.json`);await writeFile(input,JSON.stringify(review));receipt=await f.cli(['--input',input]);
 }
 assert.ok(steps<20,'A repeated oversized page becomes local unavailable, not an endless loop');
 const state=JSON.parse(await readFile(f.manifest,'utf8')).monthly_round,store=await createStore(f.config);try{
  let unreadMonths=0;for(const month of state.order){const snapshot=state.months[month].facts_page?.snapshot_id;if(!snapshot)continue;const reads=Number(store.db.prepare('SELECT COUNT(*) AS n FROM fact_material_reads WHERE snapshot_id=?').get(snapshot)!.n);if(reads<6){unreadMonths++;assert.equal(state.months[month].done,false);assert.equal((await store.listWork('prepare_monthly')).find(w=>w.work_id===`monthly:${month}`)!.state,'pending');}}
  assert.ok(unreadMonths>0,'The large synthetic fixture retains actual unread refs');
 }finally{store.close();}
});

test('saved monthly inspection exposes actual frozen facts and every whole archive context without allocating reads',async t=>{
 const f=await setup(t),receipt=await f.cli(),b:ReviewBundle=JSON.parse(await readFile(receipt.active.file,'utf8'));
 const {inspectReviewMaterial}=await import('../../src/review-material-inspection.ts');
 const originals=b.monthly_context!.archive_contexts;const before=JSON.stringify(b),facts=inspectReviewMaterial(b,'facts',0,1);assert.equal(facts.page.total,b.monthly_context!.facts.length);assert.equal((facts.items[0] as any).content,b.monthly_context!.facts[0].content);
 b.monthly_context!.archive_contexts=[0,1].map(i=>({schema_version:1,work_id:`synthetic-archive:${i}`,source_path:`wiki/personal/journals/日记_2026_09_0${i+1}.md`,date:`2026-09-0${i+1}`,original_digest:'a'.repeat(64),content_excerpt:`Synthetic complete archived original ${i}\n`,excerpt_reason:null,fact_refs:[]}));
 const archive=inspectReviewMaterial(b,'archive_contexts',0,1);assert.equal(archive.page.next_offset,1);assert.equal((archive.items[0] as any).content_excerpt,b.monthly_context!.archive_contexts[0].content_excerpt);assert.equal((inspectReviewMaterial(b,'archive_contexts',1,1).items[0] as any).work_id,'synthetic-archive:1');
 const summary:any=inspectReviewMaterial(b,'summary').items[0];assert.deepEqual(summary.monthly_context.facts_page,b.monthly_context!.facts_page);assert.deepEqual(summary.chunks.map((c:any)=>c.chunk_id),b.chunks.map(c=>c.chunk_id));
 const store=await createStore(f.config);try{assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM fact_material_reads').get()!.n,0);}finally{store.close();}
 b.monthly_context!.archive_contexts=originals;assert.equal(JSON.stringify(b),before);
});

for(const status of ['partial','deferred'] as const)test(`actual monthly CLI new run completes the same frozen page after accepted ${status} without rewriting prior acceptance`,async t=>{
 const f=await setup(t),first=await f.cli(),b:ReviewBundle=JSON.parse(await readFile(first.active.file,'utf8')),context=b.monthly_context!;
 const make=(packet:ReviewBundle,id:string,complete:boolean)=>({schema_version:1,result_id:id,bundle_id:packet.bundle_id,chunks:packet.chunks.map(chunk=>({schema_version:1,chunk_id:chunk.chunk_id,status:complete?'complete':status,reviewed_event_ids:[],zero_facts:complete,reason:complete?null:'Synthetic incomplete read'})),candidates:[],pages:[],created_at:started,monthly_review:{schema_version:1,month:packet.monthly_context!.month,summary:complete?'Synthetic later full review':'Synthetic earlier partial note',fact_refs:complete?packet.monthly_context!.facts.map(f=>({schema_version:1,fact_id:f.fact_id,revision:f.revision})):[],supplement_text:'',coverage_status:'partial',completed_work_ids:complete?packet.monthly_context!.prepared_work_ids??[]:[],completed_archive_context_ids:[]}});
 const earlier=make(b,`accepted-incomplete:${status}`,false),input=join(f.output,'earlier.json');await writeFile(input,JSON.stringify(earlier));
 const {acquireWikiLock}=await import('../../src/publish/lock.ts');const lock=await acquireWikiLock(f.config.wiki_root);assert.ok(lock);
 let accepted;try{accepted=await f.cli(['--input',input]);assert.equal(accepted.state,'monthly_material_deferred');await f.cli(['--finish','--reason','Preserve incomplete original run']);}finally{await lock.release();}
 const store=await createStore(f.config);const identity=await store.acceptedReviewIdentity(b.bundle_id),original=JSON.stringify((await store.getPublicationOutbox(identity!.batch_id))!.artifact);store.close();
 f.advance(7_200_000);const laterOutput=join(dirname(f.output),`later-${status}`),laterManifest=join(laterOutput,'manifest.json');
 const step=async(extra:string[]=[])=>{let out='',err='';const code=await runCli(['monthly-round','--manifest',laterManifest,'--output',laterOutput,'--config',join(dirname(f.config.wiki_root),'config.json'),...extra],{now:()=>new Date(Date.parse(started)+7_200_000).toISOString(),stdout:s=>out+=s,stderr:s=>err+=s});assert.equal(code,0,err);return JSON.parse(out);};
 const next=await step();assert.equal(next.state,'monthly_review');const frozen:ReviewBundle=JSON.parse(await readFile(next.active.file,'utf8'));assert.equal(frozen.monthly_context!.facts_page!.snapshot_id,context.facts_page!.snapshot_id);assert.equal(frozen.cutoff,b.cutoff);assert.notEqual(frozen.bundle_id,b.bundle_id,'Accepted incomplete material gets a new stable prepared attempt');assert.equal(frozen.monthly_context!.facts_page!.offset,context.facts_page!.offset);
 const full=make(frozen,`accepted-full:${status}`,true),fullInput=join(laterOutput,'full.json');await writeFile(fullInput,JSON.stringify(full));const advanced=await step(['--input',fullInput]);assert.equal(advanced.state,'monthly_review');assert.equal(advanced.active.month,'2026-08');
 const target=join(f.config.wiki_root,'wiki/personal/journals/reviews/回顾_2026_09.md');const newerBytes=await readFile(target);assert.ok(newerBytes.toString().includes('Synthetic later full review'));
 let replayOut='',replayErr='';const replayCode=await runCli(['publish','--input',input,'--config',join(dirname(f.config.wiki_root),'config.json')],{now:()=>new Date(Date.parse(started)+7_200_000).toISOString(),stdout:s=>replayOut+=s,stderr:s=>replayErr+=s});assert.equal(replayCode,0,replayErr);assert.equal(JSON.parse(replayOut).fact_commit,'already_committed');assert.deepEqual(await readFile(target),newerBytes,'Stale accepted partial recovery must preserve later complete monthly bytes even with equal model timestamps');
 const current=await createStore(f.config);try{assert.equal(JSON.stringify((await current.getPublicationOutbox(identity!.batch_id))!.artifact),original);const progress=await current.factMaterialProgress!(context.facts_page!.snapshot_id);assert.equal(progress!.first_unread_offset,context.facts_page!.next_offset);assert.equal(current.db.prepare('SELECT COUNT(*) AS n FROM results WHERE id IN (?,?)').get(earlier.result_id,full.result_id)!.n,2);}finally{current.close();}
});
for(const mode of ['missing','wrong_snapshot'] as const)test(`monthly round retains accepted page when exact frozen progress is ${mode}`,async t=>{
 const f=await setup(t),first=await f.cli(),b:ReviewBundle=JSON.parse(await readFile(first.active.file,'utf8')),context=b.monthly_context!;
 const review={schema_version:1,result_id:`proof-unavailable:${mode}`,bundle_id:b.bundle_id,chunks:b.chunks.map(chunk=>({schema_version:1,chunk_id:chunk.chunk_id,status:'complete',reviewed_event_ids:[],zero_facts:true,reason:null})),candidates:[],pages:[],created_at:started,monthly_review:{schema_version:1,month:context.month,summary:'Synthetic complete visible page',fact_refs:context.facts.map(f=>({schema_version:1,fact_id:f.fact_id,revision:f.revision})),supplement_text:'',coverage_status:'partial',completed_work_ids:[],completed_archive_context_ids:[]}};
 const input=join(f.output,'proof-result.json');await writeFile(input,JSON.stringify(review));const {createRuntime}=await import('../../src/runtime.ts');let out='',err='';let exact:string|null=null;
 const code=await runCli(['monthly-round','--manifest',f.manifest,'--output',f.output,'--config',join(dirname(f.config.wiki_root),'config.json'),'--input',input],{now:()=>started,createRuntime:async(...args)=>{const services=await createRuntime(...args);services.store.factMaterialProgress=async id=>{exact=id;return mode==='missing'?null:{schema_version:1,snapshot_id:'another-newer-snapshot',cutoff:context.facts_page!.cutoff,total:context.facts_page!.total,first_unread_offset:null,pending_work_count:0,pending_archive_context_count:0};};services.store.monthlySemanticStatus=async()=>{throw new Error('Latest monthly debt cannot prove active snapshot read');};return services;},stdout:s=>out+=s,stderr:s=>err+=s});
 assert.equal(code,0,err);const receipt=JSON.parse(out);assert.equal(exact,context.facts_page!.snapshot_id);assert.equal(receipt.state,'monthly_material_deferred');assert.equal(receipt.active.bundle_id,first.active.bundle_id);assert.equal(receipt.active.accepted.result_id,review.result_id);const state=JSON.parse(await readFile(f.manifest,'utf8')).monthly_round;assert.equal(state.months[context.month].done,false);assert.equal(state.months[context.month].facts_page,null);
});
