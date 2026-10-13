import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, canonical, digest, type SqliteStore } from '../../src/store/index.ts';
import { validateStore } from '../../src/store/health.ts';
import { createReviewer } from '../../src/review/index.ts';
import { previewNativeDuplicates } from '../../src/store/native-duplicates.ts';
import type { BookkeepingConfig, RawFragment, SourceEvent } from '../../src/contracts/types.ts';
import { config, event, collection, bundle, result, range } from '../store/fixtures.ts';

const forbidden = 'SYNTHETIC_FORBIDDEN_BODY_NEVER_DECODE';
const cutoff = range.to;
function exclude(c: BookkeepingConfig, ids: string[]) {
    c.review_read_exclusions = {schema_version:1,events:ids.map(event_id=>({schema_version:1,event_id,reason:'Synthetic user instruction to withhold this exact event'}))};
}
function protect<T>(operation: () => Promise<T>, fragments: string[] = []): Promise<T> {
    const original = JSON.parse;
    JSON.parse = (text: string, ...args: any[]) => {
        assert(!text.includes(forbidden), 'Prohibited source or bundle JSON was decoded');
        assert(!fragments.some(bytes=>text.includes(bytes)), 'Prohibited original fragment was decoded');
        return (original as any)(text, ...args);
    };
    return operation().finally(()=>{ JSON.parse = original; });
}
function immutableRows(store: SqliteStore) {
    return ['events','facts','reviewed_sources','reviewed_spans','reviewed_units'].map(table=>store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}

test('exact exclusions precede primary LIMIT, skip body validation and context reads; peers and debt survive', async()=>{
    const c=await config(); c.limits.chunk_events=1; c.limits.bundles_per_round=1;
    const blocked=event('blocked',forbidden,'2026-09-30T08:00:00Z');
    const peer=event('peer','Synthetic permitted peer','2026-09-30T09:00:00Z');
    const later=event('later','Synthetic later peer','2026-09-30T10:00:00Z');
    let store=await createStore(c); await store.saveCollection(collection([blocked,peer,later]));
    const before=immutableRows(store); store.close(); exclude(c,[blocked.event_id]); store=await createStore(c);
    await protect(async()=>{
        assert.deepEqual((await store.listEvents({range,limit:1,include_context:true})).map(e=>e.event_id),['peer']);
        assert.deepEqual((await store.getReviewableEvents({range,limit:1},'daily')).map(e=>e.event_id),['peer']);
        store.validateSkipUnits([{schema_version:1,event_id:'blocked',start_byte:0,end_byte:999999}]);
        assert.throws(()=>store.validateSkipUnits([{schema_version:1,event_id:'blocked',start_byte:-1,end_byte:1}]),/bounds/);
        assert.throws(()=>store.validateSkipUnits([{schema_version:1,event_id:'absent',start_byte:0,end_byte:1}]),/nonexistent/);
        assert.deepEqual(store.getContextEvents(later).map(e=>e.event_id),['peer']);
        const prepared=await createReviewer(store,c).prepareWithOutcomes!({kind:'daily',lane:'live',cutoff,source:'synthetic',skip_units:[{schema_version:1,event_id:'blocked',start_byte:0,end_byte:999999}]});
        assert.equal(prepared.bundles.length,1);
        assert(prepared.bundles.every(b=>b.chunks.every(chunk=>[...chunk.events,...chunk.context_events].every(e=>e.event_id!=='blocked'))));
        assert(prepared.bundles[0].unfinished.some(g=>g.reason.includes('retained unreviewed')));
        assert.equal(prepared.providers[0].execution_status,'partial');
        assert.equal((await validateStore(store,'all')).status,'valid');
        assert.equal((await validateStore(store,'changed')).status,'valid');
        const status=await store.status(); const review=status.review as any;
        assert.equal(review.retained_unreviewed_events,3); assert.equal(review.read_excluded_unreviewed_events,1); assert.equal(review.eligible_pending,2);
        assert.deepEqual(store.reviewReadExclusions(range,'synthetic').map(item=>[item.event_id,item.unreviewed]),[['blocked',true]]);
    });
    assert.deepEqual(immutableRows(store),before); store.close();
});

test('group participation context excludes exact prohibited bodies before its bounded window', async()=>{
    const c=await config(); c.providers[0].provider='wechat'; c.providers[0].options={group_allowlist:['synthetic-group@chatroom']};
    const group=(id:string,body:string,time:string)=>{const e=event(id,body,time);e.source.provider='wechat';e.source.conversation_id='synthetic-group@chatroom';e.context={is_group:true,identity_verified:true,sender_id:'synthetic-self'};return e;};
    const blocked=group('group-blocked',forbidden,'2026-09-30T08:59:00Z'); const peer=group('group-peer','Permitted group peer','2026-09-30T09:00:00Z');
    let store=await createStore(c);await store.saveCollection(collection([blocked,peer]));store.close();exclude(c,['group-blocked']);store=await createStore(c);
    await protect(async()=>{assert.deepEqual(store.getContextEvents(peer),[]);assert.equal(store.isContextTruncated(peer),false);assert.deepEqual((await store.listEvents({range,include_context:true})).map(e=>e.event_id),['group-peer']);});store.close();
});

function codex(id:string,body:string,role:'user'|'assistant',order:string,turn:string): {event:SourceEvent;fragment:RawFragment} {
    const e=event(id,body);e.role=role;e.source.provider='codex';e.physical_order=order.padStart(20,'0')+':0';e.locator='/synthetic/codex.jsonl';
    const raw=Buffer.from(JSON.stringify({type:'response_item',payload:{type:'message',role,id,content:[{type:role==='user'?'input_text':'output_text',text:body}],turn_id:turn}}));
    const offset=Number(order),fragment:RawFragment={schema_version:1,fragment_id:'fragment:'+id,locator:`source:codex:${e.source.account_id}:${e.source.conversation_id}:${e.generation}:${offset}:${offset+raw.length}`,bytes_base64:raw.toString('base64'),sha256:digest(raw)};
    e.fragment_ref=fragment.fragment_id;return {event:e,fragment};
}
test('blocked nearest user is a boundary: no older anchor inheritance, forbidden fragment access or source mutation',async()=>{
    const c=await config();c.providers[0].provider='codex';
    const packet='<heartbeat><automation_id>synthetic</automation_id><current_time_iso>2026-09-30T08:00:00Z</current_time_iso><instructions>Synthetic</instructions></heartbeat>';
    const old=codex('older-automation',packet,'user','0','old');const blocked=codex('nearest-blocked',forbidden,'user','1000','human');const assistant=codex('assistant-peer','Synthetic assistant','assistant','2000','human');
    let store=await createStore(c); const batch=collection([old.event,blocked.event,assistant.event]);batch.fragments=[old.fragment,blocked.fragment,assistant.fragment];await store.saveCollection(batch);
    const before=immutableRows(store);store.close();exclude(c,['nearest-blocked']);store=await createStore(c);
    const accesses:string[]=[];const original=(store as any).sourceFragment.bind(store);(store as any).sourceFragment=(e:SourceEvent)=>{accesses.push(e.event_id);assert.notEqual(e.event_id,'nearest-blocked');return original(e);};
    await protect(async()=>{
        const visible=await store.listEvents({range,include_context:true});assert(!visible.some(e=>e.event_id==='nearest-blocked'));assert.equal(visible.find(e=>e.event_id==='assistant-peer')!.classification,'unknown');
        assert.deepEqual(await store.getReviewableEvents({range},'daily'),[]);
    },[blocked.fragment.bytes_base64]);
    assert(!accesses.includes('nearest-blocked'));assert.deepEqual(immutableRows(store),before);store.close();
});

test('stale primary/context/original slice bundles are rejected before JSON parse; accepted retry rereads no source',async()=>{
    const c=await config(); const blocked=event('blocked',forbidden),peer=event('peer','Synthetic permitted peer');
    let store=await createStore(c);await store.saveCollection(collection([blocked,peer]));
    const primary=bundle([blocked],'stale-primary');const context=bundle([peer],'stale-context');context.chunks[0].context_events=[blocked];
    const slice=bundle([{...blocked,event_id:'slice:synthetic',context:{review_slice:{source_event_id:'blocked',start_byte:0,end_byte:4,total_bytes:Buffer.byteLength(forbidden)}}}],'stale-slice');
    for(const b of [primary,context,slice]) await store.saveBundle(b);
    const accepted=bundle([blocked],'accepted-before-exclusion');await store.saveBundle(accepted);const input=result(accepted,'accepted-result',false);const committed=await store.commitReview(input);
    const before=immutableRows(store);store.close();exclude(c,['blocked']);store=await createStore(c);
    await protect(async()=>{
        for(const b of [primary,context,slice]) {assert.throws(()=>store.assertReviewBundleReadable(b.bundle_id),/read excluded/);await assert.rejects(store.getBundle(b.bundle_id),/read excluded/);await assert.rejects(store.commitReview(result(b,'result:'+b.bundle_id,false)),/read excluded/);}
        assert.deepEqual(await store.listPendingChunks(range,'live'),[]);
        assert.throws(()=>store.assertReviewBundleReadable(accepted.bundle_id),/read excluded/);
        assert.equal((await validateStore(store,'all')).status,'valid');
        assert.equal((await validateStore(store,'changed')).status,'valid');
        await store.status();
        await assert.rejects(store.getBundle(accepted.bundle_id),/read excluded/);
        await assert.rejects(store.inventoryAcceptedDaily({from:'2020-01-01T00:00:00Z',to:'2030-01-01T00:00:00Z'}),/read excluded/);
        await assert.rejects(store.recoverJournalPublication({schema_version:1,result_ids:[input.result_id],created_at:cutoff}),/read excluded/);
        const reused=await createReviewer(store,c).accept(input);assert.equal(reused.reused,true);assert.equal(reused.batch_id,committed.batch_id);
        await assert.rejects(store.commitReview({...input,chunks:[]}),/identity conflict/);
    });assert.deepEqual(immutableRows(store),before);store.close();
});

test('replay freezes only allowed IDs, exact blocked selection rejects, frozen blocked debt cannot complete',async()=>{
    const c=await config(); const blocked=event('blocked',forbidden),peer=event('peer','Permitted replay peer');
    let store=await createStore(c);await store.saveCollection(collection([blocked,peer]));const old=await store.requestSemanticReplay({schema_version:1,replay_key:'old',source:'synthetic',range,cutoff});store.close();exclude(c,['blocked']);store=await createStore(c);
    await protect(async()=>{
        await assert.rejects(store.requestSemanticReplay({schema_version:1,replay_key:'blocked-selection',source:'synthetic',range,cutoff,event_ids:['blocked']}),/missing, excluded/);
        const fresh=await store.requestSemanticReplay({schema_version:1,replay_key:'fresh',source:'synthetic',range,cutoff});assert.equal(fresh.payload.event_count,1);
        assert.deepEqual(store.getReplayEvents(old.work_id,1,[{schema_version:1,event_id:'blocked',start_byte:0,end_byte:999999}]).map(e=>e.event_id),['peer']);
        const bundles=await createReviewer(store,c).prepare({kind:'daily',lane:'history',replay_id:old.work_id,cutoff});assert.equal(bundles.length,1);await store.commitReview(result(bundles[0],'old-replay-peer',false));
        assert.equal((await store.getSemanticReplay(old.work_id))!.state,'pending');assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM reviewed_sources WHERE source_id='blocked'").get() as any).n,0);
        assert((await store.listCoverage(range)).every(item=>item.review_status!=='complete'));
    });store.close();
});

test('unknown exact exclusion identity fails metadata-only before any source parse',async()=>{
    const c=await config();const store=await createStore(c);await store.saveCollection(collection([event('blocked',forbidden)]));store.close();exclude(c,['absent']);
    await protect(async()=>{await assert.rejects(createStore(c),/nonexistent event/);});
});

test('shared original row fragments and maintenance duplicate readers cannot reopen excluded bodies',async()=>{
    const c=await config();c.providers[0].provider='codex';
    const blocked=codex('blocked',forbidden,'user','0','human');const peer=codex('peer','Synthetic safe body','user','1000','peer');
    // Two blocks can reference one original row. Even a permitted block must
    // not decode that original fragment when it contains a withheld block.
    peer.event.fragment_ref=blocked.fragment.fragment_id;
    let store=await createStore(c);const batch=collection([blocked.event,peer.event]);batch.fragments=[blocked.fragment];await store.saveCollection(batch);const before=immutableRows(store);store.close();exclude(c,['blocked']);store=await createStore(c);
    await protect(async()=>{
        assert.equal((store as any).sourceFragment(peer.event),null);
        assert.deepEqual(await store.getReviewableEvents({range},'daily'),[]);
        assert.throws(()=>previewNativeDuplicates(c,{schema_version:1,source:'codex',range,pairs:[{canonical_event_id:'peer',redundant_event_id:'blocked'}]}),/read excluded/);
    },[blocked.fragment.bytes_base64]);
    assert.deepEqual(immutableRows(store),before);store.close();
});
