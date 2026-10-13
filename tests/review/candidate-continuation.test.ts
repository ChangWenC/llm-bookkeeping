import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, canonical } from '../../src/store/index.ts';
import { createReviewer } from '../../src/review/index.ts';
import { parseCapturedLines } from '../../src/adapters/file-reader.ts';
import { config, event, collection, range, result } from '../store/fixtures.ts';
import type { PreparationContinuation } from '../../src/contracts/types.ts';
import type { ReviewUnit } from '../../src/contracts/types.ts';
const request={kind:'daily' as const,lane:'history' as const,source:'synthetic',range,selection_basis:'event_time' as const,cutoff:range.to,max_bundles:1};
async function seedPrefix(size:number) {
    const c=await config();c.providers[0].provider='codex';
    const s=await createStore(c);
    const packet='<heartbeat><automation_id>synthetic-continuation</automation_id><current_time_iso>2026-09-30T09:00:00Z</current_time_iso><instructions>Synthetic</instructions></heartbeat>';
    const rows=[...Array.from({length:size},(_,i)=>({type:'response_item',timestamp:'2026-09-30T09:00:00Z',payload:{type:'message',id:'auto:'+i,role:'user',content:[{type:'input_text',text:packet}],turn_id:'auto:'+i}})),{type:'response_item',timestamp:'2026-09-30T10:00:00Z',payload:{type:'message',id:'human',role:'user',content:[{type:'input_text',text:'Synthetic human after prefix'}],turn_id:'human'}}];
    const bytes=Buffer.from(rows.map(row=>JSON.stringify(row)+'\n').join(''));
    const parsed=parseCapturedLines({provider:'codex',account:c.providers[0].account_id,identity:{id:'synthetic-chat',classification:'main',cwd:null,metadata:{}},locator:'/synthetic/continuation.jsonl',generation:'one',buffer:bytes,read_start:0,slice_start:0,consumed:bytes.length,state:{},known_events:new Set(),config:c});
    for(const fragment of parsed.fragments)s.db.prepare('INSERT INTO fragments VALUES(?,?)').run(fragment.fragment_id,canonical(fragment));
    for(const source of parsed.events){const context={...source.context};delete context.automation_origin;const e={...source,classification:'main',context};s.db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(e.event_id,canonical(e),e.utc_time.value,'main',e.physical_order);s.db.prepare('INSERT INTO event_lanes VALUES(?,?)').run(e.event_id,'live');}
    return {c,s};
}
test('reclassified empty pages continue to a human in the same bounded preparation',async()=>{
    const {c,s}=await seedPrefix(321);
    const prepared=await createReviewer(s,c).prepareWithOutcomes!({...request,source:'codex'});
    assert.equal(prepared.providers[0].preparation!.state,'ready');
    assert.equal(prepared.providers[0].preparation!.scanned.pages,2);
    assert.deepEqual(prepared.bundles.flatMap(b=>b.chunks.flatMap(chunk=>chunk.events.map(e=>e.source.message_id))),['human']);
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM events WHERE classification='automation'").get()!.n,321);
    s.close();
});
test('five-page limit returns resumable more, rejects changed scope/config and does not create empty packets',async()=>{
    const {c,s}=await seedPrefix(1800),reviewer=createReviewer(s,c);
    const first=await reviewer.prepareWithOutcomes!({...request,source:'codex'}),outcome=first.providers[0].preparation!;
    assert.equal(outcome.state,'more');assert.deepEqual(outcome.scanned.pages,5);assert.equal(outcome.scanned.rows,1600);assert.deepEqual(first.bundles,[]);assert.equal(s.db.prepare('SELECT COUNT(*) n FROM bundles').get()!.n,0);
    const token=outcome.continuation!;
    await assert.rejects(reviewer.prepareWithOutcomes!({...request,source:'codex',cutoff:'2026-10-02T00:00:00Z',candidate_continuation:token}),/scope mismatch/);
    await assert.rejects(reviewer.prepareWithOutcomes!({...request,source:'codex',selection_basis:'capture_lane',candidate_continuation:token}),/scope mismatch/);
    c.limits.chunk_events++;await assert.rejects(reviewer.prepareWithOutcomes!({...request,source:'codex',candidate_continuation:token}),/changed selection configuration/);c.limits.chunk_events--;
    const second=await reviewer.prepareWithOutcomes!({...request,source:'codex',candidate_continuation:token});
    assert.equal(second.providers[0].preparation!.state,'ready');assert.equal(second.providers[0].preparation!.scanned.rows,201);
    assert.deepEqual(second.bundles.flatMap(b=>b.chunks.flatMap(chunk=>chunk.events.map(e=>e.source.message_id))),['human']);
    const pending=await reviewer.prepareWithOutcomes!({...request,source:'codex',candidate_continuation:second.providers[0].preparation!.continuation!});
    assert.deepEqual(pending.bundles,second.bundles,'unaccepted active remains visible');
    await reviewer.accept(result(second.bundles[0],'accepted-human',false));
    const done=await reviewer.prepareWithOutcomes!({...request,source:'codex',candidate_continuation:second.providers[0].preparation!.continuation!});
    assert.equal(done.providers[0].preparation!.state,'exhausted');assert.deepEqual(done.bundles,[]);s.close();
});
test('oversized primary metadata defers its exact unit while a small peer is prepared and accepted independently',async()=>{
    const c=await config();c.limits.chunk_events=1;const s=await createStore(c),reviewer=createReviewer(s,c);
    const big=event('big','Large metadata body','2026-09-30T09:00:00Z'),small=event('small','Small peer','2026-09-30T10:00:00Z');
    big.context={synthetic_metadata:'x'.repeat(200*1024)};big.source.conversation_id='big-chat';small.source.conversation_id='small-chat';
    await s.saveCollection(collection([big,small]));
    const prepared=await reviewer.prepareWithOutcomes!(request),outcome=prepared.providers[0].preparation!;
    assert.equal(outcome.state,'ready');assert.equal(prepared.providers[0].execution_status,'partial');
    assert.deepEqual(prepared.bundles.flatMap(b=>b.chunks.flatMap(chunk=>chunk.events.map(e=>e.event_id))),['small']);
    assert.deepEqual(outcome.deferred_units.map(item=>item.unit),[{schema_version:1,event_id:'big',start_byte:0,end_byte:Buffer.byteLength(big.body!)}]);
    assert(prepared.bundles.every(b=>b.chunks.length&&b.chunks.every(chunk=>chunk.events.length)));
    assert(Buffer.byteLength(canonical(prepared.bundles[0]))<=c.limits.bundle_bytes);
    await reviewer.accept(result(prepared.bundles[0],'small-accepted',false));
    const done=await reviewer.prepareWithOutcomes!({...request,candidate_continuation:outcome.continuation!});assert.equal(done.providers[0].preparation!.state,'exhausted');
    const fresh=await reviewer.prepareWithOutcomes!(request);assert.equal(fresh.providers[0].preparation!.deferred_units.length,1,'fresh run retries oversized debt');
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM reviewed_sources WHERE source_id=?').get(big.event_id)!.n,0);s.close();
});
test('event-time explicit scope crosses physical lanes, preserves capture-lane compatibility and deduplicates accepted daily sources across lanes',async()=>{
    const c=await config(),s=await createStore(c),reviewer=createReviewer(s,c);await s.saveCollection(collection([event('live-only')],'live'));
    const legacy=await reviewer.prepareWithOutcomes!({...request,selection_basis:undefined});assert.deepEqual(legacy.bundles,[]);assert.equal(legacy.providers[0].preparation!.state,'exhausted');
    const included=await reviewer.prepareWithOutcomes!(request);assert.deepEqual(included.bundles.flatMap(b=>b.chunks.flatMap(chunk=>chunk.events.map(e=>e.event_id))),['live-only']);
    await reviewer.accept(result(included.bundles[0],'cross-lane',false));
    assert.deepEqual((await reviewer.prepareWithOutcomes!({...request,lane:'live'})).bundles,[]);s.close();
});
test('accepted partial source slices remain ahead of the continuation until all bytes are reviewed',async()=>{
    const c=await config();c.limits.chunk_body_bytes=512;c.limits.chunk_events=1;c.limits.bundle_bytes=8192;const s=await createStore(c),reviewer=createReviewer(s,c);await s.saveCollection(collection([event('sliced','a'.repeat(4096))]));
    const first=await reviewer.prepareWithOutcomes!(request);const token=first.providers[0].preparation!.continuation as PreparationContinuation;
    assert.equal(first.bundles[0].chunks[0].events[0].body,'a'.repeat(512));
    await reviewer.accept(result(first.bundles[0],'slice-head',false));
    let second=await reviewer.prepareWithOutcomes!({...request,candidate_continuation:token});assert((second.bundles[0].chunks[0].events[0].context.review_slice as any).start_byte>0);
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM reviewed_sources WHERE source_id=?').get('sliced')!.n,0);
    for(let index=0;index<10&&second.bundles.length;index++){await reviewer.accept(result(second.bundles[0],'slice-tail:'+index,false));second=await reviewer.prepareWithOutcomes!({...request,candidate_continuation:token});}
    assert.equal(second.providers[0].preparation!.state,'exhausted');s.close();
});
test('processing deadline preserves unread first primary and returns more without advancing its cursor',async(t)=>{
    const c=await config(),s=await createStore(c),reviewer=createReviewer(s,c);await s.saveCollection(collection([event('deadline-unread')]));
    let time=0;const page=s.getReviewCandidatePage.bind(s);s.getReviewCandidatePage=(...args)=>{const result=page(...args);time=6000;return result;};
    t.mock.method(performance,'now',()=>time);
    const first=await reviewer.prepareWithOutcomes!(request);assert.equal(first.providers[0].preparation!.state,'more');assert.deepEqual(first.bundles,[]);assert.equal(first.providers[0].preparation!.scanned.pages,1);
    t.mock.restoreAll();s.getReviewCandidatePage=page;
    const second=await reviewer.prepareWithOutcomes!({...request,candidate_continuation:first.providers[0].preparation!.continuation!});assert.equal(second.bundles[0].chunks[0].events[0].event_id,'deadline-unread');s.close();
});
test('EDQUOT/ENOSPC/SQLite abort preparation globally while actual source-read EACCES/EIO stay local',async()=>{
    for(const code of ['EDQUOT','ENOSPC','ERR_SQLITE_ERROR','EACCES','EIO']) {
        const c=await config();c.providers=[...c.providers,{...c.providers[0],provider:'peer'}];const s=await createStore(c),reviewer=createReviewer(s,c);const peer=event('peer');peer.source.provider='peer';await s.saveCollection(collection([event('local'),peer]));
        const original=s.getReviewCandidatePage.bind(s);let calledPeer=false;s.getReviewCandidatePage=(query,...args)=>{if(query.source==='peer'){calledPeer=true;return original(query,...args);}throw Object.assign(new Error('Synthetic source/storage failure'),{code});};
        if(['EACCES','EIO'].includes(code)){const prepared=await reviewer.prepareWithOutcomes!({...request,source:undefined});assert(calledPeer);assert.equal(prepared.providers.find(item=>item.provider==='synthetic')!.preparation!.state,'unavailable');assert(prepared.bundles.some(bundle=>bundle.source==='peer'));}
        else await assert.rejects(reviewer.prepareWithOutcomes!({...request,source:undefined}),(error:any)=>error.code===code);
        s.close();
    }
});
test('a valid continuation preserves source-local unavailable outcomes when saved active material becomes unreadable',async()=>{
    const c=await config(),s=await createStore(c),reviewer=createReviewer(s,c);await s.saveCollection(collection([event('pending-source')]));
    const first=await reviewer.prepareWithOutcomes!(request);
    s.getBundle=async()=>{throw Object.assign(new Error('Synthetic saved material disappeared'),{code:'EACCES'});};
    const resumed=await reviewer.prepareWithOutcomes!({...request,candidate_continuation:first.providers[0].preparation!.continuation!});
    assert.equal(resumed.providers[0].preparation!.state,'unavailable');assert.equal(resumed.providers[0].execution_status,'unavailable');assert.deepEqual(resumed.bundles,[]);s.close();
});
test('accepted live/history packets add monotonic skip progress without invalidating their pinned continuation',async()=>{
    const c=await config();c.limits.bundle_bytes=8192;const s=await createStore(c),reviewer=createReviewer(s,c);
    const rows=[event('live-head','a'.repeat(5000),'2026-09-30T09:00:00Z'),event('live-tail','b'.repeat(5000),'2026-09-30T10:00:00Z'),event('history-head','c'.repeat(5000),'2026-09-28T09:00:00Z'),event('history-tail','d'.repeat(5000),'2026-09-28T10:00:00Z')];
    await s.saveCollection(collection(rows));
    const base={kind:'daily' as const,source:'synthetic',cutoff:range.to,max_bundles:1},skips:ReviewUnit[]=[];
    const first=await reviewer.prepareWithOutcomes!({...base,lane:'live'});assert.equal(first.bundles[0].chunks[0].events[0].event_id,'live-head');
    await reviewer.accept(result(first.bundles[0],'accept-live-head',false));skips.push({schema_version:1,event_id:'live-head',start_byte:0,end_byte:5000});
    const history=await reviewer.prepareWithOutcomes!({...base,lane:'history',skip_units:skips});assert.equal(history.bundles[0].chunks[0].events[0].event_id,'history-head');
    await reviewer.accept(result(history.bundles[0],'accept-history-head',false));skips.push({schema_version:1,event_id:'history-head',start_byte:0,end_byte:5000});
    const third=await reviewer.prepareWithOutcomes!({...base,lane:'live',skip_units:skips,candidate_continuation:first.providers[0].preparation!.continuation!});assert.equal(third.bundles[0].chunks[0].events[0].event_id,'live-tail');
    await assert.rejects(reviewer.prepareWithOutcomes!({...base,lane:'live',skip_units:[skips[0]],candidate_continuation:third.providers[0].preparation!.continuation!}),/skip progress cannot shrink/);
    await assert.rejects(reviewer.prepareWithOutcomes!({...base,lane:'live',skip_units:[{...skips[0],end_byte:100},skips[1]],candidate_continuation:third.providers[0].preparation!.continuation!}),/skip progress cannot shrink/);
    await reviewer.accept(result(third.bundles[0],'accept-live-tail',false));skips.push({schema_version:1,event_id:'live-tail',start_byte:0,end_byte:5000});
    const fourth=await reviewer.prepareWithOutcomes!({...base,lane:'history',skip_units:skips,candidate_continuation:history.providers[0].preparation!.continuation!});assert.equal(fourth.bundles[0].chunks[0].events[0].event_id,'history-tail');s.close();
});

test('explicit active skip releases saved unaccepted material without skipping its peer or reading the deferred body',async()=>{
 const c=await config();c.limits.chunk_events=1;c.limits.bundles_per_round=1;const s=await createStore(c),reviewer=createReviewer(s,c);
 await s.saveCollection(collection([event('active','Active body','2026-09-30T09:00:00Z'),event('peer','Peer body','2026-09-30T10:00:00Z')]));
 const first=await reviewer.prepareWithOutcomes!(request),token=first.providers[0].preparation!.continuation!;assert.equal(first.bundles[0].chunks[0].events[0].event_id,'active');
 const get=s.getBundle.bind(s);s.getBundle=async id=>{if(id===first.bundles[0].bundle_id)throw new Error('Deferred active body must not be opened');return get(id);};
 const next=await reviewer.prepareWithOutcomes!({...request,candidate_continuation:token,skip_units:[{schema_version:1,event_id:'active',start_byte:0,end_byte:11}]});
 assert.equal(next.bundles[0].chunks[0].events[0].event_id,'peer');assert.equal(s.db.prepare('SELECT COUNT(*) n FROM reviewed_sources').get()!.n,0);s.close();
});
