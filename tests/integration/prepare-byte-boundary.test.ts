import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,rm,mkdir} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {createStore,canonical} from '../../src/store/index.ts';
import {createReviewer} from '../../src/review/index.ts';
import {executeCommand} from '../../src/cli.ts';
import {runDailyRound} from '../../src/daily-round.ts';
import {PERSONAL_DAILY_ROUND_LIMITS} from '../../src/config.ts';
import {config,event,collection,value} from '../store/fixtures.ts';
import type {RuntimeServices,ReviewBundle} from '../../src/contracts/types.ts';

const cutoff='2026-10-06T17:08:52Z',range={schema_version:1 as const,from:'2026-09-09T22:00:00Z',to:cutoff};
async function fixture(t:test.TestContext,padding=57){
 const c=await config(),root=dirname(c.data_dir);c.limits.bundles_per_round=1;
 const s=await createStore(c);t.after(async()=>{s.close();await rm(root,{recursive:true,force:true});});
 const e=event('eligible','x'.repeat(padding),'2026-09-10T09:00:00Z'),batch=collection([e],'history');
 batch.coverage=Array.from({length:400},(_,i)=>({...batch.coverage[0],coverage_id:'scope:'+i,query_range:range,cutoff,capture_status:'partial' as const,gaps:[{schema_version:1 as const,range,reason:'Unread synthetic prefix '+'.'.repeat(100),locator:'/synthetic/'+i,resumable:true}]}));await s.saveCollection(batch);
 for(let i=0;i<200;i++){const f={schema_version:1,fact_id:'fact:'+i,revision:1,event_refs:[],content:'Synthetic existing accepted fact '+'.'.repeat(69),subject:'Synthetic person',occurred_at:value('2026-09-15T09:00:00Z'),journal_date:value('2026-09-15'),kind:'legacy_record',analytics_projection:{schema_version:1,value:null,reason:'No projection'},action:'assert',target_refs:[],scope:[],attribution:{},recorded_at:'2026-09-20T00:00:00Z'};s.db.prepare('INSERT INTO facts VALUES(?,?,?,?)').run(f.fact_id,f.revision,canonical(f),f.recorded_at);}
 const reviewer=createReviewer(s,c),request={kind:'daily' as const,lane:'history' as const,source:'synthetic',range,cutoff,max_bundles:1};
 const prepared=await reviewer.prepareWithOutcomes!(request),bundle=prepared.bundles[0];assert(bundle);
 // The bounded pipeline intentionally omits unrelated global context. Calibrate a disclosed
 // synthetic gap in a separate saved fixture to test the CLI's exact byte boundary itself.
 const target=131072+padding-57;bundle.bundle_id+=`:byte-fixture:${target}`;bundle.unfinished.push({schema_version:1,range:null,reason:'Synthetic boundary padding ',locator:null,resumable:true});
 const missing=target-Buffer.byteLength(JSON.stringify(bundle));assert.ok(missing>=0);bundle.unfinished.at(-1)!.reason+='.'.repeat(missing);await s.saveBundle(bundle);
 const services={store:s,reviewer:{...reviewer,prepareWithOutcomes:async()=>prepared}} as RuntimeServices;
 const output=join(root,'output');
 const command=()=>executeCommand({command:'prepare',options:{kind:'daily',lane:'history',source:'synthetic',from:range.from,to:range.to,cutoff,'max-bundles':'1',output}},c,services,cutoff) as Promise<any>;
 return {c,s,root,output,bundle,prepared,services,command};
}
test('exact128KiB Reviewer material survives standalone CLI publication and immutable retry without review progress',async t=>{
 const f=await fixture(t);assert.equal(Buffer.byteLength(canonical(f.bundle)),131072);assert.equal(Buffer.byteLength(JSON.stringify(f.bundle)),131072);
 const first=await f.command();assert.equal(first.bundles.length,1);assert.equal(first.providers.find((p:any)=>p.stage==='material').execution_status,'complete');
 const path=join(f.output,first.bundles[0]),bytes=await readFile(path);assert.equal(bytes.length,131072);assert.notEqual(bytes.at(-1),10);assert.deepEqual(JSON.parse(bytes.toString()),f.bundle);
 assert.deepEqual((await f.command()).bundles,first.bundles);assert.deepEqual(await readFile(path),bytes);assert.equal(f.s.getReviewedUnits('daily','history').size,0);assert.equal(f.s.db.prepare('SELECT count(*) n FROM results').get()!.n,0);
});
test('below-bound material retains LF and above-bound Reviewer output stays pending',async t=>{
 const f=await fixture(t,56);assert.equal(Buffer.byteLength(JSON.stringify(f.bundle)),131071);
 const first=await f.command(),bytes=await readFile(join(f.output,first.bundles[0]));assert.equal(bytes.length,131072);assert.equal(bytes.at(-1),10);
 const oversized:ReviewBundle=structuredClone(f.bundle);oversized.unfinished[0].reason+='xx';f.prepared.bundles=[oversized];
 const failed=await f.command();assert.deepEqual(failed.bundles,[]);assert.equal(failed.providers.find((p:any)=>p.stage==='material').execution_status,'partial');assert.equal(f.s.getReviewedUnits('daily','history').size,0);
});
test('daily-round exposes an exact-bound source bundle instead of skipping its unreviewed units',async t=>{
 const f=await fixture(t),output=join(f.root,'round');await mkdir(output,{mode:0o700});
 f.c.daily_round_limits={...PERSONAL_DAILY_ROUND_LIMITS,wave_bundles:2,live_bundles:1,history_bundles:1,max_started_bundles:2};
 f.services.reviewer.prepareWithOutcomes=async request=>request.lane==='live'?{schema_version:1,bundles:[],providers:[]}:f.prepared;
 f.services.publisher={resume:async()=>({schema_version:1,result_id:null,batch_id:null,fact_commit:'already_committed',export_status:'ready',files:[],consumers:[],pending:[]})} as RuntimeServices['publisher'];
 f.services.consumers=[];
 const step=()=>runDailyRound({manifest:join(output,'manifest.json'),output,cutoff},f.c,f.services,{now:()=>new Date(cutoff),collect:async()=>({schema_version:1})});
 const empty=await step();assert.equal(empty.state,'prepare_more');assert.equal(empty.started_bundles,0);
 const initial=JSON.parse(await readFile(join(output,'manifest.json'),'utf8')).daily_round;assert.deepEqual(initial.exhausted,{live:[],history:[]});
 const receipt=await step();
 assert.equal(receipt.state,'review');assert.equal(receipt.started_bundles,1);const active=receipt.active;assert(active?.kind==='source');const bytes=await readFile(active.file);assert.equal(bytes.length,131072);assert.notEqual(bytes.at(-1),10);
 assert.equal(f.s.getReviewedUnits('daily','history').size,0);
 const persisted=JSON.parse(await readFile(join(output,'manifest.json'),'utf8')).daily_round;assert.deepEqual(persisted.skip_units,[]);
});
