import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, canonical } from '../../src/store/index.ts';
import { createReviewer } from '../../src/review/index.ts';
import { config, event, collection, result, range, value, bundle } from '../store/fixtures.ts';

const cutoff='2026-09-30T23:00:00.000Z';
test('long UTF-8 message uses bounded stable slices; reviewing one slice cannot swallow remainder',async()=>{
 const c=await config();c.limits.chunk_body_bytes=128;c.limits.chunk_events=2;c.limits.bundle_bytes=8192;c.limits.bundles_per_round=1;
 const s=await createStore(c);const original=event('long','你'.repeat(250));await s.saveCollection(collection([original]));const reviewer=createReviewer(s,c);const prepared=await reviewer.prepare({kind:'daily',lane:'live',cutoff});assert.equal(prepared.length,1);assert.ok(Buffer.byteLength(canonical(prepared[0]))<=8192);assert.ok(prepared[0].chunks.length>=1);
 const first=prepared[0].chunks[0];assert.ok(first.body_bytes<=128);assert.notEqual(first.events[0].event_id,original.event_id);assert.equal((first.events[0].context.review_slice as any).start_byte,0);assert.ok(!first.events[0].body!.includes('\ufffd'));
 const accepted=result(prepared[0],'one-slice',false);accepted.chunks=accepted.chunks.slice(0,1);await reviewer.accept(accepted);assert.equal((await s.listCoverage(range))[0].review_status,'partial');
 c.limits.chunk_body_bytes=256;
 const next=await reviewer.prepare({kind:'daily',lane:'live',cutoff});const remaining=next.flatMap(b=>b.chunks.flatMap(c=>c.events));assert.ok(remaining.length>0);assert.ok(remaining.every(e=>(e.context.review_slice as any).start_byte>0));assert.ok(remaining.every(e=>e.event_id!==first.events[0].event_id));
 for(let pass=0;pass<10;pass++){const bundles=await reviewer.prepare({kind:'daily',lane:'live',cutoff});if(!bundles.length)break;for(const [i,b]of bundles.entries())await reviewer.accept(result(b,'finish:'+pass+':'+i,false));}
 assert.equal((await s.listCoverage(range))[0].review_status,'complete');assert.deepEqual(await reviewer.prepare({kind:'daily',lane:'live',cutoff}),[]);s.close();
});

test('daily review progress is shared across transport lanes while weekly/monthly receive facts without chat refacts',async()=>{
 const c=await config();const s=await createStore(c);const e=event();await s.saveCollection(collection([e],'live'));await s.saveCollection(collection([e],'history','history-copy'));const r=createReviewer(s,c);const live=(await r.prepare({kind:'daily',lane:'live',cutoff}))[0];await r.accept(result(live,'live-result'));
 assert.deepEqual(await r.prepare({kind:'daily',lane:'history',cutoff}),[]);
 for(const batch of await s.listOutbox())await s.markExportReady(batch.batch_id,c.data_dir+'/ready.json');
 const weekly=(await r.prepare({kind:'weekly',lane:'live',period:'2026-10-04',cutoff}))[0];assert.equal(weekly.chunks[0].events.length,0);assert.equal(weekly.analysis_context!.facts.length,1);assert.equal(weekly.analysis_context!.facts[0].projection.summary,'Verified parser');assert.ok(weekly.unfinished.some(g=>g.reason.includes('coverage')));
 const monthly=(await r.prepare({kind:'monthly',lane:'history',period:'2026-09',cutoff}))[0];assert.equal(monthly.chunks[0].events.length,0);assert.equal(monthly.monthly_context!.facts.length,1);s.close();
});

test('capture absence/unknown is explicit and accepting zero facts cannot claim empty day coverage',async()=>{
 const c=await config();const s=await createStore(c);const r=createReviewer(s,c);const noCapture=(await r.prepare({kind:'daily',lane:'live',cutoff}))[0];assert.ok(noCapture.unfinished.some(g=>g.reason.includes('No capture')));await r.accept(result(noCapture,'no-source',false));assert.deepEqual((await s.listOutbox())[0].artifact.coverage,[]);
 const batch=collection([]);batch.coverage[0].capture_status='unknown';batch.coverage[0].gaps=[{schema_version:1,range,reason:'unread prefix',locator:'synthetic',resumable:true}];await s.saveCollection(batch);const partial=(await r.prepare({kind:'daily',lane:'live',cutoff}))[0];await r.accept(result(partial,'unknown-source',false));assert.equal((await s.listOutbox()).at(-1)!.artifact.coverage[0].review_status,'pending');s.close();
});

