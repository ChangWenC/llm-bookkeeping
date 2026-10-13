import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, canonical, digest } from '../../src/store/index.ts';
import { createMonthlyConsumer } from '../../src/consumers/monthly/index.ts';
import { config, bundle, result, collection } from './fixtures.ts';
import type { WorkItem, FileIntent } from '../../src/contracts/types.ts';

test('publication pages bound payload hydration to 64 and persist independent rolling history cursors across restart',async()=>{
    const c=await config();let s=await createStore(c);const b=bundle();await s.saveCollection(collection());await s.saveBundle(b);await s.commitReview(result(b));
    const artifact=(await s.listOutbox())[0].artifact;
    s.db.prepare('DELETE FROM outbox').run();
    for(let i=0;i<130;i++)s.db.prepare('INSERT INTO outbox VALUES(?,?,?,?)').run('ready:'+i,canonical({...artifact,batch_id:'ready:'+i}),'ready','/synthetic/export:'+i);
    s.db.prepare('INSERT INTO outbox VALUES(?,?,?,NULL)').run('pending:new',canonical({...artifact,batch_id:'pending:new'}),'pending');
    for(let i=0;i<130;i++) {
        const bytes=Buffer.from('Synthetic applied '+i),intent:FileIntent={schema_version:1,operation_id:'applied:'+i,path:'wiki/synthetic.md',baseline_digest:'absent',desired_digest:digest(bytes),desired_bytes_base64:bytes.toString('base64'),backup_bytes_base64:null,state:'applied',fact_refs:[],created_at:'2026-09-30T10:00:00Z',reason:null};
        s.db.prepare('INSERT INTO intents VALUES(?,?,?)').run(intent.operation_id,canonical(intent),intent.state);
    }
    const pending=await s.listPublicationOutbox({schema_version:1,status:'pending',limit:64});assert.deepEqual(pending.items.map(item=>item.batch_id),['pending:new']);
    const parse=JSON.parse;let hydrated=0;JSON.parse=(text:string,...args:any[])=>{hydrated++;assert(!text.includes('"batch_id":"ready:64"'));return (parse as any)(text,...args);};
    let head;try{head=await s.listPublicationOutbox({schema_version:1,status:'ready',limit:64});}finally{JSON.parse=parse;}
    assert.equal(head.items.length,64);assert.equal(hydrated,64,'lookahead only projects metadata, never the 65th payload');
    assert.equal((await s.getPublicationOutbox('ready:129'))!.batch_id,'ready:129','current exact batch is independent of historical recovery page');assert.equal(await s.getPublicationOutbox('missing'),null);
    const files=await s.listPublicationFileIntents({schema_version:1,states:['applied'],limit:64});assert.equal(files.items.length,64);
    await s.setPublicationRecoveryCursor('ready_exports',head.next_cursor);await s.setPublicationRecoveryCursor('applied_intents',files.next_cursor);s.close();s=await createStore(c);
    const next=await s.listPublicationOutbox({schema_version:1,status:'ready',limit:64,after:(await s.getPublicationRecoveryCursor('ready_exports'))!});assert.equal(next.items[0].batch_id,'ready:64');assert.equal(next.items.length,64);
    const tail=await s.listPublicationOutbox({schema_version:1,status:'ready',limit:64,after:next.next_cursor!});assert.deepEqual(tail.items.map(item=>item.batch_id),['ready:128','ready:129']);assert.equal(tail.next_cursor,null);
    const nextFiles=await s.listPublicationFileIntents({schema_version:1,states:['applied'],limit:64,after:(await s.getPublicationRecoveryCursor('applied_intents'))!});assert.equal(nextFiles.items[0].operation_id,'applied:64');
    await s.setPublicationRecoveryCursor('ready_exports',null);assert.equal((await s.listPublicationOutbox({schema_version:1,status:'ready',limit:64,after:(await s.getPublicationRecoveryCursor('ready_exports'))??undefined})).items[0].batch_id,'ready:0');
    assert.equal(await s.getPublicationRecoveryCursor('applied_intents'),files.next_cursor);
    await assert.rejects(s.listPublicationOutbox({schema_version:1,status:'pending',limit:64,after:head.next_cursor!}),/scope mismatch/);
    await assert.rejects(s.listPublicationOutbox({schema_version:1,status:'ready',limit:65}),/1–64/);
    await assert.rejects(s.listPublicationFileIntents({schema_version:1,states:['pending'],limit:64,after:files.next_cursor!}),/scope mismatch/);
    s.close();
});
test('monthly semantic metadata retains queued supplement and invalidation debt after consumer acknowledgement without source or fact hydration',async()=>{
    const c=await config(),s=await createStore(c);const b=bundle();await s.saveCollection(collection());await s.saveBundle(b);const commit=await s.commitReview(result(b));await s.markExportReady(commit.batch_id,'/synthetic/facts.json');
    const monthly=createMonthlyConsumer(s,c,{now:()=>new Date('2026-10-07T12:00:00Z')});
    await s.enqueueWork({schema_version:1,work_id:'supplement:1',kind:'journal_supplement',lane:'history',state:'pending',payload:{patch:{date:'2026-09-15',fact_refs:commit.facts}},reason:'Synthetic pending archived supplement',migration_key:null,updated_at:'2026-10-06T00:00:00Z'});
    assert.equal((await monthly.consume()).status,'complete');assert.deepEqual(await s.listReadyBatches('monthly'),[]);
    const pending=await s.listWork('prepare_monthly','pending');assert(pending.some(work=>work.payload.supplement_work_id==='supplement:1'));
    const work=(id:string,kind:string,month:string,extra:Record<string,unknown>={}):WorkItem=>({schema_version:1,work_id:id,kind,lane:'history',state:'pending',payload:{month,...extra},reason:'Synthetic semantic debt',migration_key:null,updated_at:'2026-10-06T00:00:00Z'});
    await s.enqueueWork(work('invalidated','prepare_monthly','2026-08',{invalidated_fact_refs:commit.facts}));
    await s.enqueueWork(work('original','archive_context','2026-07',{archive_path:'/synthetic/do-not-open'}));
    await s.enqueueWork(work('file-only','monthly_display','2026-06'));
    await s.enqueueWork(work('current','prepare_monthly','2026-10'));
    const refs=[...commit.facts,{schema_version:1 as const,fact_id:'frozen-unread',revision:1}];
    const snapshot=s.freezeFactMaterial('monthly','2026-09','2026-10-07T00:00:00Z',refs,pending.map(item=>item.work_id));s.markFactMaterialRead(snapshot,commit.facts);
    const parse=JSON.parse;JSON.parse=()=>{throw new Error('Metadata status must not hydrate source, facts, saved bundles or work JSON');};
    let status;try{status=await s.monthlySemanticStatus('2026-10-07T12:00:00Z');}finally{JSON.parse=parse;}
    assert.equal(status.oldest_month,'2026-07');assert.equal(status.months.find(item=>item.month==='2026-07')!.pending_count,1);assert(!status.months.some(item=>item.month==='2026-06'));
    assert(status.months.find(item=>item.month==='2026-08')!.reasons.some(reason=>reason.includes('corrected or retracted')));
    assert.equal(status.months.find(item=>item.month==='2026-10')!.eligible,false);
    assert.deepEqual(status.months.find(item=>item.month==='2026-09')!.continuation,{schema_version:1,snapshot_id:snapshot,cutoff:'2026-10-07T00:00:00Z',offset:1,next_offset:1,total:2});
    const actualTime=await s.monthlySemanticStatus('2026-10-07T12:00:00Z','2026-11-01T12:00:00Z');assert.equal(actualTime.months.find(item=>item.month==='2026-10')!.eligible,true,'eligibility uses operation time separately from frozen evidence cutoff');
    const late=work('late','prepare_monthly','2026-09');await s.enqueueWork(late);assert(!s.getFactMaterial(snapshot)!.work_ids!.includes(late.work_id));
    assert.equal((await s.listWork('prepare_monthly','pending')).length,pending.length+3);s.close();
});
test('accepted identity lookup remains metadata-only when stale accepted source material becomes unreadable',async()=>{
    const c=await config(),s=await createStore(c);const b=bundle();await s.saveCollection(collection());await s.saveBundle(b);const commit=await s.commitReview(result(b));
    const parse=JSON.parse;JSON.parse=()=>{throw new Error('No accepted source/result/commit body should be hydrated');};
    // Minimal synthetic accepted-resolution metadata, independent of its saved content.
    s.db.prepare('INSERT INTO journal_resolutions VALUES(?,?,?,?)').run('accepted-resolution','journal-saved','not-decodable','not-decodable');
    try{assert.deepEqual(await s.acceptedReviewIdentity(b.bundle_id),{schema_version:1,result_id:commit.result_id,batch_id:commit.batch_id});assert.equal(await s.acceptedReviewIdentity('unknown'),null);assert.deepEqual(await s.acceptedJournalResolutionIdentity('journal-saved'),{schema_version:1,resolution_id:'accepted-resolution'});assert.equal(await s.acceptedJournalResolutionIdentity('missing'),null);}finally{JSON.parse=parse;s.close();}
});
