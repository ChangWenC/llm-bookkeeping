import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, digest } from '../../src/store/index.ts';
import { config, event, collection } from './fixtures.ts';
import type { SourceEvent } from '../../src/contracts/types.ts';
function unknown():SourceEvent {const e=event('stable-native-missing-time');e.source.provider='codex';e.original_time={schema_version:1,value:null,reason:'Native timestamp absent'};e.utc_time={schema_version:1,value:null,reason:'Native timestamp absent'};e.journal_date={schema_version:1,value:null,reason:'Native timestamp absent'};return e;}
function capture(e:SourceEvent,lane:'live'|'history',round:string) {const b=collection([e],lane,round);b.coverage[0].provider='codex';b.coverage[0].capture_status='partial';b.coverage[0].gaps=[{schema_version:1,range:null,locator:e.locator,reason:'Timestamp unresolved',resumable:true}];b.checkpoints[0].provider='codex';return b;}
test('stable unknown source work survives live to frozen history recapture across six rounds without changing identity or existing work',async()=>{
 const s=await createStore(await config());try {
 const e=unknown();await s.saveCollection(capture(e,'live','live-first'));const work=(await s.listWork('event_identity_time','pending'))[0],liveCheckpoint=await s.getCheckpoints('codex','live');assert.equal(work.lane,'live');
 for(let round=0;round<6;round++){const b=capture(e,'history','history:'+round);await s.saveCollection(b);await s.saveCollection(b);assert.deepEqual(await s.listWork('event_identity_time'),[work]);assert.deepEqual(await s.getCheckpoints('codex','live'),liveCheckpoint);assert.equal((await s.status()).events,1);}
 assert.deepEqual(s.db.prepare('SELECT lane FROM event_lanes ORDER BY lane').all().map(row=>row.lane),['history','live']);assert.equal(s.getReviewedUnits('daily','history').size,0);assert.equal((await s.status()).facts,0);assert.equal((await s.status()).results,0);
 const known=event(e.event_id);known.source.provider='codex';await s.saveCollection(capture(known,'history','known-enrichment'));const resolved=(await s.listWork('event_identity_time'))[0];assert.equal(resolved.work_id,work.work_id);assert.equal(resolved.lane,work.lane);assert.deepEqual(resolved.payload,work.payload);assert.equal(resolved.state,'complete');assert.equal((await s.status()).events,1);
 }finally{s.close();}
});
test('source work lane reuse never admits a conflicting payload or kind and failed capture remains atomic',async()=>{
 for(const kind of ['payload','kind']) {const s=await createStore(await config());try {
 const e=unknown();await s.enqueueWork({schema_version:1,work_id:'event-gap:'+digest(e.event_id),kind:kind==='kind'?'unrelated_kind':'event_identity_time',lane:'live',state:'pending',payload:{event_id:kind==='payload'?'another-event':e.event_id},reason:'Synthetic conflicting work',migration_key:null,updated_at:'2026-09-30T00:00:00Z'});const prior=await s.listWork();await assert.rejects(s.saveCollection(capture(e,'history','conflicting-capture')),/Work identity conflict/);assert.deepEqual(await s.listWork(),prior);assert.equal((await s.status()).events,0);assert.deepEqual(await s.getCheckpoints('codex','history'),[]);
 }finally{s.close();}}
});
