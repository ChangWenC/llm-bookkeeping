import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, rm, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runCli, parseArgs } from '../../src/cli.ts';
import { createStore } from '../../src/store/index.ts';
import { createReviewer } from '../../src/review/index.ts';
import { createPublisher } from '../../src/publish/index.ts';
import { PERSONAL_DAILY_ROUND_LIMITS, PERSONAL_COLLECTION_BUDGETS } from '../../src/config.ts';
import { config as fixtureConfig, event, collection, result, bundle, value } from '../store/fixtures.ts';
import type { ReviewBundle, RuntimeServices } from '../../src/contracts/types.ts';

const start = '2026-10-06T12:00:00Z';
async function fixture(t: test.TestContext, sources = ['codex','claude']) {
  const config = await fixtureConfig(), root = dirname(config.wiki_root);
  config.providers = sources.map(provider => ({ schema_version: 1, provider, enabled: true, roots: [], account_id: 'self-synthetic', options: {} }));
  config.journal_timezone_timeline = [{ schema_version: 1, effective_from: '1970-01-01T00:00:00Z', timezone: 'Europe/Amsterdam', basis: 'synthetic' }];
  config.daily_round_limits = { ...PERSONAL_DAILY_ROUND_LIMITS };
  config.collection_budgets = structuredClone(PERSONAL_COLLECTION_BUDGETS);
  config.limits = { chunk_events: 1, chunk_body_bytes: 32768, bundle_bytes: 32768, bundles_per_round: 4 };
  const output = join(root, 'round'); await mkdir(output, { mode: 0o700 });
  const manifest = join(output, 'manifest.json'), path = join(root, 'config.json'); await writeFile(path, JSON.stringify(config));
  let clock = Date.parse(start), collectAdvance = 0, prepareFailure = '', noProgress = false, noopCount = 0, capacityFault = false, journalBaselineBytes = 0, badJournal = '';
  const journalRequests: string[][] = [];
  const captureBudgets: number[] = [], starts: { source: string; lane: string; id: string }[] = [];
  const runtime = async (_: unknown, command?: string, options?: unknown, now?: () => Date): Promise<RuntimeServices> => {
    const store = await createStore(config, { now }); let deadline = Infinity;
    const budget = { now, remaining_ms: () => deadline - clock };
    const reviewer = createReviewer(store, config), prepare = reviewer.prepareWithOutcomes!.bind(reviewer);
    const journalPrepare=reviewer.prepareJournalWork!.bind(reviewer);
    reviewer.prepareJournalWork=async request=>{journalRequests.push(request.work_ids??[]);if(request.work_ids?.includes(badJournal))throw new Error('Synthetic single inaccessible journal target');const material=await journalPrepare(request);if(journalBaselineBytes)material.baselines=material.work.map(work=>({schema_version:1,path:String(work.payload.path),digest:'synthetic-full-baseline',content:'j'.repeat(journalBaselineBytes)}));return material;};
    reviewer.prepareWithOutcomes = async request => {
      if (request.source === prepareFailure) throw new Error('Synthetic source review failure');
      if (noProgress) return { schema_version: 1, bundles: [], providers: [] };
      const prepared = await prepare(request);
      starts.push(...prepared.bundles.filter(b => b.chunks.some(c => c.events.length)).map(b => ({ source: b.source!, lane: b.lane, id: b.bundle_id })));
      return prepared;
    };
    const publisher = createPublisher(store, config, { ...budget, fault(stage) { if (capacityFault && stage === 'before_target') throw Object.assign(new Error('ENOSPC: synthetic shared disk capacity'), { code: 'ENOSPC' }); } });
    const publish = publisher.publish.bind(publisher);
    publisher.publish = async review => { const receipt = await publish(review); receipt.files.push(...Array.from({length:noopCount},(_,index)=>({schema_version:1 as const,operation_id:`noop:${index}`,path:'wiki/projects/项目_synthetic_publication_history.md',status:'noop' as const,reason:null})));return receipt; };
    return { store, reviewer, publisher, consumers: [],
      setDeadline: at => { deadline = Date.parse(at); }, close: () => store.close(),
      adapters: sources.map(provider => ({ provider, account_id: 'self-synthetic', async *collect(request) {
        captureBudgets.push(request.budget.max_duration_ms); clock += Math.min(collectAdvance, request.budget.max_duration_ms);
        const captured = collection([], request.lane, `capture:${provider}:${request.lane}`);
        captured.checkpoints = [];
        captured.coverage = [{ ...captured.coverage[0], provider, account_id: 'self-synthetic', coverage_id: `coverage:${provider}:${request.lane}`, cutoff: start, query_range: request.range, read_ranges: [], capture_status: 'partial', gaps: [{ schema_version: 1, range: null, reason: 'Synthetic unread prefix', locator: null, resumable: true }] }];
        yield captured;
      } })),
    };
  };
  const cli = async (extra: string[] = [], expected = 0) => {
    let out = '', err = '';
    const code = await runCli(['daily-round','--manifest',manifest,'--output',output,...extra,'--config',path], { loadConfig: async () => config, createRuntime: runtime, now: () => new Date(clock).toISOString(), stdout: s => { out += s; }, stderr: s => { err += s; } });
    assert.equal(code, expected, err); return JSON.parse(out);
  };
  const seed = async (live: number, history: number, incomplete = 0) => {
    const store = await createStore(config, { now: () => new Date(clock) });
    for (const source of sources) {
      const events = [...Array(live + history + incomplete)].map((_, index) => {
        const when = index < live ? '2026-10-05T09:00:00Z' : '2026-09-30T09:00:00Z';
        const row = event(`${source}:${index}`, 'Synthetic material. '.repeat(1000), when);
        row.source = { ...row.source, provider: source, account_id: 'self-synthetic', conversation_id: `conversation:${source}:${index}` };
        if(source==='wechat')row.context={identity_verified:true,is_group:false,sender_id:'wxid_synthetic',sender_wxid:'wxid_synthetic'};
        if (index >= live + history) row.context = { incomplete_turn: true };
        return row;
      });
      const captured = collection(events, 'live', `seed:${source}`); captured.coverage = []; captured.checkpoints = [];
      await store.saveCollection(captured);
    }
    store.close();
  };
  const accept = async (receipt: any, partial = false) => {
    const bundle: ReviewBundle = JSON.parse(await readFile(receipt.active.file, 'utf8'));
    const review = result(bundle, `review:${receipt.active.bundle_id}`, false); review.created_at = new Date(clock).toISOString(); review.source = bundle.source;
    if (partial) for (const chunk of review.chunks) { chunk.status = 'deferred'; chunk.reason = 'Synthetic partial'; chunk.reviewed_event_ids = []; }
    const input = join(output, 'input.json'); await writeFile(input, JSON.stringify(review));
    return cli(['--input', input]);
  };
  const seedJournal=async(count:number)=>{const store=await createStore(config,{now:()=>new Date(clock)});const ids:string[]=[];try{for(let index=0;index<count;index++){const material=bundle([event(`journal:source:${index}`)],`journal:seed:${index}`),review=result(material,`journal:result:${index}`);review.pages=[];review.candidates[0].analytics_projection={schema_version:1,value:null,reason:'Synthetic personal journal debt'};await store.saveCollection({...collection(material.chunks[0].events,'history',`journal:collection:${index}`),coverage:[],checkpoints:[]});await store.saveBundle(material);await store.commitReview(review);}ids.push(...(await store.listWork('journal_publication')).filter(w=>w.state!=='complete').map(w=>w.work_id));}finally{store.close();}return ids;};
  t.after(() => rm(root, { recursive: true, force: true }));
  return { config, manifest, output, cli, seed, seedJournal, journalRequests, journalSize:(bytes:number,bad='')=>{journalBaselineBytes=bytes;badJournal=bad;}, accept, starts, captureBudgets, setClock: (value: number) => { clock = value; }, setCaptureAdvance: (value: number) => { collectAdvance = value; }, failPrepare: (source: string) => { prepareFailure = source; }, stopProgress: () => { noProgress = true; }, inflateReceipts: (value:number)=>{noopCount=value;}, failCapacity:()=>{capacityFault=true;} };
}

