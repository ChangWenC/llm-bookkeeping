import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, canonical } from '../../src/store/index.ts';
import { createReviewer } from '../../src/review/index.ts';
import { config, event, collection, range, value, result } from '../store/fixtures.ts';
import type { FactRevision } from '../../src/contracts/types.ts';

async function repeatedCoverage() {
 const c=await config();c.providers=[{schema_version:1,provider:'wechat',account_id:'9007199254740993',roots:[],enabled:true,options:{group_allowlist:[],chat_types:{'chat:1':'private'}}}];
 const s=await createStore(c),e=event('eligible');e.source.provider='wechat';e.context={identity_verified:true,is_group:false,sender_id:'wxid_known',sender_wxid:'wxid_known'};
 for(let round=0;round<4;round++) {
  const batch=collection([e],'history','round:'+round);batch.coverage=Array.from({length:100},(_,i)=>({...batch.coverage[0],coverage_id:'repeat:'+round+':'+i,provider:'wechat',query_range:{schema_version:1,from:'1970-01-01T00:00:00Z',to:range.to},capture_status:'partial',gaps:[{schema_version:1,range,reason:'Unread frozen source prefix '+'.'.repeat(100),locator:'/synthetic/'+round+'/'+i,resumable:true}]}));await s.saveCollection(batch);
 }
 for(let i=0;i<200;i++) {
  const fact:FactRevision={schema_version:1,fact_id:'fact:'+i,revision:1,event_refs:[],content:'Synthetic original accepted context '+'.'.repeat(69),subject:'Roy',occurred_at:value('2026-09-15T09:00:00Z'),journal_date:value('2026-09-15'),kind:'legacy_record',analytics_projection:{schema_version:1,value:null,reason:'No projection'},action:'assert',target_refs:[],scope:[],attribution:{},recorded_at:'2026-09-20T00:00:00Z'};
  s.db.prepare('INSERT INTO facts VALUES(?,?,?,?)').run(fact.fact_id,fact.revision,canonical(fact),fact.recorded_at);
 }
 return {c,s,e};
}
const request={kind:'daily' as const,lane:'history' as const,source:'wechat',range,cutoff:range.to,max_bundles:1};
test('repeated frozen partial coverage cannot crowd eligible source events out of the final default-budget bundle',async()=>{
 const {c,s,e}=await repeatedCoverage();try {
 const rows=s.db.prepare('SELECT * FROM coverage ORDER BY id').all(),facts=s.db.prepare('SELECT * FROM facts ORDER BY id,revision').all();const reviewer=createReviewer(s,c),first=await reviewer.prepareWithOutcomes!(request);
 assert.notEqual(first.providers[0].execution_status,'unavailable',first.providers[0].reason ?? '');assert.equal(first.bundles.length,1);const b=first.bundles[0];assert(Buffer.byteLength(canonical(b))<=131072);assert.equal(c.limits.bundle_bytes,131072);assert.deepEqual(b.chunks.flatMap(chunk=>chunk.events.map(event=>event.event_id)),[e.event_id]);assert.equal(b.existing_facts.length,0,'Unrelated September15 history is not loaded for September30 units');assert(b.coverage.length<=64);assert(b.coverage.every(coverage=>coverage.capture_status==='partial' && coverage.review_status==='pending'));assert(b.unfinished.some(gap=>gap.reason.includes('Bounded preparation metadata omitted')));
 const again=await reviewer.prepareWithOutcomes!(request);assert.deepEqual(again.bundles,first.bundles);assert.deepEqual(s.db.prepare('SELECT * FROM coverage ORDER BY id').all(),rows);assert.deepEqual(s.db.prepare('SELECT * FROM facts ORDER BY id,revision').all(),facts);assert.equal(s.getReviewedUnits('daily','history').size,0);
 await reviewer.accept(result(b,'review-actual-only',false));assert.deepEqual((await s.listOutbox())[0].artifact.affected_dates,['2026-09-30']);assert((await s.listCoverage(range)).every(coverage=>coverage.capture_status==='partial' && coverage.gaps.length===1));assert.deepEqual(s.db.prepare('SELECT * FROM facts ORDER BY id,revision').all(),facts);
 }finally{s.close();}
});
