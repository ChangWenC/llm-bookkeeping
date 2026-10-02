import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../src/store/index.ts';
import { config, bundle, collection, event, result, candidate } from './fixtures.ts';

const broad = { schema_version: 1 as const, from: '1970-01-01T00:00:00Z', to: '2026-10-01T00:00:00Z' };
test('page-only metadata review with broad capture coverage schedules no business periods and accepted retry stays immutable', async () => {
 const s=await createStore(await config());try {
 const b=bundle();b.coverage[0].query_range=broad;b.coverage[0].read_ranges=[broad];b.review_range={schema_version:1,from:'2026-09-01T00:00:00Z',to:'2026-10-01T00:00:00Z'};
 await s.saveBundle(b);const r={...result(b,'meta-only',false),chunks:[],pages:[{schema_version:1 as const,suggestion_id:'schema',date:'2026-09-30',path:b.baselines[0].path,baseline_digest:'absent',mode:'append' as const,old_text:null,new_text:'Synthetic metadata',candidate_ids:[]}]};
 const accepted=await s.commitReview(r);const a=(await s.listOutbox())[0].artifact;
 assert.deepEqual(a.affected_dates,[]);assert.deepEqual(a.affected_weeks,[]);assert.deepEqual(a.affected_months,[]);assert.equal(accepted.patches.length,1);assert.deepEqual(accepted.facts,[]);
 assert.equal((await s.commitReview({...r,result_id:'retry'})).reused,true);assert.deepEqual((await s.listOutbox())[0].artifact,a);
 } finally{s.close();}
});
test('partial review schedules only accepted event dates and slices, excluding unread context', async () => {
 const s=await createStore(await config());try {
 const events=[event('one','first','2026-09-02T09:00:00Z'),event('two','unread','2026-09-29T09:00:00Z')];const b=bundle(events);b.coverage[0].query_range=broad;b.chunks[0].context_events=[event('context','old','1980-01-01T12:00:00Z')];await s.saveCollection(collection(events));await s.saveBundle(b);
 const r=result(b,'partial',false);r.chunks[0]={...r.chunks[0],status:'partial',reviewed_event_ids:['one'],reason:'second unread'};await s.commitReview(r);const a=(await s.listOutbox())[0].artifact;
 assert.deepEqual(a.affected_dates,['2026-09-02']);assert.deepEqual(a.affected_weeks,['2026-08-31']);assert.deepEqual(a.affected_months,['2026-09']);
 }finally{s.close();}
});
test('explicit-empty review schedules only typed bounded historical range and never expands coverage', async () => {
 const s=await createStore(await config());try {
 const b=bundle([]);b.chunks[0].chunk_id='empty:bounded';b.coverage[0].query_range=broad;b.review_range={schema_version:1,from:'2026-08-31T16:00:00Z',to:'2026-09-02T16:00:00Z'};b.review_timezone='Asia/Shanghai';await s.saveBundle(b);await s.commitReview(result(b,'bounded',false));
 const a=(await s.listOutbox())[0].artifact;assert.deepEqual(a.affected_dates,['2026-09-01','2026-09-02']);assert.deepEqual(a.affected_months,['2026-09']);assert.deepEqual(a.affected_weeks,['2026-08-31']);assert.equal(a.coverage[0].review_status,'pending');
 const old=bundle([],'old-empty');old.coverage[0].query_range=broad;await s.saveBundle(old);await s.commitReview(result(old,'old',false));assert.deepEqual((await s.listOutbox())[1].artifact.affected_dates,[]);
 const large=bundle([],'large-empty');large.review_range=broad;await s.saveBundle(large);await s.commitReview(result(large,'large',false));assert.deepEqual((await s.listOutbox())[2].artifact.affected_months,[]);assert.equal((await s.listWork('review_period','pending')).length,1);
 }finally{s.close();}
});

test('mixed empty and unread nonempty chunks cannot expand a bounded source period',async()=>{
 const s=await createStore(await config());try {
 const b=bundle([event('unread','pending','2026-09-29T09:00:00Z')]);b.chunks.unshift({schema_version:1,chunk_id:'empty:mixed',events:[],context_events:[],body_bytes:0});b.review_range={schema_version:1,from:'2026-09-01T00:00:00Z',to:'2026-10-01T00:00:00Z'};await s.saveBundle(b);const r=result(b,'mixed',false);r.chunks=r.chunks.slice(0,1);await s.commitReview(r);assert.deepEqual((await s.listOutbox())[0].artifact.affected_dates,[]);
 }finally{s.close();}
});

test('accepted source slice dates affect periods while unresolved candidate evidence remains pending',async()=>{
 const s=await createStore(await config());try {
 const original=event('source','abcdefghij','2026-09-02T09:00:00Z'),held=event('held','unknown attribution','2026-09-29T09:00:00Z');await s.saveCollection(collection([original,held]));const slice={...original,event_id:'slice:synthetic',body:'abcd',context:{review_slice:{source_event_id:original.event_id,start_byte:0,end_byte:4,total_bytes:10}}},b=bundle([slice,held]);b.coverage[0].query_range=broad;await s.saveBundle(b);
 const r=result(b,'slice-held',false);r.chunks[0].zero_facts=false;r.candidates=[{...candidate(b),event_refs:[{schema_version:1,event_id:held.event_id}],analytics_projection:{schema_version:1,value:null,reason:'unknown attribution'},attribution:{subject_known:false}}];await s.commitReview(r);
 const a=(await s.listOutbox())[0].artifact;assert.deepEqual(a.affected_dates,['2026-09-02']);assert.deepEqual(a.facts,[]);assert.equal((await s.listWork('review_candidate','pending')).length,1);assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM reviewed_spans WHERE source_id=?').get(original.event_id)!.n,2);assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM reviewed_sources WHERE source_id=?').get(original.event_id)!.n,0);assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM reviewed_units WHERE event_id=?').get(held.event_id)!.n,0);
 }finally{s.close();}
});