test('actual CLI/SQLite round starts96 nonempty bundles with16live/8history waves and fair sources; resume never double counts', async t => {
  const f = await fixture(t); await f.seed(40, 40); f.inflateReceipts(2000);
  let receipt = await f.cli(); assert.equal(receipt.state, 'review');
  const first = await f.cli(); assert.equal(first.active.bundle_id, receipt.active.bundle_id); assert.equal(first.started_bundles, 1);
  const selected: any[] = [];
  while (receipt.state === 'review') { selected.push(receipt.active); receipt = await f.accept(receipt); }
  assert.equal(receipt.started_bundles, 96); assert.equal(selected.length, 96); assert.equal(receipt.stop_reason, 'bundle_limit');
  for (let offset = 0; offset < 96; offset += 24) {
    const wave = selected.slice(offset, offset + 24); assert.equal(wave.filter(r => r.lane === 'live').length, 16); assert.equal(wave.filter(r => r.lane === 'history').length, 8);
    for (const lane of ['live','history']) { const rows = wave.filter(r => r.lane === lane); assert.equal(rows.filter(r => r.source === 'codex').length, rows.filter(r => r.source === 'claude').length); }
  }
  assert.equal((await f.cli()).started_bundles, 96);
  const persisted = JSON.parse(await readFile(f.manifest,'utf8')).daily_round;
  assert.ok((await stat(f.manifest)).size < 500000, '96 ×2000 noops must not fill the manifest');
  const receipts = persisted.receipts.filter((r:any)=>r.stage==='publish'); assert.equal(receipts.length,96);
  let fullBytes=0;for(const receipt of receipts){const file=await readFile(receipt.file,'utf8');fullBytes+=Buffer.byteLength(file);assert.equal(JSON.parse(file).result.files.length,2000);}
  assert.ok(fullBytes>16*1024*1024,'Complete original receipts live outside the bounded manifest');
  const store = await createStore(f.config);
  try { assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM results').get()!.n, 96); assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM facts').get()!.n, 0); }
  finally { store.close(); }
});

