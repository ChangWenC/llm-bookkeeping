import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile, readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { createStore, restoreStore, digest } from '../../src/store/index.ts';
import { config, event, collection, bundle, result, candidate, range, value } from './fixtures.ts';

test('collection saves fragments/events/checkpoints atomically and preserves large identities',async()=>{
 const c=await config();let enabled=true;const s=await createStore(c,{onTransactionStep(step){if(enabled&&step==='collection_events')throw new Error('disk failure');}});
 const batch=collection();const raw=Buffer.from('synthetic raw bytes');batch.fragments=[{schema_version:1,fragment_id:'fragment:1',locator:'memory',bytes_base64:raw.toString('base64'),sha256:digest(raw)}];batch.events[0].fragment_ref='fragment:1';
 await assert.rejects(s.saveCollection(batch),/disk failure/);assert.equal((await s.listEvents({range})).length,0);assert.deepEqual(await s.getCheckpoints('synthetic','live'),[]);
 enabled=false;await s.saveCollection(batch);await s.saveCollection(batch);assert.equal((await s.listEvents({range}))[0].source.account_id,'9007199254740993');assert.equal((await s.getCheckpoints('synthetic','live'))[0].cursor.offset,'9007199254740995');
 await assert.rejects(s.saveCollection({...batch,events:[event('changed')]}),/identity conflict/);s.close();
});

test('every semantic transaction fault rolls back facts, review, patches, chunk completion and outbox',async()=>{
 for(const step of ['review_facts','review_chunks','review_patches','review_outbox','review_result','before_commit']){
  const c=await config();let enabled=false;const s=await createStore(c,{onTransactionStep(at){if(enabled&&at===step)throw new Error('injected '+step);}});const b=bundle();await s.saveCollection(collection());await s.saveBundle(b);enabled=true;
  await assert.rejects(s.commitReview(result(b)),/injected/);assert.equal((await s.readEffectiveFacts({range})).length,0);assert.equal(await s.getReviewResult('result:1'),null);assert.deepEqual(await s.listOutbox(),[]);assert.deepEqual(await s.listPendingPatches(),[]);assert.equal((await s.listPendingChunks(range,'live')).length,1);
  enabled=false;const committed=await s.commitReview(result(b));assert.equal(committed.facts.length,1);assert.equal((await s.listPendingChunks(range,'live')).length,0);s.close();
 }
});

test('killed process during transaction leaves no accepted semantic state; restart accepts once',async()=>{
 const c=await config();const s=await createStore(c);const b=bundle();await s.saveCollection(collection());await s.saveBundle(b);s.close();
 const input=join(c.wiki_root,'crash-input.json');await writeFile(input,JSON.stringify({config:c,result:result(b),step:'review_outbox'}));
 const child=spawnSync(process.execPath,[new URL('./crash-process.ts',import.meta.url).pathname,input],{encoding:'utf8'});assert.equal(child.status,71,child.stderr);
 const recovered=await createStore(c);assert.deepEqual(await recovered.listOutbox(),[]);assert.equal((await recovered.status()).facts,0);const first=await recovered.commitReview(result(b));recovered.close();
 const restarted=await createStore(c);const again=await restarted.commitReview({...result(b),result_id:'new-model-label'});assert.equal(again.reused,true);assert.equal(again.batch_id,first.batch_id);assert.deepEqual(again.facts,first.facts);assert.deepEqual(again.patches,first.patches);assert.equal((await restarted.listPendingPatches()).length,1);assert.equal(await restarted.getFileIntent(first.patches[0].operation_id),null);restarted.close();
});

test('two independent writer threads serialize competing acceptance without losing or duplicating facts',async()=>{
 const c=await config();const s=await createStore(c);const b=bundle();await s.saveCollection(collection());await s.saveBundle(b);s.close();
 const run=(id:string)=>new Promise<any>((resolve,reject)=>{const worker=new Worker(new URL('./transaction-worker.ts',import.meta.url),{workerData:{config:c,result:result(b,id),delay:200}});worker.once('message',resolve);worker.once('error',reject);worker.once('exit',code=>{if(code)reject(new Error('worker exit '+code));});});
 const [a,z]=await Promise.all([run('worker:a'),run('worker:z')]);assert.equal(a.ok,true,JSON.stringify(a));assert.equal(z.ok,true,JSON.stringify(z));assert.equal(a.committed.batch_id,z.committed.batch_id);assert.notEqual(a.committed.reused,z.committed.reused);
 const reopened=await createStore(c);assert.equal((await reopened.readEffectiveFacts({range})).length,1);assert.equal((await reopened.listOutbox()).length,1);await assert.rejects(reopened.commitReview({...result(b),result_id:'changed',candidates:[{...candidate(b),content:'Changed claim'}]}),/identity conflict/);reopened.close();
});

