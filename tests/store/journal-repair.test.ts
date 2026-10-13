import {strongAssessment} from './fixtures.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,symlink} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {createStore,canonical,digest} from '../../src/store/index.ts';
import {createReviewer} from '../../src/review/index.ts';
import {config,event,collection,bundle,result,value} from './fixtures.ts';
import type {JournalResolution,JournalPublicationPayload} from '../../src/contracts/types.ts';
import {acquireWikiLock} from '../../src/publish/lock.ts';

const cutoff='2026-10-06T12:00:00Z';
const units=(bundles:Awaited<ReturnType<ReturnType<typeof createReviewer>['prepare']>>)=>bundles.flatMap(b=>b.chunks.flatMap(c=>c.events));
test('status active review debt follows tightened group scope and stable identity while retained blocked records stay separate',async()=>{
    const c=await config();c.providers[0]!.provider='wechat';c.providers[0]!.options={group_allowlist:['kept@chatroom','formerly-allowed@chatroom']};const s=await createStore(c);
    const source=(id:string,chat:string,time:string)=>{const e=event(id,'Synthetic retained message',time);e.source.provider='wechat';e.source.conversation_id=chat;e.context={is_group:chat.endsWith('@chatroom'),identity_verified:true,sender_id:'wxid_verified'};return e;};
    const excluded=source('former-group','formerly-allowed@chatroom','2026-09-01T09:00:00Z'),allowed=source('eligible','kept@chatroom','2026-09-30T09:00:00Z'),sender=source('unknown-sender','private-chat','2026-09-02T09:00:00Z'),metadata=source('unknown-time','private-chat','2026-09-02T10:00:00Z'),unfinished=source('unfinished-turn','kept@chatroom','2026-09-03T09:00:00Z'),context=source('context-only','kept@chatroom','2026-09-01T08:00:00Z');
    sender.role='unknown';sender.context.identity_verified=false;delete sender.context.sender_id;metadata.classification='unknown';metadata.utc_time={schema_version:1,value:null,reason:'Synthetic unknown time'};unfinished.role='assistant';unfinished.context.turn_complete=false;context.context.context_only=true;
    const captured=collection([excluded,allowed,sender,metadata,unfinished,context],'history');captured.coverage[0]!.provider='wechat';await s.saveCollection(captured);
    assert.equal(((await s.status()).review as any).eligible_pending,2);
    c.providers[0]!.options.group_allowlist=['kept@chatroom',...Array.from({length:6},(_,i)=>'allowed-'+i+'@chatroom')];
    const retained=s.db.prepare('SELECT id,json FROM events ORDER BY id').all(),status=await s.status(),review=status.review as any,sourceStatus=(status.sources as any[]).find(item=>item.provider==='wechat');
    assert.equal(status.events,6);assert.equal(review.unreviewed_events,1);assert.equal(review.eligible_pending,1);assert.equal(review.retained_unreviewed_events,5);assert.equal(review.excluded_unreviewed_events,1);assert.equal(review.blocked_metadata_pending,2);assert.equal(review.incomplete_turn_pending,1);assert.equal(Date.parse(sourceStatus.oldest_unreviewed_at.value),Date.parse(allowed.utc_time.value!));assert.deepEqual(sourceStatus.oldest_unreviewed_at,sourceStatus.oldest_eligible_unreviewed_at);assert.equal(sourceStatus.review.excluded_unreviewed_events,1);assert.equal(sourceStatus.unread.value,null);
    const b=bundle([allowed],'scope-status-zero');await s.saveBundle(b);await s.commitReview(result(b,'scope-status-zero',false));const after=await s.status(),afterSource=(after.sources as any[]).find(item=>item.provider==='wechat');
    assert.equal((after.review as any).eligible_pending,0);assert.equal(afterSource.oldest_unreviewed_at.value,null);assert.equal((after.review as any).blocked_metadata_pending,2);assert.equal((after.review as any).incomplete_turn_pending,1);assert.equal((after.review as any).excluded_unreviewed_events,1);assert.deepEqual(s.db.prepare('SELECT id,json FROM events ORDER BY id').all(),retained);assert.equal(s.db.prepare('SELECT COUNT(DISTINCT source_id) AS n FROM reviewed_sources').get()!.n,1);assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM reviewed_sources WHERE source_id=?').get(excluded.event_id)!.n,0);s.close();
});
test('verified derived journal display atomically closes exact work and terminalizes the original only after every linked debt, without semantic mutation',async()=>{
    const c=await config(),s=await createStore(c),b=bundle([event('historical','Accepted historical activity','2026-07-15T09:00:00Z')],'historical');
    b.baselines[0]!.path='wiki/personal/journals/reviews/回顾_2026_07.md';await s.saveBundle(b);const rr=result(b,'historical');rr.candidates[0]!.journal_date=value('2026-07-15');rr.pages[0]!.date='2026-07-15';const accepted=await s.commitReview(rr),original=accepted.patches[0]!,fact=accepted.facts[0]!;
    await s.markPatchStatus(original.operation_id,'conflict','Human changed original baseline');
    const first=(await s.listWork('journal_publication'))[0]!,second={...first,work_id:first.work_id+':second-date',payload:{...first.payload,date:'2026-07-16'}};await s.enqueueWork(second);
    const path=b.baselines[0]!.path,bytes='Verified monthly rendered fact and correction notice\n';await mkdir(dirname(join(c.wiki_root,path)),{recursive:true});await writeFile(join(c.wiki_root,path),bytes);
    const ref={schema_version:1 as const,fact_id:fact.fact_id,revision:fact.revision};
    const intent=(id:string,refs:typeof ref[])=>({schema_version:1 as const,operation_id:id,path,baseline_digest:'absent',desired_digest:digest(bytes),desired_bytes_base64:Buffer.from(bytes).toString('base64'),backup_bytes_base64:null,state:'prepared' as const,fact_refs:refs,created_at:cutoff,reason:null});
    await s.saveFileIntent(intent('display-missing-ref',[]));await s.updateFileIntent('display-missing-ref','applied');await s.saveFileIntent(intent('verified-derived-display',[ref]));await s.updateFileIntent('verified-derived-display','applied');
    const before=Object.fromEntries(['facts','results','outbox','reviewed_units','reviewed_spans','reviewed_sources'].map(table=>[table,s.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n]));
    const lock=await acquireWikiLock(c.wiki_root);assert(lock);
    try {
        await assert.rejects(s.completeJournalDisplay([first.work_id,second.work_id],'display-missing-ref',lock),/exact work target\/revision/);
        await assert.rejects(s.completeJournalDisplay([first.work_id],'verified-derived-display',{...lock,token:'not-the-current-lock'}),/lock/);
        await writeFile(join(c.wiki_root,path),'Human replaced derived output');await assert.rejects(s.completeJournalDisplay([first.work_id],'verified-derived-display',lock),/differs from applied publication/);await writeFile(join(c.wiki_root,path),bytes);
        assert((await s.listWork('journal_publication')).every(w=>w.state!=='complete'));
        await s.completeJournalDisplay([first.work_id],'verified-derived-display',lock);assert.equal(await s.getOperationSupersession(original.operation_id),null);assert.equal(s.db.prepare('SELECT status FROM patches WHERE id=?').get(original.operation_id)!.status,'conflict');
        await s.completeJournalDisplay([second.work_id],'verified-derived-display',lock);assert.equal(await s.getOperationSupersession(original.operation_id),'terminal:verified-derived-display');assert.equal((await s.listPendingPatches()).length,0);assert.equal(await s.getFileIntent(original.operation_id),null);
        await s.completeJournalDisplay([first.work_id,second.work_id],'verified-derived-display',lock);await assert.rejects(s.markPatchStatus(original.operation_id,'pending'),/terminal/);await assert.rejects(s.saveFileIntent(intent(original.operation_id,[ref])),/terminal/);
        assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM operation_terminals').get()!.n,1);assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM operation_supersessions').get()!.n,0);
        for(const [table,n] of Object.entries(before))assert.equal(s.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n,n);
    } finally {await lock.release();s.close();}
});
test('single journal debt remains bounded when many unrelated large facts share its date',async()=>{
    const c=await config(),s=await createStore(c),r=createReviewer(s,c);
    for(let index=0;index<20;index++) {
        const b=bundle([event('busy:'+index)],'busy:'+index);await s.saveBundle(b);const rr=result(b,'busy:'+index);rr.pages=[];rr.candidates[0]!.content='Distinct accepted paragraph '+index+' '+ 'x'.repeat(10000);await s.commitReview(rr);
    }
    assert(Buffer.byteLength(canonical(s.effective()))>c.limits.bundle_bytes);
    const work=(await s.listWork('journal_publication'))[0]!,j=await r.prepareJournalWork!({schema_version:1,cutoff,max_items:1,work_ids:[work.work_id]});
    assert.equal(j.work.length,1);assert.equal(j.facts.length,1);assert.equal(j.existing_facts.length,0);assert(Buffer.byteLength(canonical(j))<c.limits.bundle_bytes);s.close();
});
test('normal daily windows ignore physical capture lane; preexisting cross-lane partial spans preserve the untouched tail',async()=>{
    const c=await config(),s=await createStore(c),r=createReviewer(s,c);
    const old=event('old','older live capture','2026-10-02T12:00:00Z'),at=event('boundary','captured in history','2026-10-04T12:00:00Z'),before=event('before','older by one millisecond','2026-10-04T11:59:59.999Z');
    await s.saveCollection(collection([old,before],'live','older-live'));
    await s.saveCollection(collection([at],'history','recent-history'));
    assert.deepEqual(units(await r.prepare({kind:'daily',lane:'live',cutoff})).map(e=>e.event_id),['boundary']);
    assert.deepEqual(units(await r.prepare({kind:'daily',lane:'history',cutoff})).map(e=>e.event_id),['old','before']);
    const long=event('long','你'.repeat(60),'2026-10-05T09:00:00Z');await s.saveCollection(collection([long],'history','long-history'));
    // Historical databases may contain a span in only one lane. Query must union it.
    s.db.prepare('INSERT INTO reviewed_spans VALUES(?,?,?,?,?,?)').run('daily','history','long',0,30,180);
    c.limits.chunk_body_bytes=60;
    const pending=units(await r.prepare({kind:'daily',lane:'live',cutoff})).filter(e=>(e.context.review_slice as any)?.source_event_id==='long');
    assert(pending.length);assert(pending.every(e=>(e.context.review_slice as any).start_byte>=30));assert(pending.every(e=>!e.body!.includes('\ufffd')));s.close();
});
test('skip_units are validated original UTF-8 intervals and suppress only this preparation before slice allocation',async()=>{
    const c=await config();c.limits.chunk_body_bytes=9;c.limits.bundles_per_round=1;const s=await createStore(c),r=createReviewer(s,c),e=event('unicode','你'.repeat(20),'2026-10-05T09:00:00Z');await s.saveCollection(collection([e]));
    const skip=[{schema_version:1 as const,event_id:e.event_id,start_byte:0,end_byte:15}];
    const b=await r.prepare({kind:'daily',lane:'live',cutoff,skip_units:skip});assert.equal((units(b)[0].context.review_slice as any).start_byte,15);
    assert.equal(s.getReviewedSpans('daily','live',e.event_id).length,0);
    assert.equal((units(await r.prepare({kind:'daily',lane:'live',cutoff}))[0].context.review_slice as any).start_byte,0);
    for(const bad of [{...skip[0],event_id:'missing'},{...skip[0],start_byte:1},{...skip[0],end_byte:61}]) await assert.rejects(r.prepare({kind:'daily',lane:'live',cutoff,skip_units:[bad]}),/skip_units/);
    s.close();
});
test('automatic empty, skipped and unfinished material produces no semantic starts; explicit page review remains available',async()=>{
    const c=await config(),s=await createStore(c),r=createReviewer(s,c);
    assert.deepEqual(await r.prepare({kind:'daily',lane:'live',cutoff}),[]);
    const e=event('unfinished','unfinished assistant','2026-10-05T09:00:00Z');e.role='assistant';e.context.incomplete_turn=true;await s.saveCollection(collection([e]));
    assert.deepEqual(await r.prepare({kind:'daily',lane:'live',cutoff}),[]);
    assert.equal((await s.listOutbox()).length,0);assert.equal((await s.status()).results,0);
    const empty=await r.prepareWithOutcomes!({kind:'daily',lane:'live',period:'2026-10-05',cutoff});assert.deepEqual(empty.bundles,[]);assert.equal(empty.providers[0].preparation!.state,'exhausted');assert.equal(empty.providers[0].execution_status,'partial');
    assert.equal((await r.prepare({kind:'daily',lane:'live',period:'2026-10-05',cutoff,page_paths:['wiki/personal/journals/日记_2026_10_05.md']})).length,1);s.close();
});
test('whole-event skips precede the finite SQL page so earlier failures cannot starve a later peer event',async()=>{
    const c=await config();c.limits.chunk_events=1;c.limits.bundles_per_round=1;const s=await createStore(c),r=createReviewer(s,c);
    const events=Array.from({length:6},(_,i)=>event('before:'+i,'skipped','2026-10-05T09:00:00Z')),later=event('later','usable','2026-10-05T10:00:00Z');await s.saveCollection(collection([...events,later]));
    const prepared=await r.prepare({kind:'daily',lane:'live',cutoff,skip_units:events.map(e=>({schema_version:1 as const,event_id:e.event_id,start_byte:0,end_byte:Buffer.byteLength(e.body!)}))});
    assert.deepEqual(units(prepared).map(e=>e.event_id),['later']);assert.equal(s.getReviewedUnits('daily','live').size,0);s.close();
});
test('missing dispositions creates precise revision/date/path debt; unrelated page publication cannot close it',async()=>{
    const c=await config(),s=await createStore(c),b=bundle();await s.saveBundle(b);const review=result(b);review.pages=[];const commit=await s.commitReview(review);
    const work=(await s.listWork('journal_publication'))[0],payload=work.payload as unknown as JournalPublicationPayload;
    assert.deepEqual(payload.fact_ref,{schema_version:1,fact_id:commit.facts[0].fact_id,revision:1});assert.equal(payload.date,'2026-09-30');assert.equal(payload.path,b.baselines[0].path);assert.equal(work.state,'pending');
    await s.saveFileIntent({schema_version:1,operation_id:'unrelated',path:'log.md',baseline_digest:'absent',desired_digest:digest('other'),desired_bytes_base64:Buffer.from('other').toString('base64'),backup_bytes_base64:null,state:'prepared',fact_refs:[],created_at:cutoff,reason:null});await s.updateFileIntent('unrelated','applied');
    assert.equal((await s.listWork('journal_publication'))[0].state,'pending');assert.equal(((await s.status()).journal_publication as any).unresolved,1);s.close();
});
test('replace/retract debt includes actual old and new dates and historical targets use monthly supplement paths',async()=>{
    const c=await config(),s=await createStore(c),old=bundle([event('old','original','2026-06-01T09:00:00Z')],'old');await s.saveBundle(old);const original=result(old,'original');original.pages=[];original.candidates[0].journal_date=value('2026-06-01');const f=(await s.commitReview(original)).facts[0]!;
    const changed=bundle([event('new','correction','2026-09-30T09:00:00Z')],'new');changed.existing_facts=[f];await s.saveBundle(changed);const rr=result(changed,'changed');rr.pages=[];rr.candidates[0].disposition='replace';rr.candidates[0].target_refs=[{schema_version:1,fact_id:f.fact_id,revision:f.revision}];const replacement=(await s.commitReview(rr)).facts[0]!;
    const debt=(await s.listWork('journal_publication')).filter(w=>(w.payload.fact_ref as any).revision===2);
    assert.deepEqual(debt.map(w=>w.payload.date).sort(),['2026-06-01','2026-09-30']);assert(debt.find(w=>w.payload.date==='2026-06-01')!.payload.path?.toString().includes('回顾_2026_06'));
    const retract=bundle([event('withdraw','withdrawal')],'withdraw');retract.existing_facts=[replacement];await s.saveBundle(retract);const withdrawal=result(retract,'withdrawal');withdrawal.pages=[];withdrawal.candidates[0].disposition='retract';withdrawal.candidates[0].journal_date=value('2026-10-01');withdrawal.candidates[0].target_refs=[{schema_version:1,fact_id:f.fact_id,revision:2}];await s.commitReview(withdrawal);
    assert.deepEqual((await s.listWork('journal_publication')).filter(w=>(w.payload.fact_ref as any).revision===3).map(w=>w.payload.date).sort(),['2026-09-30','2026-10-01']);s.close();
});
test('file-only journal resolution uses frozen accepted refs and baseline, persists no source semantic state, and is idempotent',async()=>{
    const c=await config(),s=await createStore(c),r=createReviewer(s,c),b=bundle();await s.saveBundle(b);const review=result(b);review.pages=[];const commit=await s.commitReview(review);
    const before=Object.fromEntries(['facts','results','outbox','reviewed_units','reviewed_spans','reviewed_sources'].map(table=>[table,s.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n]));
    const j=await r.prepareJournalWork!({schema_version:1,cutoff});assert.equal(j.facts[0]!.revision,commit.facts[0]!.revision);
    const work=j.work[0]!,payload=work.payload as unknown as JournalPublicationPayload;
    const resolution:JournalResolution={schema_version:1,resolution_id:'resolve',journal_bundle_id:j.journal_bundle_id,created_at:cutoff,dispositions:[{schema_version:1,work_id:work.work_id,disposition:'patch',suggestion_id:'p',reason:null}],pages:[{schema_version:1,suggestion_id:'p',work_ids:[work.work_id],date:payload.date,path:payload.path,baseline_digest:j.baselines[0]!.digest,mode:'append',old_text:null,new_text:'Accepted fact display\n'}]};
    const resolved=await s.commitJournalResolution(resolution);assert.equal(resolved.patches.length,1);assert.equal((await s.listWork('journal_publication'))[0]!.state,'pending');
    assert.equal((await s.commitJournalResolution(resolution)).reused,true);
    for(const [table,n] of Object.entries(before))assert.equal(s.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n,n);
    await s.markPatchStatus(resolved.patches[0]!.operation_id,'applied');assert.equal((await s.listWork('journal_publication'))[0]!.state,'complete');s.close();
});
test('already_present requires exact visible baseline evidence and completes only selected accepted work',async()=>{
    const c=await config(),s=await createStore(c),r=createReviewer(s,c),b=bundle();await s.saveBundle(b);const review=result(b);review.pages=[];await s.commitReview(review);
    const path=b.baselines[0]!.path;await mkdir(dirname(join(c.wiki_root,path)),{recursive:true});await writeFile(join(c.wiki_root,path),'Human existing verified paragraph\n');
    const j=await r.prepareJournalWork!({schema_version:1,cutoff});const base={schema_version:1 as const,resolution_id:'existing',journal_bundle_id:j.journal_bundle_id,created_at:cutoff,pages:[],dispositions:[{schema_version:1 as const,work_id:j.work[0]!.work_id,disposition:'already_present' as const,reason:'Exact existing fact display'}]};
    await s.commitJournalResolution(base);assert.equal((await s.listWork('journal_publication'))[0]!.state,'deferred');const current=await r.prepareJournalWork!({schema_version:1,cutoff});base.journal_bundle_id=current.journal_bundle_id;base.resolution_id='existing-strong';
    const withEvidence={...base,dispositions:[{...base.dispositions[0]!,evidence_text:'Human existing verified paragraph',baseline_assessment:strongAssessment(j.baselines[0]!.content)}]};await s.commitJournalResolution(withEvidence);assert.equal((await s.listWork('journal_publication'))[0]!.state,'complete');s.close();
});
test('initial already_present becomes deferred debt after a manual baseline change, while file-only already_present rejects stale evidence',async()=>{
    const c=await config(),s=await createStore(c),r=createReviewer(s,c),b=bundle(),path=b.baselines[0]!.path,original='Verified parser visible\n';await mkdir(dirname(join(c.wiki_root,path)),{recursive:true});await writeFile(join(c.wiki_root,path),original);b.baselines[0]={schema_version:1,path,digest:digest(original),content:original};await s.saveBundle(b);
    const rr=result(b);rr.pages=[];rr.journal_dispositions=[{schema_version:1,candidate_id:rr.candidates[0]!.candidate_id,date:'2026-09-30',path,disposition:'already_present',reason:'Visible exact display',evidence_text:'Verified parser visible'} as any];
    await writeFile(join(c.wiki_root,path),'Human removed that paragraph\n');const committed=await s.commitReview(rr);assert.equal(committed.facts.length,1);assert.equal((await s.listWork('journal_publication'))[0]!.state,'deferred');
    const j=await r.prepareJournalWork!({schema_version:1,cutoff});await writeFile(join(c.wiki_root,path),'Human changed again\n');
    await assert.rejects(s.commitJournalResolution({schema_version:1,resolution_id:'stale',journal_bundle_id:j.journal_bundle_id,created_at:cutoff,pages:[],dispositions:[{schema_version:1,work_id:j.work[0]!.work_id,disposition:'already_present',reason:'Exact original',evidence_text:'Human removed that paragraph'} as any]}),/Current journal baseline changed/);
    assert.equal((await s.listWork('journal_publication'))[0]!.state,'deferred');s.close();
});
test('conflicts before FileIntent exist are queried; one replacement terminally supersedes old operations and second remains deferred',async()=>{
    const c=await config(),s=await createStore(c),r=createReviewer(s,c),b=bundle();await s.saveBundle(b);const commit=await s.commitReview(result(b));const original=commit.patches[0]!;await s.markPatchStatus(original.operation_id,'conflict','Human changed baseline');
    assert.equal((await s.listPendingPatches()).length,1);assert.equal((await s.listJournalConflicts())[0]!.operation_id,original.operation_id);
    const path=original.path;await mkdir(dirname(join(c.wiki_root,path)),{recursive:true});await writeFile(join(c.wiki_root,path),'Human new baseline\n');
    const prepare=()=>r.prepareJournalWork!({schema_version:1,cutoff});const j=await prepare(),w=j.work[0]!;
    const make=(jb:typeof j,id:string,oldOp:string):JournalResolution=>({schema_version:1,resolution_id:id,journal_bundle_id:jb.journal_bundle_id,created_at:cutoff,dispositions:[{schema_version:1,work_id:w.work_id,disposition:'patch',suggestion_id:'p',reason:null}],pages:[{schema_version:1,suggestion_id:'p',work_ids:[w.work_id],date:original.date,path,baseline_digest:jb.baselines[0]!.digest,mode:'append',old_text:null,new_text:'Regenerated accepted prose\n',supersedes_operation_id:oldOp}]});
    const omitted=make(j,'missing-supersedes',original.operation_id);delete omitted.pages[0]!.supersedes_operation_id;
    await assert.rejects(s.commitJournalResolution(omitted),/requires explicit supersedes_operation_id/);
    assert.equal((await s.listPendingPatches()).length,1);assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM journal_resolutions').get()!.n,0);
    const repaired=await s.commitJournalResolution(make(j,'repair',original.operation_id));assert.equal(await s.getOperationSupersession(original.operation_id),repaired.patches[0]!.operation_id);assert.equal((await s.listPendingPatches()).length,1);assert.equal(s.db.prepare('SELECT status FROM patches WHERE id=?').get(original.operation_id)!.status,'superseded');
    assert.equal((await s.commitJournalResolution(make(j,'repair',original.operation_id))).reused,true);assert.equal((await s.listPendingPatches()).length,1);
    await assert.rejects(s.markPatchStatus(original.operation_id,'pending'),/terminal/);
    await s.markPatchStatus(repaired.patches[0]!.operation_id,'conflict','Changed again');
    const again=await s.commitJournalResolution(make(await prepare(),'second',repaired.patches[0]!.operation_id));assert.equal(again.patches.length,0);assert.equal((await s.listWork('journal_publication'))[0]!.state,'deferred');assert.equal((await s.listJournalConflicts()).length,1);s.close();
});
test('journal replacement cannot mix unfinished debts from two distinct original operations',async()=>{
    const c=await config(),s=await createStore(c),r=createReviewer(s,c),a=bundle([event('first')],'first'),b=bundle([event('second')],'second');
    await s.saveBundle(a);const first=await s.commitReview(result(a,'first'));await s.saveBundle(b);const second=await s.commitReview(result(b,'second'));
    const j=await r.prepareJournalWork!({schema_version:1,cutoff}),ids=j.work.map(w=>w.work_id);
    const resolution:JournalResolution={schema_version:1,resolution_id:'mixed',journal_bundle_id:j.journal_bundle_id,created_at:cutoff,dispositions:ids.map(work_id=>({schema_version:1,work_id,disposition:'patch',suggestion_id:'p',reason:null})),pages:[{schema_version:1,suggestion_id:'p',work_ids:ids,date:first.patches[0]!.date,path:first.patches[0]!.path,baseline_digest:j.baselines[0]!.digest,mode:'append',old_text:null,new_text:'Both exact facts',supersedes_operation_id:first.patches[0]!.operation_id}]};
    for(let retry=0;retry<2;retry++)await assert.rejects(s.commitJournalResolution(resolution),/selected work operation/);
    assert.deepEqual((await s.listPendingPatches()).map(p=>p.operation_id),[first.patches[0]!.operation_id,second.patches[0]!.operation_id]);assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM operation_supersessions').get()!.n,0);assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM journal_resolutions').get()!.n,0);s.close();
});
test('unreadable current journal evidence defers its display independently while the exact facts and export commit',async()=>{
    const c=await config(),s=await createStore(c),b=bundle(),path=b.baselines[0]!.path,content='Frozen accepted display';b.baselines[0]={schema_version:1,path,digest:digest(content),content};await s.saveBundle(b);
    const rr=result(b);rr.pages=[];rr.journal_dispositions=[{schema_version:1,candidate_id:rr.candidates[0]!.candidate_id,date:'2026-09-30',path,disposition:'already_present',reason:'Original exact display',evidence_text:content} as any];
    await mkdir(dirname(join(c.wiki_root,path)),{recursive:true});await symlink(join(c.data_dir,'synthetic-missing-target'),join(c.wiki_root,path));
    const committed=await s.commitReview(rr);assert.equal(committed.facts.length,1);assert.equal((await s.listOutbox()).length,1);assert.equal((await s.listWork('journal_publication'))[0]!.state,'deferred');s.close();
});
test('bounded accepted-time inventory includes revisions and conflicts; recovery is idempotent without rewriting accepted state',async()=>{
    const c=await config(),s=await createStore(c),b=bundle();await s.saveBundle(b);const rr=result(b);rr.created_at='2026-10-02T09:00:00Z';const commit=await s.commitReview(rr);await s.markPatchStatus(commit.patches[0]!.operation_id,'conflict','Synthetic baseline conflict');
    // Simulate schema_version 1 accepted history before journal debt was deployed.
    s.db.prepare("DELETE FROM work WHERE kind='journal_publication'").run();s.db.prepare('DELETE FROM acceptance_times').run();
    const old=canonical(await s.getReviewResult(rr.result_id)),inventory=await s.inventoryAcceptedDaily({from:'2026-10-01T22:00:00Z',to:cutoff,limit:1});assert.equal(inventory.items.length,1);assert.equal(inventory.items[0]!.facts[0]!.revision,1);assert.equal(inventory.items[0]!.conflicts.length,1);assert.equal(inventory.items[0]!.accepted_at.value,null);assert.equal(inventory.items[0]!.window_membership,'unknown');assert.equal(inventory.items[0]!.result_created_at,rr.created_at);
    const recovered=await s.recoverJournalPublication({schema_version:1,result_ids:[rr.result_id],created_at:cutoff});assert.equal(recovered.work_ids.length,1);assert.deepEqual(await s.recoverJournalPublication({schema_version:1,result_ids:[rr.result_id],created_at:cutoff}),recovered);
    assert.equal(canonical(await s.getReviewResult(rr.result_id)),old);assert.equal((await s.listOutbox()).length,1);s.close();
});
test('source status separates actual read time, unknown unread bytes and oldest unreviewed material from command success',async()=>{
    const c=await config(),s=await createStore(c);const batch=collection([event()]);await s.saveCollection(batch);const first=(await s.status()).sources as any[];assert.equal(Date.parse(first[0]!.last_read_at),Date.parse('2026-09-30T10:00:00Z'));assert.equal(Date.parse(first[0]!.oldest_unreviewed_at.value),Date.parse('2026-09-30T09:00:00Z'));assert.equal(first[0]!.unread.value,null);
    const noRead=collection([],'live','metadata-only');noRead.checkpoints[0]!.updated_at=cutoff;await s.saveCollection(noRead);assert.equal(((await s.status()).sources as any[])[0]!.last_read_at,first[0]!.last_read_at);s.close();
});
test('new acceptance inventory uses the injected transaction clock and never substitutes model result_created_at',async()=>{
    const c=await config(),s=await createStore(c,{now:()=>new Date('2026-10-02T09:00:00Z')}),b=bundle();await s.saveBundle(b);const rr=result(b);assert.equal(rr.created_at,'2026-09-30T10:00:00.000Z');await s.commitReview(rr);
    const inventory=await s.inventoryAcceptedDaily({from:'2026-10-01T22:00:00Z',to:cutoff});assert.equal(inventory.items.length,1);const item=inventory.items[0]!;assert.equal(Date.parse(item.accepted_at.value!),Date.parse('2026-10-02T09:00:00Z'));assert.equal(item.acceptance_time_basis,'store_transaction_clock');assert.equal(item.window_membership,'included');assert.equal(item.result_created_at,rr.created_at);assert.equal(item.facts[0]!.recorded_at,rr.created_at);
    assert.equal((await s.inventoryAcceptedDaily({from:'2026-09-29T00:00:00Z',to:'2026-10-01T00:00:00Z'})).items.length,0);s.close();
});
test('keep without pages creates missing exact accepted-reference debt and explicit already_present updates it without new facts',async()=>{
    const c=await config(),s=await createStore(c),b=bundle();await s.saveBundle(b);const first=result(b);first.pages=[];const f=(await s.commitReview(first)).facts[0]!;s.db.prepare("DELETE FROM work WHERE kind='journal_publication'").run();
    const keep=bundle([event('keep-evidence')],'keep');keep.existing_facts=[f];await s.saveBundle(keep);const rr=result(keep,'keep-result');rr.pages=[];rr.candidates[0]!.disposition='keep';rr.candidates[0]!.target_refs=[{schema_version:1,fact_id:f.fact_id,revision:f.revision}];assert.equal((await s.commitReview(rr)).facts.length,0);
    const pending=(await s.listWork('journal_publication'))[0]!;assert.deepEqual((pending.payload as unknown as JournalPublicationPayload).fact_ref,rr.candidates[0]!.target_refs[0]);assert.equal(pending.state,'pending');
    const path=b.baselines[0]!.path,text=f.content+'\n';await mkdir(dirname(join(c.wiki_root,path)),{recursive:true});await writeFile(join(c.wiki_root,path),text);
    const seen=bundle([event('seen-evidence')],'seen');seen.existing_facts=[f];seen.baselines=[{schema_version:1,path,digest:digest(text),content:text}];await s.saveBundle(seen);const present=result(seen,'seen-result');present.pages=[];present.candidates[0]!.disposition='keep';present.candidates[0]!.target_refs=rr.candidates[0]!.target_refs;present.journal_dispositions=[{schema_version:1,candidate_id:present.candidates[0]!.candidate_id,date:'2026-09-30',path,disposition:'already_present',reason:'Exact existing paragraph',evidence_text:f.content,baseline_assessment:strongAssessment(text)} as any];
    assert.equal((await s.commitReview(present)).facts.length,0);assert.equal((await s.listWork('journal_publication'))[0]!.state,'complete');assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM facts').get()!.n,1);assert.equal((await s.listWork('journal_publication')).length,1);s.close();
});
test('explicit keep decision terminalizes old unfinished publication only when every linked debt is complete and does not consume replacement quota',async()=>{
    const c=await config(),s=await createStore(c),b=bundle();await s.saveBundle(b);const original=await s.commitReview(result(b)),f=original.facts[0]!,operation=original.patches[0]!.operation_id;
    const next=bundle([event('keep-next')],'keep-next');next.existing_facts=[f];await s.saveBundle(next);const kept=result(next,'keep-not-needed');kept.pages=[];kept.candidates[0]!.disposition='keep';kept.candidates[0]!.target_refs=[{schema_version:1,fact_id:f.fact_id,revision:1}];kept.journal_dispositions=[{schema_version:1,candidate_id:kept.candidates[0]!.candidate_id,date:'2026-09-30',path:b.baselines[0]!.path,disposition:'not_needed',reason:'Explicitly declined journal display',baseline_assessment:strongAssessment(null)}];
    const held=await acquireWikiLock(c.wiki_root);assert(held);await s.commitReview(kept);assert.equal((await s.listWork('journal_publication'))[0]!.state,'deferred');assert.equal(await s.getOperationSupersession(operation),null);await held.release();
    const r=createReviewer(s,c),journal=await r.prepareJournalWork!({schema_version:1,cutoff}),resolution:JournalResolution={schema_version:1,resolution_id:'terminal-decision',journal_bundle_id:journal.journal_bundle_id,created_at:cutoff,pages:[],dispositions:[{schema_version:1,work_id:journal.work[0]!.work_id,disposition:'not_needed',reason:'Explicitly declined journal display',baseline_assessment:strongAssessment(null)}]};
    const busy=await acquireWikiLock(c.wiki_root);assert(busy);await assert.rejects(s.commitJournalResolution(resolution),/lock unavailable/);assert.equal(await s.getOperationSupersession(operation),null);await busy.release();
    await s.commitJournalResolution(resolution);assert.equal(await s.getOperationSupersession(operation),'terminal:terminal-decision');assert.equal((await s.listPendingPatches()).length,0);assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM operation_supersessions').get()!.n,0);await assert.rejects(s.markPatchStatus(operation,'pending'),/terminal/);s.close();
});
test('recovered retired revisions can be explicitly not_needed with frozen current correction proof, while patch cannot resurrect them',async()=>{
    const c=await config(),s=await createStore(c),b=bundle();await s.saveBundle(b);const original=result(b,'old-result');original.pages=[];const first=(await s.commitReview(original)).facts[0]!;
    const corrected=bundle([event('corrected')],'corrected');corrected.existing_facts=[first];await s.saveBundle(corrected);const rr=result(corrected,'corrected-result');rr.pages=[];rr.candidates[0]!.disposition='replace';rr.candidates[0]!.target_refs=[{schema_version:1,fact_id:first.fact_id,revision:1}];rr.candidates[0]!.content='Current corrected fact';await s.commitReview(rr);
    s.db.prepare("DELETE FROM work WHERE kind='journal_publication'").run();const recovered=await s.recoverJournalPublication({schema_version:1,result_ids:[original.result_id],created_at:cutoff});assert.equal(recovered.work_ids.length,1);
    const r=createReviewer(s,c),j=await r.prepareJournalWork!({schema_version:1,cutoff,work_ids:recovered.work_ids});assert(j.existing_facts.some(f=>f.fact_id===first.fact_id && f.revision===2));
    const bad:JournalResolution={schema_version:1,resolution_id:'old-patch',journal_bundle_id:j.journal_bundle_id,created_at:cutoff,dispositions:[{schema_version:1,work_id:j.work[0]!.work_id,disposition:'patch',suggestion_id:'p',reason:null}],pages:[{schema_version:1,suggestion_id:'p',work_ids:[j.work[0]!.work_id],date:j.work[0]!.payload.date as string,path:j.work[0]!.payload.path as string,baseline_digest:j.baselines[0]!.digest,mode:'append',old_text:null,new_text:'Old fact must not return'}]};await assert.rejects(s.commitJournalResolution(bad),/Stale journal fact/);
    const before=Object.fromEntries(['facts','results','outbox','reviewed_sources'].map(table=>[table,s.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n]));await s.commitJournalResolution({schema_version:1,resolution_id:'retire-old',journal_bundle_id:j.journal_bundle_id,created_at:cutoff,pages:[],dispositions:[{schema_version:1,work_id:j.work[0]!.work_id,disposition:'not_needed',reason:'Exact r1 was replaced by the frozen current r2 proof'}]});assert.equal((await s.listWork('journal_publication'))[0]!.state,'complete');for(const [table,n]of Object.entries(before))assert.equal(s.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n,n);s.close();
});
test('known-file unread observations exclude discovery/scoped scans and do not claim a global total across generations',async()=>{
    const c=await config(),s=await createStore(c),batch=collection([]),cp=batch.checkpoints[0]!;cp.cursor={account_id:c.providers[0]!.account_id,identity:'source-identity',source_scope:'current',unread_bytes:100,last_read_at:cutoff};cp.generation='current';
    batch.checkpoints.push({...cp,checkpoint_id:'discovery',locator:'@discovery',cursor:{account_id:c.providers[0]!.account_id,source_scope:'current'}},{...cp,checkpoint_id:'scoped',cursor:{...cp.cursor,manual_capture_scope:'manual',unread_bytes:9999}},{...cp,checkpoint_id:'old-generation',locator:'/synthetic/old-copy',generation:'old',cursor:{...cp.cursor,source_scope:'old',unread_bytes:5000,last_read_at:'2026-10-01T09:00:00Z'}});
    await s.saveCollection(batch);const source=((await s.status()).sources as any[])[0]!;assert.equal(source.unread.value,null);assert.equal(source.known_file_unread_bytes.value,100);s.close();
});
test('unfinished primary prefixes never occupy the finite candidate SQL page and their source debt is never completed',async()=>{
    const c=await config(),s=await createStore(c),r=createReviewer(s,c);c.limits.bundles_per_round=1;c.limits.chunk_events=1;
    const unfinished=Array.from({length:12},(_,i)=>{const e=event('unfinished-prefix:'+i,'Unfinished material','2026-10-05T08:00:00Z');if(i%2){e.role='assistant';e.context.turn_complete=false;}else{e.context.incomplete_turn=true;}return e;}),human=event('complete-human','Captured human input','2026-10-05T09:00:00Z');human.context.turn_complete=false;
    await s.saveCollection(collection([...unfinished,human]));const normal=await r.prepare({kind:'daily',lane:'live',cutoff});assert.deepEqual(units(normal).map(e=>e.event_id),[human.event_id]);await s.commitReview(result(normal[0]!,'only-human',false));assert(unfinished.every(e=>!s.getReviewedUnits('daily','live').has(e.event_id)));
    const replay=await s.requestSemanticReplay({schema_version:1,replay_key:'unfinished-prefix',source:'synthetic',range:{schema_version:1,from:'2026-10-05T00:00:00Z',to:cutoff},cutoff});const material=await r.prepare({kind:'daily',lane:'history',cutoff,replay_id:replay.work_id});assert.deepEqual(units(material).map(e=>e.event_id),[human.event_id]);await s.commitReview(result(material[0]!,'replay-human',false));assert.equal((await s.getSemanticReplay(replay.work_id))!.state,'pending');assert(unfinished.every(e=>!s.getReviewedUnits('replay:'+replay.work_id,'history').has(e.event_id)));s.close();
});
