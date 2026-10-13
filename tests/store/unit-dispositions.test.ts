import test from 'node:test';
import assert from 'node:assert/strict';
import {createStore} from '../../src/store/index.ts';
import {exactReviewUnit} from '../../src/store/unit-dispositions.ts';
import {createReviewer} from '../../src/review/index.ts';
import {config,event,collection,bundle,result,value} from './fixtures.ts';

test('a same-chunk unrelated fact cannot silently complete the primary user clarification',async()=>{
 const c=await config(),s=await createStore(c),clarification=event('clarification','明确国内结论；上文合法W只是猜测'),other=event('other','Unrelated parser verification'),b=bundle([clarification,other]);await s.saveCollection(collection([clarification,other]));await s.saveBundle(b);
 const r=result(b);r.candidates[0].event_refs=[{schema_version:1,...exactReviewUnit(other)}];r.candidates[0].analytics_projection={schema_version:1,value:null,reason:'Synthetic'};r.unit_dispositions=[];
 await assert.rejects(s.commitReview(r),/Primary unit lacks/);assert.equal((await s.listOutbox()).length,0);assert.equal(s.getReviewedUnits('daily','live').size,0);
 r.unit_dispositions=[{schema_version:1,units:[exactReviewUnit(clarification)],disposition:'defer',fact_refs:[],reason:'Clarification requires its own semantic correction comparison'}];
 const commit=await s.commitReview(r);assert.equal(commit.facts.length,1);assert.deepEqual([...s.getReviewedUnits('daily','live')],[other.event_id]);assert.equal((await s.listPendingChunks({schema_version:1,from:'2026-09-01T00:00:00Z',to:'2026-10-01T00:00:00Z'},'live'))[0].chunk_id,b.chunks[0].chunk_id);s.close();
});
test('exact grouped no-information and covered-fact decisions are explicit, nonoverlapping and bounded to actual units',async()=>{
 const c=await config(),s=await createStore(c),first=bundle();await s.saveBundle(first);const f=(await s.commitReview(result(first))).facts[0];
 const e1=event('new-a'),e2=event('new-b'),b=bundle([e1,e2],'group');b.existing_facts=[f];await s.saveBundle(b);const r=result(b,'group',false);
 r.unit_dispositions=[{schema_version:1,units:[exactReviewUnit(e1),exactReviewUnit(e2)],disposition:'covered_by_facts',fact_refs:[{schema_version:1,fact_id:f.fact_id,revision:1}],reason:'These exact statements are fully represented by the supplied frozen fact'}];
 const wrong=structuredClone(r);wrong.unit_dispositions![0].units[0].end_byte++;await assert.rejects(s.commitReview(wrong),/exact primary supplied unit/);
 assert.equal((await s.commitReview(r)).facts.length,0);assert(s.getReviewedUnits('daily','live').has(e1.event_id));s.close();
});
test('legacy unaccepted material is refused, but an already accepted original identity remains immutable on retry',async()=>{
 const c=await config(),s=await createStore(c),b=bundle();delete b.review_requirements;await s.saveBundle(b);await assert.rejects(s.commitReview(result(b)),/fresh preparation/);
 const modern=bundle([event('modern')],'modern');await s.saveBundle(modern);const rr=result(modern,'modern');const commit=await s.commitReview(rr);s.db.prepare("UPDATE bundles SET json=json_remove(json,'$.review_requirements') WHERE id=?").run(modern.bundle_id);const retry=await s.commitReview(rr);assert.equal(retry.reused,true);assert.equal(retry.batch_id,commit.batch_id);s.close();
});
test('an original event ref covers only its one actually supplied slice and unread media cannot become zero facts',async()=>{
 const c=await config();c.limits.chunk_body_bytes=256;c.limits.bundles_per_round=1;c.limits.bundle_bytes=8192;const s=await createStore(c),r=createReviewer(s,c),e=event('sliced','x'.repeat(2048));await s.saveCollection(collection([e]));const b=(await r.prepare({kind:'daily',lane:'live',source:'synthetic',cutoff:'2026-10-01T00:00:00Z'}))[0];const rr=result(b);rr.candidates[0].event_refs=[{schema_version:1,...exactReviewUnit(e)}];rr.candidates[0].analytics_projection={schema_version:1,value:null,reason:'Synthetic'};
 // Restrict the synthetic candidate to one actual slice even when its stable
 // source ID is supplied; peer slices need explicit dispositions.
 const first=b.chunks[0].events[0];rr.candidates[0].event_refs=[{schema_version:1,...exactReviewUnit(first)}];rr.unit_dispositions=b.chunks.flatMap(chunk=>chunk.events.filter(unit=>unit.event_id!==first.event_id).map(unit=>({schema_version:1 as const,units:[exactReviewUnit(unit)],disposition:'defer' as const,fact_refs:[],reason:'Tail intentionally not semantically reviewed'})));
 for(const review of rr.chunks)if(!rr.candidates.some(candidate=>candidate.chunk_id===review.chunk_id))review.zero_facts=true;
 await s.commitReview(rr);assert.equal(s.db.prepare("SELECT COUNT(*) n FROM reviewed_sources WHERE source_id='sliced'").get()!.n,0);assert(s.getReviewedSpans('daily','live','sliced').every(span=>span.end_byte<=256));
 const media=event('missing-image');media.kind='image';media.body=null;const mb=bundle([media],'media');await s.saveBundle(mb);await assert.rejects(s.commitReview(result(mb,'media',false)),/Unread media/);s.close();
});
test('a candidate cannot bypass known unread media by directly referencing its unit',async()=>{
 const c=await config(),s=await createStore(c),media=event('unread-image','[Image omitted]');media.context.media_unread=true;const b=bundle([media]);await s.saveBundle(b);const r=result(b);r.pages=[];const accepted=await s.commitReview(r);assert.equal(accepted.facts.length,0);assert.equal(s.getReviewedUnits('daily','live').size,0);assert.equal((await s.listWork('review_candidate'))[0].reason,'Unread media evidence remains pending; it cannot create a fact or complete a unit');s.close();
});
