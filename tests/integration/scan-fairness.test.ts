import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createStore } from '../../src/store/index.ts';
import { runDailyRound } from '../../src/daily-round.ts';
import { PERSONAL_DAILY_ROUND_LIMITS } from '../../src/config.ts';
import { config as cfg,bundle,event,range } from '../store/fixtures.ts';
import type { RuntimeServices, Lane } from '../../src/contracts/types.ts';
async function fixture(t:test.TestContext){
 const config=await cfg(),root=dirname(config.wiki_root);t.after(()=>rm(root,{recursive:true,force:true}));
 config.providers=[{schema_version:1,provider:'synthetic',enabled:true,account_id:'self',roots:[],options:{}}];config.daily_round_limits={...PERSONAL_DAILY_ROUND_LIMITS};
 const now=()=>new Date('2026-10-06T12:00:00Z'),store=await createStore(config,{now});t.after(()=>store.close());
 const output=join(root,'round');await mkdir(output,{mode:0o700});const manifest=join(output,'manifest.json');const calls:Lane[]=[];let ready:Lane|undefined,sequence=0;
 const receipt={schema_version:1 as const,result_id:null,fact_commit:'pending' as const,batch_id:null,export_status:'pending' as const,files:[],consumers:[],pending:[]};
 const services:RuntimeServices={store,adapters:[],consumers:[],publisher:{publish:async()=>receipt,resume:async()=>receipt,exportFacts:async()=>({ready:[],pending:[]}),applyPatches:async()=>[]},reviewer:{prepare:async()=>[],accept:async()=>{throw new Error('No acceptance requested');},prepareWithOutcomes:async request=>{
  calls.push(request.lane);sequence++;const scope={schema_version:1 as const,source:'synthetic',lane:request.lane,range,cutoff:request.cutoff,selection_basis:'event_time' as const};
  const b=bundle([event(`ready:${sequence}`)],`bundle:${sequence}`);b.source='synthetic';b.lane=request.lane;b.cutoff=request.cutoff;
  return {schema_version:1,bundles:request.lane===ready?[b]:[],providers:[{schema_version:1,provider:'synthetic',stage:'prepare',execution_status:'partial',reason:'Synthetic bounded stage',bundle_ids:request.lane===ready?[b.bundle_id]:[],preparation:{schema_version:1,state:request.lane===ready?'ready':'more',scope,continuation:{schema_version:1,scope,cursor:`rotating-opaque:${sequence}`},scanned:{pages:1,rows:1,elapsed_ms:6000},deferred_units:[],progress:{schema_version:1,phase:'facts',frontier:`fixed:${request.lane}`,advanced:false,stages:[{schema_version:1,phase:'facts',rows:0,elapsed_ms:6000}]}}}]};
 }}};
 const call=()=>runDailyRound({output,manifest},config,services,{now,collect:async()=>({capture_status:'unknown'})});
 await call();const saved=JSON.parse(await readFile(manifest,'utf8'));saved.daily_round.active=null;saved.daily_round.phase='review';saved.daily_round.initial_settled=true;saved.daily_round.capture_index=2;saved.daily_round.bootstrap_attempted={live:['synthetic'],history:['synthetic']};saved.daily_round.allocation_cursor=2;saved.daily_round.scan_cursor=2;saved.daily_round.continuations={};saved.daily_round.scan_progress={};saved.daily_round.blocked={live:[],history:[]};await writeFile(manifest,JSON.stringify(saved));calls.length=0;
 return {call,calls,store,manifest,ready:(lane:Lane)=>{ready=lane;},position:async(value:number)=>{const s=JSON.parse(await readFile(manifest,'utf8'));s.daily_round.scan_cursor=value;await writeFile(manifest,JSON.stringify(s));}};
}
test('history more yields a live opportunity without consuming starts or resetting original clock',async t=>{
 const f=await fixture(t);f.ready('live');const first=await f.call();assert.equal(first.state,'prepare_more');assert.equal(first.started_bundles,0);
 const second=await f.call();assert.equal(second.state,'review');assert.deepEqual(f.calls,['history','live']);assert.equal(second.started_bundles,1);assert.equal(second.started_at,first.started_at);assert.equal(second.cutoff,first.cutoff);
});
test('live more also yields history and rotating token alone blocks locally at three identical real frontiers',async t=>{
 const f=await fixture(t);await f.position(0);f.ready('history');await f.call();await f.call();const ready=await f.call();assert.equal(ready.state,'review');assert.deepEqual(f.calls,['live','live','history']);
 const g=await fixture(t);let outcome:any;for(let i=0;i<12;i++){outcome=await g.call();if(outcome.terminal)break;}
 const saved=JSON.parse(await readFile(g.manifest,'utf8')).daily_round;
 assert.deepEqual(saved.exhausted,{live:[],history:[]});assert.deepEqual(saved.blocked,{live:['synthetic'],history:['synthetic']});assert.equal(saved.started_bundles,0);assert.equal(outcome.terminal,true);assert.equal(outcome.review_status,'partial');assert.equal(saved.scan_progress['synthetic:history'].stalled,3);assert.equal(saved.scan_progress['synthetic:live'].stalled,3);
 assert.equal(g.store.db.prepare('SELECT COUNT(*) AS n FROM reviewed_sources').get()!.n,0);
});