test('reviewing half the capture remains partial; explicit zero facts closes only actual reviewed events',async()=>{
 const c=await config();const s=await createStore(c);const events=[event('a'),event('b')];await s.saveCollection(collection(events));const b=bundle(events);await s.saveBundle(b);
 const r=result(b,'partial',false);r.chunks[0]={...r.chunks[0],status:'partial',reviewed_event_ids:['a'],reason:'b not yet read'};await s.commitReview(r);const box=await s.listOutbox();assert.equal(box[0].artifact.coverage[0].capture_status,'complete');assert.equal(box[0].artifact.coverage[0].review_status,'partial');assert.equal((await s.listPendingChunks(range,'live')).length,1);
 const remaining=bundle([events[1]],'remaining');await s.saveBundle(remaining);await s.commitReview(result(remaining,'zero',false));assert.equal((await s.listCoverage(range))[0].review_status,'complete');assert.equal((await s.readEffectiveFacts({range})).length,0);s.close();
});

test('context cannot count as reviewed evidence and unknown candidates defer only their events',async()=>{
 const c=await config();const s=await createStore(c);const events=[event('a'),event('b')];await s.saveCollection(collection(events));const b=bundle(events);b.chunks[0].context_events=[event('context')];await s.saveBundle(b);
 const bad=result(b);bad.chunks[0].reviewed_event_ids.push('context');await assert.rejects(s.commitReview(bad),/outside chunk/);
 const r=result(b);r.candidates[0].attribution.subject_known=false;r.candidates.push({...candidate(b,'candidate:2'),analytics_projection:{schema_version:1,value:null,reason:'Not projected'},event_refs:[{schema_version:1,event_id:'b'}]});r.pages=[];await s.commitReview(r);assert.equal((await s.readEffectiveFacts({range})).length,1);assert.equal((await s.listWork('review_candidate'))[0].reason,'Unknown fact subject');assert.equal((await s.listCoverage(range))[0].review_status,'partial');assert.deepEqual((await s.getReviewableEvents({range,lane:'live'},'daily')).map(e=>e.event_id),['a']);s.close();
});

test('replace/retract fold immutable history with as-of, move periods, stale targets defer locally',async()=>{
 const c=await config();const s=await createStore(c);const b=bundle();await s.saveCollection(collection());await s.saveBundle(b);const one=await s.commitReview(result(b));
 const correction=bundle([event('correction')],'correction');correction.existing_facts=one.facts;await s.saveCollection(collection(correction.chunks[0].events,'live','collection:2'));await s.saveBundle(correction);
 const r=result(correction,'correction-result');r.created_at='2026-09-30T11:00:00Z';r.candidates[0]={...r.candidates[0],disposition:'replace',content:'You corrected the parser.',target_refs:[{schema_version:1,fact_id:one.facts[0].fact_id,revision:1}],occurred_at:value('2026-09-27T23:30:00Z'),journal_date:value('2026-09-27')};r.pages=[];const two=await s.commitReview(r);assert.equal(two.facts[0].fact_id,one.facts[0].fact_id);assert.equal(two.facts[0].revision,2);assert.equal((await s.readEffectiveFacts({range}))[0].content,'You corrected the parser.');assert.equal((await s.readEffectiveFacts({range,as_of:'2026-09-30T10:59:59Z'}))[0].revision,1);
 assert.ok((await s.listOutbox()).at(-1)!.artifact.affected_weeks.includes('2026-09-28'),'Amsterdam Monday differs from Sunday journal date');
 const retract=bundle([event('retract')],'retract');retract.existing_facts=two.facts;await s.saveBundle(retract);const rr=result(retract,'retract-result');rr.created_at='2026-09-30T12:00:00Z';rr.candidates[0]={...rr.candidates[0],disposition:'retract',target_refs:[{schema_version:1,fact_id:two.facts[0].fact_id,revision:2}]};rr.pages=[];await s.commitReview(rr);assert.equal((await s.readEffectiveFacts({range})).length,0);assert.equal((await s.readEffectiveFacts({range,as_of:'2026-09-30T11:30:00Z'}))[0].revision,2);s.close();
});

test('facts export readiness and each consumer acknowledgement are independent of journal files',async()=>{
 const c=await config();const s=await createStore(c);const b=bundle();await s.saveCollection(collection());await s.saveBundle(b);const committed=await s.commitReview(result(b));assert.deepEqual(await s.listReadyBatches('analytics'),[]);
 await assert.rejects(s.acknowledgeConsumer({schema_version:1,consumer:'analytics',batch_id:committed.batch_id,acknowledged_at:'2026-09-30T12:00:00Z'}),/unready/);
 await s.markPatchStatus(committed.patches[0].operation_id,'conflict','human changed page');await s.markExportReady(committed.batch_id,join(c.data_dir,'facts.json'));assert.equal((await s.listReadyBatches('analytics')).length,1);
 await s.acknowledgeConsumer({schema_version:1,consumer:'analytics',batch_id:committed.batch_id,acknowledged_at:'2026-09-30T12:00:00Z'});assert.deepEqual(await s.listReadyBatches('analytics'),[]);assert.equal((await s.listReadyBatches('monthly')).length,1);assert.equal((await s.listOutbox())[0].status,'ready');assert.equal((await s.readEffectiveFacts({range})).length,1);s.close();
});