test('empty sources and incomplete turns occupy no quota; failure keeps existing partial source material and siblings eligible', async t => {
  const f = await fixture(t); await f.seed(1, 1, 20); f.failPrepare('codex');
  let receipt = await f.cli(); assert.equal(receipt.active.source, 'claude'); assert.equal(receipt.started_bundles, 1);
  receipt = await f.accept(receipt); assert.equal(receipt.state, 'review'); assert.equal(receipt.active.lane, 'history');
  receipt = await f.accept(receipt); assert.equal(receipt.state, 'complete'); assert.equal(receipt.started_bundles, 2);
  assert.ok(receipt.stages.some((s:any) => s.result?.execution_status === 'partial'));
  const empty = await fixture(t); empty.stopProgress(); const stopped = await empty.cli(); assert.equal(stopped.state, 'prepare_more'); assert.equal(stopped.started_bundles, 0); assert.equal(stopped.terminal, false); assert.ok(empty.captureBudgets.length > 0);
});

test('same active bundle supports format repair without quota; explicit failure deferral skips exact units and continues peers', async t => {
  const f = await fixture(t); await f.seed(2, 0);
  let receipt = await f.cli(); const first = receipt.active.bundle_id;
  const invalid = join(f.output, 'invalid.json'); await writeFile(invalid, '{}');
  const repaired = await f.cli(['--input',invalid]); assert.equal(repaired.state,'repair_input'); assert.equal(repaired.active.bundle_id,first); assert.equal(repaired.started_bundles,1);
  receipt = await f.cli(['--defer-active','Synthetic semantic read failure','--defer-stage','review']);
  assert.equal(receipt.state,'review'); assert.equal(receipt.active.source,'claude'); assert.equal(receipt.started_bundles,2);
  const manifest = JSON.parse(await readFile(f.manifest,'utf8')).daily_round;
  assert.ok(manifest.skip_units.length > 0); assert.ok(manifest.receipts.some((r:any) => r.stage==='review' && r.result.reason==='Synthetic semantic read failure'));
  receipt = await f.accept(receipt,true); assert.equal(receipt.state,'review'); assert.notEqual(receipt.active.bundle_id,first);
});

test('105minute stop forbids new semantic bundles and120minute deadline keeps active input durable', async t => {
  const f = await fixture(t); await f.seed(3,0);
  const active = await f.cli(); f.setClock(Date.parse(start)+105*60000);
  const settled = await f.accept(active); assert.equal(settled.state,'complete'); assert.equal(settled.started_bundles,1); assert.equal(f.starts.length,1);
  const late = await fixture(t); await late.seed(2,0); const pending=await late.cli(); late.setClock(Date.parse(start)+120*60000);
  const expired=await late.cli(); assert.equal(expired.state,'deadline'); assert.equal(expired.active.bundle_id,pending.active.bundle_id); assert.equal(late.starts.length,1);
});

test('capture allowance includes original run start, caps each remaining call and persists conservative crash reservations', async t => {
  const f = await fixture(t, ['codex','claude','wechat']); f.setCaptureAdvance(300000);
  const receipt=await f.cli(); assert.equal(receipt.capture_elapsed_ms,1200000); assert.equal(f.captureBudgets.length,5); assert.ok(f.captureBudgets.every(n=>n<=300000)); assert.equal(f.captureBudgets.at(-1),120000);
  const manifest=JSON.parse(await readFile(f.manifest,'utf8')).daily_round; assert.equal(Date.parse(manifest.started_at),Date.parse(start)); assert.equal(manifest.capture_reservation_ms,0);
  assert.throws(()=>parseArgs(['daily-round','--manifest',f.manifest,'--output',f.output,'--defer-stage','review']),/deferral/);
});

