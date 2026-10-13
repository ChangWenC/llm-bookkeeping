import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createStore } from '../../src/store/index.ts';
import { createReviewer } from '../../src/review/index.ts';
import { createPublisher, createSafeWikiWriter, digestBytes, acquireWikiLock } from '../../src/publish/index.ts';
import { createMonthlyConsumer } from '../../src/consumers/monthly/index.ts';
import { createArchiveService } from '../../src/consumers/archive/index.ts';
import { monthlyPath } from '../../src/consumers/archive/records.ts';
import type { FactArtifact, FileIntent, PublishResult, Store } from '../../src/contracts/types.ts';
import { config as fixtureConfig, bundle, result, event } from '../store/fixtures.ts';

const now = () => new Date('2026-10-07T12:00:00.000Z');
async function fixture(t: test.TestContext) {
  const config = await fixtureConfig(), store = await createStore(config, { now });
  t.after(async () => { await store.close(); await rm(dirname(config.wiki_root), { recursive: true, force: true }); });
  return { config, store };
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}
async function readyHistory(f: Awaited<ReturnType<typeof fixture>>, count: number) {
  const entries: { id: string; path: string }[] = [];
  for (let i = 0; i < count; i++) {
    const id = `batch:history:${String(i).padStart(4,'0')}`, path = join(f.config.data_dir,'facts','batches',digestBytes(Buffer.from(id)),'artifact.json');
    const artifact: FactArtifact = { schema_version: 1, batch_id: id, created_at: now().toISOString(), facts: [], coverage: [], affected_dates: [], affected_weeks: [], affected_months: [] };
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, canonical(artifact)+'\n');
    f.store.db.prepare('INSERT INTO outbox(id,json,status,export_path) VALUES(?,?,?,?)').run(id, JSON.stringify(artifact), 'ready', path);
    entries.push({ id, path });
  }
  return entries;
}
function proxy(store: Store, overrides: Partial<Store>): Store {
  return new Proxy(store, { get(target,key) { const override = Reflect.get(overrides,key); if (override !== undefined) return override; const member = Reflect.get(target,key); return typeof member === 'function' ? member.bind(target) : member; } });
}
async function review(f: Awaited<ReturnType<typeof fixture>>, id: string, pages = true) {
  const prepared = bundle([event(`event:${id}`)],`bundle:${id}`);
  await f.store.saveBundle(prepared);
  const reviewed = result(prepared,`result:${id}`); if (!pages) reviewed.pages = [];
  return reviewed;
}
async function acceptMonthly(f: Awaited<ReturnType<typeof fixture>>, identity: string, monthly: NonNullable<FactArtifact['monthly_review']>, ready = true): Promise<FactArtifact> {
  await f.store.enqueueWork({schema_version:1,work_id:`prepare-monthly:fixture:${identity}`,kind:'prepare_monthly',lane:'history',state:'pending',payload:{month:monthly.month},reason:'Synthetic accepted monthly fixture',migration_key:null,updated_at:now().toISOString()});
  const prepared = (await createReviewer(f.store,f.config).prepare({kind:'monthly',lane:'history',period:monthly.month,cutoff:now().toISOString()}))[0];
  assert.ok(prepared);
  const reviewed = result(prepared,`result:monthly-fixture:${identity}`,false); reviewed.monthly_review = monthly;
  const accepted = await f.store.commitReview(reviewed);
  if (ready) await createPublisher(f.store,f.config,{now}).exportFacts();
  return (await f.store.getPublicationOutbox(accepted.batch_id))!.artifact;
}
function semanticCounts(f: Awaited<ReturnType<typeof fixture>>) {
  return ['facts','results','outbox','reviewed_sources','reviewed_spans','reviewed_units'].map(table => f.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
}

test('SQLite current committed batch and file publish before 140 historical ready audits and older pending exports', async t => {
  const f = await fixture(t); await readyHistory(f,140);
  const old = await review(f,'old-pending',false); await f.store.commitReview(old);
  const latest = await review(f,'latest');
  const order: string[] = []; let deadline = 1000;
  const port = proxy(f.store, {
    listOutbox: async () => { throw new Error('Unbounded outbox forbidden'); },
    listFileIntents: async () => { throw new Error('Unbounded intents forbidden'); },
  });
  const receipt = await createPublisher(port,f.config,{ now, remaining_ms:()=>deadline, fault(stage,id) {
    if (stage === 'after_export_rename') order.push(`export:${id}`);
    if (stage === 'after_file_registered') { order.push(`file:${id}`); deadline = 0; }
  } }).publish(latest);
  assert.equal(receipt.fact_commit,'committed'); assert.equal(receipt.export_status,'ready');
  assert.equal(order.length,2); assert.ok(order[0].startsWith('export:'+receipt.batch_id)); assert.ok(order[1].startsWith('file:'));
  assert.equal(receipt.files[0].status,'applied'); assert.equal(receipt.consumers.find(item=>item.target==='index')!.status,'pending');
  assert.equal((await f.store.listOutbox('pending')).length,1,'Earlier pending batch remains durable after current atomic write hits deadline');
  assert.equal(f.store.db.prepare('SELECT status FROM patches WHERE id=?').get(receipt.files[0].operation_id)!.status,'applied');
});

test('SQLite ready export and applied intent audits are capped at64, rotate durably and discover a missing tail export', async t => {
  const f = await fixture(t), history = await readyHistory(f,140);
  for (let i = 0; i < 140; i++) {
    const intent: FileIntent = { schema_version: 1, operation_id: `operation:history:${i}`, path: `wiki/history/${i}.md`, baseline_digest: 'absent', desired_digest: digestBytes(Buffer.from('original')), desired_bytes_base64: Buffer.from('original').toString('base64'), backup_bytes_base64: null, state: 'applied', fact_refs: [], created_at: now().toISOString(), reason: null };
    await f.store.saveFileIntent(intent);
  }
  await rm(history[130].path);
  let exports = 0, applied = 0;
  const port = proxy(f.store, {
    listOutbox: async () => { throw new Error('Unbounded outbox forbidden'); },
    listFileIntents: async () => { throw new Error('Unbounded intents forbidden'); },
    listPublicationOutbox: async request => { const page = await f.store.listPublicationOutbox(request); if(request.status==='ready') exports += page.items.length; return page; },
    listPublicationFileIntents: async request => { const page = await f.store.listPublicationFileIntents(request); if(request.states.includes('applied')) applied += page.items.length; return page; },
  });
  for (let run = 0; run < 3; run++) {
    exports = applied = 0; await createPublisher(port,f.config,{now}).resume();
    assert.ok(exports<=64); assert.ok(applied<=64);
    if(run<2) assert.ok(await f.store.getPublicationRecoveryCursor('ready_exports'));
  }
  assert.ok((await f.store.listWork('export','pending')).some(item=>item.work_id===`export:${history[130].id}`));
  await createPublisher(port,f.config,{now}).resume();
  assert.ok((await readFile(history[130].path)).length); assert.equal((await f.store.listWork('export','pending')).length,0);
  assert.ok((await f.store.listFileIntents()).every(intent=>intent.state==='applied'));
});

test('SQLite historical audit saves opaque progress after each item even when the deadline expires within a page', async t => {
  const f = await fixture(t); await readyHistory(f,5); let remaining = 1000;
  const port = proxy(f.store,{ setPublicationRecoveryCursor: async (kind,cursor) => { await f.store.setPublicationRecoveryCursor(kind,cursor); if(kind==='ready_exports'&&cursor)remaining=0; } });
  await createPublisher(port,f.config,{now,remaining_ms:()=>remaining}).resume();
  const first = await f.store.getPublicationRecoveryCursor('ready_exports'); assert.ok(first);
  remaining=1000; await createPublisher(port,f.config,{now,remaining_ms:()=>remaining}).resume();
  assert.notEqual(await f.store.getPublicationRecoveryCursor('ready_exports'),first);
});

for (const stage of ['export','recovery','monthly','result'] as const) test(`SQLite postcommit ${stage} exception preserves exact receipt and retry allocates no facts/results/marks`,async t=>{
  const f=await fixture(t),reviewed=await review(f,stage); let fail=true;
  const overrides:Partial<Store>={};
  if(stage==='export')overrides.getPublicationOutbox=async id=>{if(fail)throw new Error('Export query failure');return f.store.getPublicationOutbox(id);};
  if(stage==='recovery')overrides.listPendingPatches=async()=>{if(fail)throw new Error('Recovery query failure');return f.store.listPendingPatches();};
  if(stage==='monthly'||stage==='result')overrides.listReadyBatches=async(target,...rest)=>{if(fail&&target===(stage==='monthly'?'monthly-publish':'analytics'))throw new Error('Consumer query failure');return f.store.listReadyBatches(target,...rest);};
  const publisher=createPublisher(proxy(f.store,overrides),f.config,{now}); let receipt:PublishResult|undefined;
  await assert.rejects(publisher.publish(reviewed),error=>{receipt=(error as Error&{receipt:PublishResult}).receipt;return true;});
  assert.ok(receipt);assert.equal(receipt.fact_commit,'committed');assert.equal(receipt.result_id,reviewed.result_id);assert.ok(receipt.batch_id);assert.equal(receipt.continuation!.stage,stage);
  if(stage!=='export')assert.equal(receipt.export_status,'ready');
  if(stage==='recovery'||stage==='monthly'||stage==='result')assert.equal(receipt.files[0].status,'applied');
  const before=semanticCounts(f);fail=false;const retried=await publisher.publish(reviewed);
  assert.equal(retried.result_id,receipt.result_id);assert.equal(retried.batch_id,receipt.batch_id);assert.equal(retried.fact_commit,'already_committed');assert.deepEqual(semanticCounts(f),before);
});

test('SQLite applied file remains noop at deadline and later manual edits survive index recovery',async t=>{
  const f=await fixture(t),reviewed=await review(f,'deadline-noop'),commit=await f.store.commitReview(reviewed);
  const publisher=createPublisher(f.store,f.config,{now});await publisher.applyPatches(commit.patches);
  const patch=commit.patches[0];await writeFile(join(f.config.wiki_root,patch.path),'Later manual edit\n');
  const expired=createPublisher(f.store,f.config,{now,remaining_ms:()=>0});assert.equal((await expired.applyPatches(commit.patches))[0].status,'noop');
  const writer=createSafeWikiWriter(f.store,f.config,{now,remaining_ms:()=>0});assert.equal((await writer.write({operation_id:patch.operation_id,path:patch.path,baseline_digest:'absent',desired_bytes:Buffer.from('old bytes')})).status,'noop');
  const lock=await acquireWikiLock(f.config.wiki_root);assert.ok(lock);try{assert.equal((await publisher.applyPatches(commit.patches))[0].status,'noop');}finally{await lock.release();}
  assert.equal((await f.store.getFileIntent(patch.operation_id))!.state,'applied');assert.equal(await readFile(join(f.config.wiki_root,patch.path),'utf8'),'Later manual edit\n');
});

test('SQLite September and October semantic monthly publication is independent of archive eligibility and closes only frozen work',async t=>{
  const f=await fixture(t),monthly=createMonthlyConsumer(f.store,f.config,{now});
  for(const month of ['2026-09','2026-10']){
    const frozen=`prepare-monthly:frozen:${month}`,late=`prepare-monthly:late:${month}`;
    for(const work_id of [frozen,late])await f.store.enqueueWork({schema_version:1,work_id,kind:'prepare_monthly',lane:'history',state:'pending',payload:{month},reason:null,migration_key:null,updated_at:now().toISOString()});
    const artifact=await acceptMonthly(f,month,{schema_version:1,month,summary:'Synthetic semantic monthly summary.',fact_refs:[],coverage_status:'partial',supplement_text:'',completed_work_ids:[frozen]});
    assert.equal((await monthly.publishMonthlyReview(artifact)).status,'complete');
    assert.ok((await readFile(join(f.config.wiki_root,monthlyPath(month)),'utf8')).includes(artifact.monthly_review!.summary));
    assert.ok((await f.store.listWork('prepare_monthly','pending')).some(item=>item.work_id===late));
    assert.ok(!(await f.store.listWork('prepare_monthly','pending')).some(item=>item.work_id===frozen));
    assert.equal((await createArchiveService(f.store,f.config,{now}).run({month,mode:'apply'})).status,'pending');
  }
});

test('SQLite shared storage failure after file registration retains applied receipt and stops all subsequent file writes',async t=>{
  const f=await fixture(t),prepared=bundle([event('event:capacity')],'bundle:capacity');
  const peer='wiki/projects/peer.md';prepared.baselines.push({schema_version:1,path:peer,digest:'absent',content:null});await f.store.saveBundle(prepared);
  const reviewed=result(prepared,'result:capacity');reviewed.pages.push({...reviewed.pages[0],suggestion_id:'page:peer',path:peer});
  let registrations=0;let receipt:PublishResult|undefined;
  await assert.rejects(createPublisher(f.store,f.config,{now,fault(stage){if(stage==='after_file_registered'){registrations++;throw Object.assign(new Error('Synthetic capacity failure'),{code:'ENOSPC'});}}}).publish(reviewed),error=>{receipt=(error as Error&{receipt:PublishResult}).receipt;return true;});
  assert.equal(registrations,1);assert.ok(receipt);assert.equal(receipt.execution_status,'storage_unavailable');assert.equal(receipt.fact_commit,'committed');assert.equal(receipt.export_status,'ready');assert.equal(receipt.continuation!.stage,'recovery');assert.equal(receipt.files[0].status,'applied');assert.equal(receipt.files[0].failure_scope,'storage');
  const intents=await f.store.listFileIntents();assert.equal(intents.length,1);assert.equal(intents[0].state,'applied');await assert.rejects(readFile(join(f.config.wiki_root,peer)),{code:'ENOENT'});
  const before=semanticCounts(f);const retry=await createPublisher(f.store,f.config,{now}).publish(reviewed);assert.equal(retry.fact_commit,'already_committed');assert.deepEqual(semanticCounts(f),before);assert.ok((await readFile(join(f.config.wiki_root,peer))).length);
});

test('SQLite post-export queue failure preserves ready export independently of failed continuation',async t=>{
  const f=await fixture(t),reviewed=await review(f,'queue-capacity');let failed=true;let receipt:PublishResult|undefined;
  const port=proxy(f.store,{enqueueWork:async work=>{if(failed&&work.kind==='consumer')throw Object.assign(new Error('Synthetic queue capacity failure'),{code:'ENOSPC'});await f.store.enqueueWork(work);}});
  await assert.rejects(createPublisher(port,f.config,{now}).publish(reviewed),error=>{receipt=(error as Error&{receipt:PublishResult}).receipt;return true;});
  assert.ok(receipt);assert.equal(receipt.export_status,'ready');assert.equal(receipt.continuation!.stage,'export');assert.equal((await f.store.getPublicationOutbox(receipt.batch_id!))!.status,'ready');assert.equal(receipt.files.length,0);
  const before=semanticCounts(f);failed=false;await createPublisher(port,f.config,{now}).publish(reviewed);assert.deepEqual(semanticCounts(f),before);
});

test('SQLite existing monthly summary remains re-reviewable after correction without resurrecting its old fact',async t=>{
  const f=await fixture(t),reviewed=await review(f,'summary-correction',false),commit=await f.store.commitReview(reviewed);const original=commit.facts[0];
  const month='2026-09',monthly=createMonthlyConsumer(f.store,f.config,{now});
  const artifact=await acceptMonthly(f,'summary-first',{schema_version:1,month,summary:'Original synthetic summary.',fact_refs:[{schema_version:1,fact_id:original.fact_id,revision:original.revision}],coverage_status:'partial',supplement_text:''});
  assert.equal((await monthly.publishMonthlyReview(artifact)).status,'complete');
  const corrected={...original,revision:2,content:'Corrected synthetic activity.',action:'replace' as const,target_refs:[{schema_version:1 as const,fact_id:original.fact_id,revision:original.revision}],recorded_at:now().toISOString()};
  await f.store.importLegacy({schema_version:1,migration_key:'synthetic-summary-correction',facts:[corrected],mappings:[],work:[]});
  assert.equal((await monthly.refreshMonthlySupplements(month)).status,'complete');
  const text=await readFile(join(f.config.wiki_root,monthlyPath(month)),'utf8');assert.ok(text.includes('原结论已失效'));assert.ok(text.includes(corrected.content));assert.ok(!text.includes(original.content));
  const debt=(await f.store.listWork('prepare_monthly','pending')).filter(work=>work.payload.month===month);assert.ok(debt.length);
  const prepared=await createReviewer(f.store,f.config).prepare({kind:'monthly',lane:'history',period:month,cutoff:now().toISOString()});assert.equal(prepared.length,1);assert.ok(prepared[0].monthly_context!.prepared_work_ids!.some(id=>debt.some(work=>work.work_id===id)));assert.ok(prepared[0].monthly_context!.facts.some(fact=>fact.revision===2));
});

test('SQLite bounded monthly publication advances beyond140 inapplicable daily batches without acknowledging semantic work early',async t=>{
  const f=await fixture(t);await readyHistory(f,140);const month='2026-09',frozen='prepare-monthly:tail-review';
  await f.store.enqueueWork({schema_version:1,work_id:frozen,kind:'prepare_monthly',lane:'history',state:'pending',payload:{month},reason:null,migration_key:null,updated_at:now().toISOString()});
  const artifact=await acceptMonthly(f,'typed-monthly-tail',{schema_version:1,month,summary:'Synthetic semantic review beyond the bounded daily prefix.',fact_refs:[],coverage_status:'partial',supplement_text:'',completed_work_ids:[frozen]},false);
  const publisher=createPublisher(f.store,f.config,{now});
  for(let i=0;i<2;i++){
    await publisher.resume();await assert.rejects(readFile(join(f.config.wiki_root,monthlyPath(month))),{code:'ENOENT'});
    assert.ok((await f.store.listWork('prepare_monthly','pending')).some(work=>work.work_id===frozen));
    assert.ok((await f.store.listReadyBatches('monthly-publish')).some(batch=>batch.batch_id===artifact.batch_id));
  }
  await publisher.resume();assert.ok((await readFile(join(f.config.wiki_root,monthlyPath(month)),'utf8')).includes(artifact.monthly_review!.summary));
  assert.ok(!(await f.store.listWork('prepare_monthly','pending')).some(work=>work.work_id===frozen));
  assert.ok(!(await f.store.listReadyBatches('monthly-publish')).some(batch=>batch.batch_id===artifact.batch_id));
});

test('SQLite later monthly exception retains preceding complete consumer and file receipts',async t=>{
  const f=await fixture(t),reviewed=await review(f,'monthly-partial-receipt',false);
  const priorIds:string[]=[];
  for(const month of ['2026-09','2026-10']) priorIds.push((await acceptMonthly(f,`prior-monthly:${month}`,{schema_version:1,month,summary:`Synthetic prior publication ${month}.`,fact_refs:[],coverage_status:'partial',supplement_text:''},false)).batch_id);
  let receipt:PublishResult|undefined;
  const port=proxy(f.store,{listWork:async(kind,state)=>{
    if(kind==='monthly_display'&&priorIds.every(id=>f.store.db.prepare("SELECT 1 FROM acks WHERE consumer='monthly-publish' AND batch_id=?").get(id)))throw new Error('Synthetic later monthly inventory failure');
    return f.store.listWork(kind,state);
  }});
  await assert.rejects(createPublisher(port,f.config,{now}).publish(reviewed),error=>{receipt=(error as Error&{receipt:PublishResult}).receipt;return true;});
  assert.ok(receipt);assert.equal(receipt.continuation!.stage,'monthly');assert.equal(receipt.fact_commit,'committed');assert.equal(receipt.export_status,'ready');
  assert.equal(receipt.consumers.filter(item=>item.target.startsWith('monthly-publish:')&&item.status==='complete').length,2);
  assert.ok(receipt.files.filter(file=>file.operation_id.startsWith('monthly-review:')&&file.status==='applied').length===2);
});