test('consistent WAL backup restores facts, fragments, intents, patches and work without original source',async()=>{
 const c=await config();const s=await createStore(c);const b=bundle();await s.saveCollection(collection());await s.saveBundle(b);const committed=await s.commitReview(result(b));const patch=committed.patches[0];const bytes=Buffer.from('desired');const intent={schema_version:1 as const,operation_id:patch.operation_id,path:patch.path,baseline_digest:'absent',desired_digest:digest(bytes),desired_bytes_base64:bytes.toString('base64'),backup_bytes_base64:null,state:'prepared' as const,fact_refs:patch.fact_refs,created_at:'2026-09-30T10:00:00Z',reason:null};await s.saveFileIntent(intent);await s.saveFileIntent(intent);await assert.rejects(s.saveFileIntent({...intent,desired_bytes_base64:Buffer.from('changed').toString('base64'),desired_digest:digest('changed')}),/identity conflict/);
 const backup=await s.backup(join(c.wiki_root,'backups'));assert.equal(backup.sha256,digest(await readFile(backup.path)));assert.equal((await stat(backup.path)).mode&0o777,0o600);
 const restoredDir=join(c.wiki_root,'restored');await restoreStore(backup.path,restoredDir);await assert.rejects(restoreStore(backup.path,restoredDir),/new destination/);const restored=await createStore({...c,data_dir:restoredDir});assert.deepEqual(await restored.readEffectiveFacts({range}),committed.facts);assert.deepEqual(await restored.getFileIntent(patch.operation_id),intent);assert.equal((await restored.listPendingPatches()).length,1);assert.equal((await restored.listOutbox()).length,1);restored.close();s.close();
});

test('legacy migration is atomic/idempotent, retains IDs and records unresolved mappings without verified claims',async()=>{
 const c=await config();const s=await createStore(c);const b=bundle();await s.saveBundle(b);const initial=await s.commitReview(result(b));const legacy={...initial.facts[0],fact_id:'old:9007199254740999',kind:'fact' as const,legacy_locator:'sealed:daily:2026-09-30:section:0'};const batch={schema_version:1 as const,migration_key:'migration:1',facts:[legacy],mappings:[{schema_version:1 as const,source_id:'old-source',target_id:null,confidence:'unresolved' as const,reason:'logical identity not proven'}],work:[]};const a=await s.importLegacy(batch);const z=await s.importLegacy(batch);assert.equal(a.imported_facts,1);assert.equal(z.reused,true);assert.equal((await s.readEffectiveFacts({range})).find(f=>f.fact_id===legacy.fact_id)!.kind,'legacy_record');assert.equal((await s.listWork('legacy_mapping')).length,1);await assert.rejects(s.importLegacy({...batch,facts:[]}),/identity conflict/);s.close();
});

test('unknown metadata can enrich monotonically; conflicting original content is retained as local pending data',async()=>{
 const c=await config();const s=await createStore(c);const unknown=event();unknown.utc_time={schema_version:1,value:null,reason:'timestamp absent'};unknown.journal_date={schema_version:1,value:null,reason:'timezone unresolved'};unknown.classification='unknown';unknown.role='unknown';await s.saveCollection(collection([unknown]));assert.equal((await s.listWork('event_identity_time','pending')).length,1);
 await s.saveCollection(collection([event()],'live','enrich'));assert.equal((await s.listEvents({range}))[0].utc_time.value,event().utc_time.value);assert.equal((await s.listWork('event_identity_time','pending')).length,0);
 const changed=event();changed.body='Conflicting body';await s.saveCollection(collection([changed],'live','content-conflict'));assert.equal((await s.listEvents({range}))[0].body,event().body);assert.equal((await s.listWork('event_conflict','pending'))[0].payload.incoming.body,'Conflicting body');assert.equal((await s.getCheckpoints('synthetic','live')).length,1);s.close();
});

test('microsecond range boundaries remain precise and projection cannot cite unrelated evidence',async()=>{
 const c=await config();const s=await createStore(c);const events=[event('nano-a','A','2026-09-30T09:00:00.000001Z'),event('nano-b','B','2026-09-30T09:00:00.000002Z')];await s.saveCollection(collection(events));assert.deepEqual((await s.listEvents({range:{schema_version:1,from:'2026-09-30T09:00:00.000001Z',to:'2026-09-30T09:00:00.000002Z'}})).map(e=>e.event_id),['nano-a']);const b=bundle([events[0]]);await s.saveBundle(b);const bad=result(b);bad.candidates[0].analytics_projection.value!.event_refs=[{schema_version:1,event_id:'nano-b'}];await assert.rejects(s.commitReview(bad),/projection evidence outside/);assert.equal((await s.status()).facts,0);s.close();
});