test('multi-day batches expose separate page baselines and historical dates target a monthly addendum',async()=>{
 const c=await config();const s=await createStore(c);const events=[event('first','A','2026-09-29T22:00:00.000Z'),event('second','B','2026-09-30T10:00:00.000Z')];events[0].journal_date=value('2026-09-30');events[1].journal_date=value('2026-10-01');await s.saveCollection(collection(events));const r=createReviewer(s,c);const prepared=await r.prepare({kind:'daily',lane:'live',cutoff});const paths=prepared.flatMap(b=>b.baselines.map(p=>p.path));assert.ok(paths.some(p=>p.includes('日记_2026_09_30')));assert.ok(paths.some(p=>p.includes('日记_2026_10_01')));
 const old=event('old','History','2026-06-01T10:00:00Z');await s.saveCollection(collection([old],'history','old-batch'));const historical=await r.prepare({kind:'daily',lane:'history',period:'2026-06-01',cutoff});assert.ok(historical.flatMap(b=>b.baselines).every(p=>p.path.includes('回顾_2026_06')));s.close();
});

test('period boundaries use historical timezone timeline and normalize equal timestamp formatting',async()=>{
 const c=await config();c.journal_timezone='Europe/Amsterdam';c.journal_timezone_timeline=[{schema_version:1,effective_from:'2026-01-01T00:00:00Z',timezone:'Asia/Shanghai',basis:'travel'}];const s=await createStore(c);
 const before=event('before','Excluded','2026-06-01T15:59:59Z');const exact=event('exact','Included','2026-06-01T16:00:00Z');const after=event('after','Excluded','2026-06-02T16:00:00.000Z');await s.saveCollection(collection([before,exact,after],'history','time-batch'));
 const prepared=await createReviewer(s,c).prepare({kind:'daily',lane:'history',period:'2026-06-02',cutoff});assert.deepEqual(prepared.flatMap(b=>b.chunks.flatMap(c=>c.events)).map(e=>e.event_id),['exact']);assert.deepEqual((await s.listEvents({range:{schema_version:1,from:'2026-06-01T16:00:00.000Z',to:'2026-06-02T16:00:00Z'},lane:'history'})).map(e=>e.event_id),['exact']);s.close();
});

test('conversation context is separately labeled; unfinished turns stay pending while other conversations proceed',async()=>{
 const c=await config();c.limits.chunk_events=1;const s=await createStore(c);const prior=event('prior','Roy requested verification','2026-09-30T08:00:00Z');const final=event('final','Verified parser','2026-09-30T09:00:00Z');final.role='assistant';const incomplete=event('incomplete','unfinished');incomplete.context.turn_complete=false;incomplete.source.conversation_id='another';await s.saveCollection(collection([prior,final,incomplete]));
 const prepared=await createReviewer(s,c).prepare({kind:'daily',lane:'live',cutoff});const chunks=prepared.flatMap(b=>b.chunks);assert.ok(chunks.find(c=>c.events[0]?.event_id==='final')!.context_events.some(e=>e.event_id==='prior'));assert.ok(!chunks.some(c=>c.events.some(e=>e.event_id==='incomplete')));assert.ok(prepared.some(b=>b.unfinished.some(g=>g.reason.includes('Incomplete'))));s.close();
});

test('bounded preparation explicitly reports omitted fact/coverage context and excludes private facts from weekly',async()=>{
 const c=await config();c.limits.bundle_bytes=8192;const s=await createStore(c);const b=bundle();await s.saveBundle(b);const accepted=result(b);accepted.candidates[0].content='private health secret';accepted.candidates[0].analytics_projection={schema_version:1,value:null,reason:'No professional projection'};accepted.pages=[];await s.commitReview(accepted);
 const weekly=(await createReviewer(s,c).prepare({kind:'weekly',lane:'live',period:'2026-10-04',cutoff}))[0];assert.equal(weekly.analysis_context!.facts.length,0);assert.ok(!canonical(weekly).includes('private health secret'));assert.ok(weekly.unfinished.some(g=>g.reason.includes('projections are excluded')));s.close();
});

