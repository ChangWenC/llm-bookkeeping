import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {createStore} from '../../src/store/index.ts';
import {createReviewer} from '../../src/review/index.ts';
import {runDailyRound} from '../../src/daily-round.ts';
import {PERSONAL_DAILY_ROUND_LIMITS} from '../../src/config.ts';
import {config as fixtureConfig,event,collection} from '../store/fixtures.ts';
import type {PrepareRequest,RuntimeServices,PreparationResult} from '../../src/contracts/types.ts';

test('repeated over-budget selected hydration blocks only the stalled pair, keeps units unread, and permits a ready peer',async t=>{
 const config=await fixtureConfig(),root=dirname(config.wiki_root);t.after(()=>rm(root,{recursive:true,force:true}));
 config.daily_round_limits={...PERSONAL_DAILY_ROUND_LIMITS};
 const now=()=>new Date('2026-09-30T12:00:00.000Z'),store=await createStore(config,{now});t.after(()=>store.close());
 await store.saveCollection(collection([event('old-unread','Old synthetic user unit','2026-09-28T09:00:00.000Z')],'history','old'));
 await store.saveCollection(collection([event('peer-unread','New synthetic user unit')],'live','peer'));
 const reviewer=createReviewer(store,config),output=join(root,'round'),manifest=join(output,'manifest.json');await mkdir(output,{mode:0o700});
 let clock=0,slow=false,peerReady=false,peerSequence=0,historyRequest:PrepareRequest|undefined;
 const selected=store.getSelectedReviewEvents.bind(store),page=store.getReviewCandidatePage.bind(store);
 store.getSelectedReviewEvents=(...args)=>{const rows=selected(...args);if(slow)clock+=6000;return rows;};
 store.getReviewCandidatePage=(...args)=>{const rows=page(...args);if(slow)clock+=6000;return rows;};
 t.mock.method(performance,'now',()=>clock);
 const receipt={schema_version:1 as const,result_id:null,fact_commit:'pending' as const,batch_id:null,export_status:'pending' as const,files:[],consumers:[],pending:[]};
 const services:RuntimeServices={store,adapters:[],consumers:[],publisher:{publish:async()=>receipt,resume:async()=>receipt,exportFacts:async()=>({ready:[],pending:[]}),applyPatches:async()=>[]},reviewer:{...reviewer,prepareWithOutcomes:async request=>{
  clock=0;slow=request.lane==='history';
  if(request.lane==='history')historyRequest=request;
  if(request.lane==='live'&&!peerReady){
   peerSequence++;const scope={schema_version:1 as const,source:request.source!,lane:request.lane,range:{schema_version:1 as const,from:config.live_start,to:request.cutoff},cutoff:request.cutoff,selection_basis:'event_time' as const};
   return {schema_version:1,bundles:[],providers:[{schema_version:1,provider:request.source!,stage:'prepare',execution_status:'partial',reason:'Synthetic peer context continues',bundle_ids:[],preparation:{schema_version:1,state:'more',scope,continuation:null,scanned:{pages:0,rows:0,elapsed_ms:0},deferred_units:[],progress:{schema_version:1,phase:'coverage',frontier:'peer-progress:'+peerSequence,advanced:true,stages:[]}}}]} as PreparationResult;
  }
  return reviewer.prepareWithOutcomes!(request);
 }}};
 const call=()=>runDailyRound({output,manifest},config,services,{now,collect:async()=>({capture_status:'unknown'})});
 await call();let saved=JSON.parse(await readFile(manifest,'utf8'));
 Object.assign(saved.daily_round,{active:null,phase:'review',initial_settled:true,capture_index:2,bootstrap_attempted:{live:['synthetic'],history:['synthetic']},allocation_cursor:2,scan_cursor:2,continuations:{},scan_progress:{},blocked:{live:[],history:[]}});
 await writeFile(manifest,JSON.stringify(saved));
 const started=saved.daily_round.started_at,cutoff=saved.daily_round.cutoff,frontiers:string[]=[];
 for(let attempt=0;attempt<16;attempt++){
  const response=await call();
  if(response.lane==='history'){
   const preparation=(response as any).preparation;assert.equal(preparation.state,'more');assert.equal(preparation.scanned.elapsed_ms>=6000,true);frontiers.push(preparation.progress.frontier);
  }
  if(response.state==='prepare_blocked')break;
 }
 saved=JSON.parse(await readFile(manifest,'utf8')).daily_round;
 assert.deepEqual(saved.blocked,{live:[],history:['synthetic']});assert.deepEqual(saved.exhausted,{live:[],history:[]});
 assert.equal(saved.started_bundles,0);assert.equal(saved.scan_progress['synthetic:history'].stalled,3);
 assert.equal(frontiers.length,4);assert.equal(new Set(frontiers).size,1);
 assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM reviewed_sources').get()!.n,0);
 assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM reviewed_spans').get()!.n,0);
 peerReady=true;const peer=await call();assert.equal(peer.state,'review');assert.equal((peer.active as {lane:string}).lane,'live');assert.equal(peer.started_bundles,1);assert.equal(peer.started_at,started);assert.equal(peer.cutoff,cutoff);
 // Clearing the simulated atomic delay allows the original exact history continuation to finish;
 // no review mark or fake exhaustion was needed to obtain the peer opportunity.
 slow=false;clock=0;
 const restored=await reviewer.prepareWithOutcomes!({...historyRequest!,candidate_continuation:saved.continuations['synthetic:history']});
 assert.equal(restored.providers[0].preparation!.state,'ready');assert.equal(restored.bundles[0].chunks[0].events[0].event_id,'old-unread');
 assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM reviewed_sources').get()!.n,0);
});