test('one exhausted lane lends its allocation; repeated no-progress material cannot loop', async t => {
  const f=await fixture(t); await f.seed(0,15);
  let receipt=await f.cli(),count=0;
  while(receipt.state==='review'){assert.equal(receipt.active.lane,'history');count++;receipt=await f.accept(receipt);}
  assert.equal(count,30);assert.equal(receipt.started_bundles,30);
});

test('shared disk capacity failure reports prior committed/exported fact separately and prevents later source acceptance',async t=>{
 const f=await fixture(t);await f.seed(2,0);const receipt=await f.cli();f.failCapacity();
 const b:ReviewBundle=JSON.parse(await readFile(receipt.active.file,'utf8')),review=result(b,'capacity:accepted');review.source=b.source;
 const row=b.chunks[0].events[0];review.created_at=start;review.candidates[0].journal_date=row.journal_date;review.candidates[0].occurred_at=row.utc_time;review.pages[0].date=row.journal_date.value!;
 const input=join(f.output,'capacity-review.json');await writeFile(input,JSON.stringify(review));
 const failed=await f.cli(['--input',input],1);assert.equal(failed.error.scope,'storage');assert.equal(failed.receipt.fact_commit,'committed');assert.equal(failed.receipt.export_status,'ready');assert.equal(failed.receipt.execution_status,'storage_unavailable');assert.ok(failed.receipt.files.some((file:any)=>file.failure_code==='ENOSPC'));
 assert.equal(f.starts.length,1);const manifest=JSON.parse(await readFile(f.manifest,'utf8')).daily_round;assert.equal(manifest.active.bundle_id,receipt.active.bundle_id);
});

test('journal and source starts share96quota; initial debt is bounded and source bootstrap reaches history before2:1 allocation',async t=>{
 const f=await fixture(t,['codex','claude','wechat']);await f.seed(40,40);await f.seedJournal(40);
 let receipt=await f.cli(),journalCount=0,sourceCount=0;const sources:any[]=[];
 while(['review','journal_review'].includes(receipt.state)){if(receipt.state==='journal_review'){journalCount++;receipt=await f.cli(['--defer-active','Synthetic explicit journal deferral']);}else{sourceCount++;sources.push(receipt.active);receipt=await f.accept(receipt);}}
 assert.equal(journalCount+sourceCount,96);assert.equal(receipt.started_bundles,96);assert.ok(journalCount>1);assert.equal(sources.length,sourceCount);
 assert.deepEqual(sources.slice(0,6).map(r=>`${r.source}:${r.lane}`),['codex:live','claude:live','wechat:live','codex:history','claude:history','wechat:history']);
 assert.equal((JSON.parse(await readFile(f.manifest,'utf8')).daily_round).journal_batches,journalCount);
});

test('105minute journal boundary allows started resolution/deferral but no new final journal semantic material',async t=>{
 const f=await fixture(t);await f.seedJournal(8);const active=await f.cli();assert.equal(active.state,'journal_review');const calls=f.journalRequests.length;f.setClock(Date.parse(start)+105*60000);
 const stopped=await f.cli(['--defer-active','Synthetic deadline deferral']);assert.equal(stopped.state,'complete');assert.equal(stopped.started_bundles,1);assert.equal(f.journalRequests.length,calls);
});

test('oversized journal selection shrinks to fitting prefix; one bad item is isolated without skipping its siblings',async t=>{
 const f=await fixture(t);f.config.limits.chunk_events=80;f.config.limits.bundles_per_round=24;f.config.limits.bundle_bytes=131072;const ids=await f.seedJournal(32);f.journalSize(70000,ids[0]);
 const receipt=await f.cli();assert.equal(receipt.state,'journal_review');assert.equal(receipt.started_bundles,1);assert.equal(receipt.active.work_ids.length,1);assert.notEqual(receipt.active.work_ids[0],ids[0]);
 assert.equal(f.journalRequests[0].length,32);assert.ok(f.journalRequests.some(ids=>ids.length===1));const state=JSON.parse(await readFile(f.manifest,'utf8')).daily_round;assert.deepEqual(state.skipped_journal_ids,[ids[0]]);assert.ok((await stat(receipt.active.file)).size<=131072);
});
