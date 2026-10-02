import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../src/store/index.ts';
import { config, bundle, collection, event, result } from './fixtures.ts';

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
test('partial review schedules only accepted event dates and slices, excluding unread context and held candidates', async () => {
 const s=await createStore(await config());try {
 const events=[event('one','first','2026-09-02T09:00:00Z'),event('two','unread','2026-09-29T09:00:00Z')];const b=bundle(events);b.coverage[0].query_range=broad;b.chunks[0].context_events=[event('context','old','1980-01-01T12:00:00Z')];await s.saveCollection(collection(events));await s.saveBundle(b);
 const r=result(b,'partial',false);r.chunks[0]={...r.chunks[0],status:'partial',reviewed_event_ids:['one'],reason:'second unread'};await s.commitReview(r);const a=(await s.listOutbox())[0].artifact;
 assert.deepEqual(a.affected_dates,['2026-09-02']);assert.deepEqual(a.affected_weeks,['2026-08-31']);assert.deepEqual(a.affected_months,['2026-09']);
 }finally{s.close();}
});
test('explicit-empty review schedules only typed bounded historical range and never expands coverage', async () => {
 const s=await createStore(await config());try {
 const b=bundle([]);b.chunks[0].chunk_id='empty:bounded';b.coverage[0].query_range=broad;b.review_range={schema_version:1,from:'2026-08-31T16:00:00Z',to:'2026-09-02T16:00:00Z'};b.review_timezone='Asia/Shanghai';await s.saveBundle(b);await s.commitReview(result(b,'bounded',false));
 const a=(await s.listOutbox())[0].artifact;assert.deepEqual(a.affected_dates,['2026-09-01','2026-09-02']);assert.deepEqual(a.affected_months,['2026-09']);assert.deepEqual(a.affected_weeks,['2026-08-31']);
 const old=bundle([],'old-empty');old.coverage[0].query_range=broad;await s.saveBundle(old);await s.commitReview(result(old,'old',false));assert.deepEqual((await s.listOutbox())[1].artifact.affected_dates,[]);
 const large=bundle([],'large-empty');large.review_range=broad;await s.saveBundle(large);await s.commitReview(result(large,'large',false));assert.deepEqual((await s.listOutbox())[2].artifact.affected_months,[]);assert.equal((await s.listWork('review_period','pending')).length,1);
 }finally{s.close();}
});