test('all bounded bundles retain a metadata omission warning when hundreds of coverage rows cannot fit',async()=>{
 const c=await config();c.limits.bundle_bytes=6144;c.limits.chunk_events=1;c.limits.bundles_per_round=4;const s=await createStore(c),events=Array.from({length:5},(_,i)=>event('bounded:'+i,'x'.repeat(256)));const batch=collection(events);batch.coverage=Array.from({length:158},(_,i)=>({...batch.coverage[0],coverage_id:'scope:'+i,conversation_id:'chat:'+i}));await s.saveCollection(batch);const prepared=await createReviewer(s,c).prepare({kind:'daily',lane:'live',cutoff});assert(prepared.length);for(const b of prepared){assert(Buffer.byteLength(canonical(b))<=c.limits.bundle_bytes);assert(b.coverage.length<158);assert(b.unfinished.some(g=>g.reason.includes('Bounded preparation metadata omitted')));}s.close();
});

test('explicit page maintenance uses full digest and bounded excerpt, allows visible local replacement and does not pretend empty-day coverage',async()=>{
 const {mkdir,writeFile}=await import('node:fs/promises');const {join}=await import('node:path');const c=await config();c.limits.bundle_bytes=8192;await mkdir(join(c.wiki_root,'wiki/projects'),{recursive:true});const path='wiki/projects/project_a.md',content='visible local sentence\n'+'x'.repeat(16000)+'hidden tail';await writeFile(join(c.wiki_root,path),content);const s=await createStore(c);await s.saveCollection(collection([]));const reviewer=createReviewer(s,c),b=(await reviewer.prepare({kind:'daily',lane:'live',cutoff,page_paths:[path,'../escape.md']}))[0];const baseline=b.baselines.find(p=>p.path===path)!;assert.equal(baseline.context_excerpt,true);assert(baseline.content!.length<content.length);assert(b.unfinished.some(g=>g.reason.includes('Unsafe Wiki path')));const r=result(b,'visible-maintenance',false);r.pages=[{schema_version:1,suggestion_id:'project:edit',date:'2026-09-30',path,baseline_digest:baseline.digest,mode:'replace',old_text:'visible local sentence',new_text:'Reviewed local sentence',candidate_ids:[]}];const hidden=structuredClone(r);hidden.result_id='hidden';hidden.pages[0].old_text='hidden tail';await assert.rejects(reviewer.accept(hidden),/visible in supplied excerpt/);const commit=await reviewer.accept(r);assert.equal(commit.facts.length,0);assert.equal(commit.patches.length,1);assert.equal((await s.listCoverage(range))[0].review_status,'pending');s.close();
});

test('large manual pages and eighty events preserve an existing fact ahead of hundreds of coverage metadata rows',async()=>{
 const {mkdir,writeFile}=await import('node:fs/promises');const {join}=await import('node:path');const c=await config(),s=await createStore(c);await mkdir(join(c.wiki_root,'wiki/projects'),{recursive:true});await writeFile(join(c.wiki_root,'wiki/projects/a.md'),'Project page\n'+'a'.repeat(8698));await writeFile(join(c.wiki_root,'log.md'),'Manual log\n'+'line\n'.repeat(70000));await s.saveCollection(collection());const initial=bundle();await s.saveBundle(initial);const accepted=result(initial);accepted.pages=[];await s.commitReview(accepted);const events=Array.from({length:80},(_,i)=>event('eighty:'+i,'Synthetic active event '+i+' '.repeat(150)));const batch=collection(events,'live','big-pages');batch.coverage=Array.from({length:589},(_,i)=>({...batch.coverage[0],coverage_id:'many:'+i,conversation_id:i%3===0?null:'chat:'+i}));await s.saveCollection(batch);const reviewer=createReviewer(s,c),prepared=await reviewer.prepare({kind:'daily',lane:'live',cutoff,page_paths:['wiki/projects/a.md','log.md']});assert(prepared.length>0);assert(prepared.some(b=>b.existing_facts.length===1));assert(prepared.some(b=>b.baselines.some(page=>page.path==='log.md'&&page.context_excerpt)));for(const b of prepared){assert(Buffer.byteLength(canonical(b))<=c.limits.bundle_bytes);assert(b.unfinished.some(g=>g.reason.includes('omitted')));}s.close();
});
