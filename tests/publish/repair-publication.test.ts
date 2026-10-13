import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createStore } from '../../src/store/index.ts';
import { createReviewer } from '../../src/review/index.ts';
import { createPublisher, createSafeWikiWriter, digestBytes, acquireWikiLock } from '../../src/publish/index.ts';
import { createMonthlyConsumer } from '../../src/consumers/monthly/index.ts';
import { createArchiveService } from '../../src/consumers/archive/index.ts';
import { createIndexConsumer } from '../../src/consumers/index/index.ts';
import { monthlyPath } from '../../src/consumers/archive/records.ts';
import { updateManagedBlock } from '../../src/consumers/monthly/blocks.ts';
import type { FactRevision, JournalPatch, WorkItem, Store, JournalResolution } from '../../src/contracts/types.ts';
import { config as fixtureConfig, collection, bundle, result, event, value } from '../store/fixtures.ts';

const now = () => new Date('2026-10-06T12:00:00.000Z');
async function fixture(t: test.TestContext) {
  const config = await fixtureConfig(), store = await createStore(config);
  t.after(async () => { await store.close(); await rm(dirname(config.wiki_root), { recursive: true, force: true }); });
  async function seed(path: string, text: string) { await mkdir(dirname(join(config.wiki_root, path)), { recursive: true }); await writeFile(join(config.wiki_root, path), text); }
  return { config, store, seed };
}
function fact(id = 'fact:display', revision = 1): FactRevision {
  return { schema_version: 1, fact_id: id, revision, content: `Synthetic revision ${revision}`, subject: 'Roy', event_refs: [],
    occurred_at: value('2026-07-15T12:00:00.000Z'), journal_date: value('2026-07-15'), kind: 'fact', action: 'assert', target_refs: [],
    scope: ['personal'], attribution: {}, analytics_projection: { schema_version: 1, value: null, reason: 'Personal fixture' }, recorded_at: '2026-10-05T12:00:00.000Z' };
}
async function importFacts(store: Store, facts: FactRevision[], key: string) {
  await store.importLegacy({ schema_version: 1, migration_key: key, facts, mappings: facts.map(item => ({ schema_version: 1, source_id: item.fact_id, target_id: item.fact_id, confidence: 'verified', reason: null })), work: [] });
}
function patch(ref: FactRevision, id = 'operation:display'): JournalPatch {
  return { schema_version: 1, operation_id: id, date: '2026-07-15', path: 'wiki/personal/journals/日记_2026_07_15.md', baseline_digest: 'absent',
    mode: 'append', old_text: null, new_text: ref.content, fact_refs: [{ schema_version: 1, fact_id: ref.fact_id, revision: ref.revision }] };
}
async function debt(store: Store, p: JournalPatch, suffix = '') {
  const work: WorkItem = { schema_version: 1, work_id: `journal:fixture${suffix}`, kind: 'journal_publication', lane: 'history', state: 'pending',
    payload: { schema_version: 1, fact_ref: p.fact_refs[0], target_refs: [], date: p.date, path: p.path, operation_id: p.operation_id },
    reason: null, migration_key: null, updated_at: now().toISOString() };
  await store.enqueueWork(work); return work;
}
test('real SQLite supplement queue stays pending through missing prerequisites and completes only displayed exact revision', async t => {
  const f = await fixture(t), original = fact(); await importFacts(f.store, [original], 'display');
  const p = patch(original), work = await debt(f.store, p);
  // This file-only operation has no semantic review allocation; save its patch through a synthetic accepted result below instead.
  await f.store.enqueueWork({ schema_version: 1, work_id: `journal_supplement:${p.operation_id}`, kind: 'journal_supplement', lane: 'history', state: 'pending', payload: { patch: p }, reason: null, migration_key: null, updated_at: now().toISOString() });
  const monthly = createMonthlyConsumer(f.store, f.config, { now });
  assert.equal((await monthly.refreshMonthlySupplements('2026-07')).status, 'pending');
  assert.ok((await f.store.listWork('journal_publication', 'pending')).some(item => item.work_id === work.work_id));
  await f.seed(monthlyPath('2026-07'), '# Synthetic manual review\nRetain this body.\n');
  assert.equal((await monthly.refreshMonthlySupplements('2026-07')).status, 'complete');
  assert.equal((await f.store.listWork('journal_publication', 'pending')).length, 0);
  assert.equal((await f.store.listWork('journal_supplement', 'pending')).length, 0);
  assert.ok((await readFile(join(f.config.wiki_root, monthlyPath('2026-07')), 'utf8')).includes(original.content));
  await assert.rejects(readFile(join(f.config.wiki_root, p.path)), { code: 'ENOENT' });
});

test('monthly freezes SQLite work before fact reading; late work and unrepresented revisions remain pending', async t => {
  const f = await fixture(t), original = fact(); await importFacts(f.store, [original], 'freeze');
  await f.seed(monthlyPath('2026-07'), '# Manual review\n');
  const p = patch(original); await debt(f.store, p);
  await f.store.enqueueWork({ schema_version: 1, work_id: 'journal_supplement:operation:display', kind: 'journal_supplement', lane: 'history', state: 'pending', payload: { patch: p }, reason: null, migration_key: null, updated_at: now().toISOString() });
  await debt(f.store, { ...p, operation_id: 'operation:missing', fact_refs: [{ schema_version: 1, fact_id: 'fact:missing', revision: 1 }], path: monthlyPath('2026-07') }, ':missing');
  const port = new Proxy(f.store, { get(target, key) {
    if (key === 'readEffectiveFacts') return async (...args: Parameters<Store['readEffectiveFacts']>) => {
      await debt(f.store, p, ':late');
      return target.readEffectiveFacts(...args);
    };
    const member = Reflect.get(target, key); return typeof member === 'function' ? member.bind(target) : member;
  } });
  assert.equal((await createMonthlyConsumer(port, f.config, { now }).refreshMonthlySupplements('2026-07')).status, 'complete');
  assert.deepEqual((await f.store.listWork('journal_publication', 'pending')).map(work => work.work_id).sort(), ['journal:fixture:late', 'journal:fixture:missing']);
});

test('monthly renders exact withdrawal and moved-date correction without resurrecting archived dailies', async t => {
  const f = await fixture(t), original = fact('fact:move'); await importFacts(f.store, [original], 'move-first');
  await f.seed(monthlyPath('2026-07'), '# Manual July review\n');
  const replacement = { ...original, revision: 2, content: 'Corrected to September', action: 'replace' as const, target_refs: [{ schema_version: 1 as const, fact_id: original.fact_id, revision: 1 }], journal_date: value('2026-09-15'), occurred_at: value('2026-09-15T12:00:00.000Z') };
  await importFacts(f.store, [replacement], 'move-second');
  await debt(f.store, { ...patch(replacement), path: monthlyPath('2026-07') });
  assert.equal((await createMonthlyConsumer(f.store, f.config, { now }).refreshMonthlySupplements('2026-07')).status, 'complete');
  assert.equal((await f.store.listWork('journal_publication', 'pending')).length, 0);
  assert.ok((await readFile(join(f.config.wiki_root, monthlyPath('2026-07')), 'utf8')).includes('更正至其他日期'));
  const retract = { ...replacement, revision: 3, action: 'retract' as const, target_refs: [{ schema_version: 1 as const, fact_id: original.fact_id, revision: 2 }] };
  await importFacts(f.store, [retract], 'move-third');
  await f.seed(monthlyPath('2026-09'), '# Manual September review\n');
  const p = { ...patch(retract, 'operation:withdraw'), date: '2026-09-15', path: monthlyPath('2026-09') }; await debt(f.store, p, ':withdraw');
  assert.equal((await createMonthlyConsumer(f.store, f.config, { now }).refreshMonthlySupplements('2026-09')).status, 'complete');
  assert.equal((await f.store.listWork('journal_publication', 'pending')).length, 0);
  assert.ok((await readFile(join(f.config.wiki_root, monthlyPath('2026-09')), 'utf8')).includes('撤回'));
});

test('archive, monthly and index use injected clock for fold and every durable writer timestamp', async t => {
  const f = await fixture(t), past = fact(), future = { ...fact('fact:future'), content: 'Future hidden content', recorded_at: '2026-10-07T12:00:00.000Z' };
  await importFacts(f.store, [past, future], 'clock');
  await f.seed(monthlyPath('2026-07'), '# Monthly review\nSubstantive manual summary.\n');
  await f.seed(patch(past).path, '# Daily original\n');
  assert.equal((await createMonthlyConsumer(f.store, f.config, { now }).refreshMonthlySupplements('2026-07')).status, 'complete');
  assert.ok(!(await readFile(join(f.config.wiki_root, monthlyPath('2026-07')), 'utf8')).includes(future.content));
  assert.equal((await createArchiveService(f.store, f.config, { now }).run({ month: '2026-07', mode: 'apply' })).status, 'complete');
  const commands = { lint: { executable: 'lint', args: [] }, build_index: { executable: 'index', args: [] }, qmd: { executable: 'qmd', args: [] } };
  assert.equal((await createIndexConsumer(f.store, f.config, { now, commands, runner: async command => ({ exit_code: 0, stdout: command.executable === 'lint' ? JSON.stringify({ report_contract_version: 1, capabilities: ['daily-journal-archive-target-v2'], generated_at: now().toISOString(), counts: { pages: 1, errors: 0, warnings: 0, suggestions: 0 }, errors: [], warnings: [], suggestions: [], disabled_checks: [], tag_source_report: [], synthesis_candidates: [] }) : '', stderr: '' }) }).consume()).status, 'complete');
  assert.ok((await f.store.listFileIntents()).every(intent => intent.created_at === now().toISOString()));
  assert.ok((await f.store.listWork('index_stage')).every(work => work.updated_at === now().toISOString()));
});

async function acceptedPage(f: Awaited<ReturnType<typeof fixture>>, content: string, mode: 'append' | 'replace' = 'append') {
  const prepared = bundle([event()], 'bundle:repair');
  const path = prepared.baselines[0].path;
  await f.seed(path, content);
  prepared.baselines[0] = { schema_version: 1, path, content, digest: digestBytes(Buffer.from(content)) };
  await f.store.saveBundle(prepared);
  const reviewed = result(prepared, 'result:repair');
  reviewed.pages[0].mode = mode;
  reviewed.pages[0].old_text = mode === 'replace' ? 'frozen paragraph' : null;
  const commit = await f.store.commitReview(reviewed);
  return { reviewed, original: commit.patches[0], path };
}
async function replacement(f: Awaited<ReturnType<typeof fixture>>, original: JournalPatch) {
  const prepared = await createReviewer(f.store, f.config).prepareJournalWork!({ schema_version: 1, cutoff: now().toISOString() });
  const selected = prepared.work.filter(work => work.payload.operation_id === original.operation_id);
  assert.ok(selected.length);
  const resolution: JournalResolution = { schema_version: 1, resolution_id: 'resolution:repair', journal_bundle_id: prepared.journal_bundle_id, created_at: now().toISOString(),
    dispositions: selected.map(work => ({ schema_version: 1, work_id: work.work_id, disposition: 'patch', suggestion_id: 'page:repair', reason: null })),
    pages: [{ schema_version: 1, suggestion_id: 'page:repair', work_ids: selected.map(work => work.work_id), path: original.path, date: original.date,
      baseline_digest: prepared.baselines.find(page => page.path === original.path)!.digest, mode: 'append', old_text: null, new_text: 'Reviewed accepted fact repair.\n', supersedes_operation_id: original.operation_id }] };
  return { resolution, commit: await f.store.commitJournalResolution(resolution) };
}
function semanticState(store: ReturnType<typeof createStore> extends Promise<infer S> ? S : never) {
  return Object.fromEntries(['facts', 'results', 'outbox', 'reviewed_sources', 'reviewed_spans', 'reviewed_units'].map(table => [table, store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

test('SQLite no-intent conflict is terminal after one file-only replacement, including old accepted replay and busy lock', async t => {
  const f = await fixture(t), accepted = await acceptedPage(f, 'frozen paragraph\n', 'replace');
  await f.seed(accepted.path, 'Current manual paragraph\n');
  const publisher = createPublisher(f.store, f.config, { now });
  assert.equal((await publisher.applyPatches([accepted.original]))[0].status, 'conflict');
  assert.equal(await f.store.getFileIntent(accepted.original.operation_id), null);
  assert.ok((await f.store.listJournalConflicts()).some(outcome => outcome.operation_id === accepted.original.operation_id));
  await publisher.exportFacts();
  const before = semanticState(f.store), repaired = await replacement(f, accepted.original);
  assert.equal(repaired.commit.patches.length, 1);
  assert.equal((await f.store.commitJournalResolution(repaired.resolution)).reused, true);
  assert.equal((await publisher.applyPatches(repaired.commit.patches))[0].status, 'applied');
  assert.equal((await f.store.getFileIntent(repaired.commit.patches[0].operation_id))!.supersedes_operation_id, accepted.original.operation_id);
  const bytes = await readFile(join(f.config.wiki_root, accepted.path));
  assert.equal((await publisher.applyPatches([accepted.original]))[0].status, 'pending');
  await publisher.publish(accepted.reviewed);
  const lock = await acquireWikiLock(f.config.wiki_root); assert.ok(lock);
  try { assert.equal((await publisher.applyPatches([accepted.original]))[0].status, 'pending'); } finally { await lock.release(); }
  assert.equal((await createSafeWikiWriter(f.store, f.config, { now }).write({ operation_id: accepted.original.operation_id, path: accepted.path, baseline_digest: 'absent', desired_bytes: Buffer.from('old bytes') })).status, 'pending');
  assert.deepEqual(await readFile(join(f.config.wiki_root, accepted.path)), bytes);
  assert.deepEqual(semanticState(f.store), before);
  assert.equal(f.store.db.prepare('SELECT status FROM patches WHERE id=?').get(accepted.original.operation_id)!.status, 'superseded');
  assert.equal((await f.store.listWork('journal_publication', 'pending')).length, 0);
});

test('SQLite superseded saved intent remains inert when either old baseline or old desired bytes reappear', async t => {
  const f = await fixture(t), accepted = await acceptedPage(f, 'frozen paragraph\n');
  const crashed = createPublisher(f.store, f.config, { now, fault(stage) { if (stage === 'after_intent') throw new Error('Synthetic persisted intent interruption'); } });
  assert.equal((await crashed.applyPatches([accepted.original]))[0].status, 'pending');
  const captured = (await f.store.getFileIntent(accepted.original.operation_id))!;
  await f.seed(accepted.path, 'Human changed paragraph\n');
  assert.equal((await createPublisher(f.store, f.config, { now }).applyPatches([accepted.original]))[0].status, 'conflict');
  const repaired = await replacement(f, accepted.original);
  assert.equal((await createPublisher(f.store, f.config, { now }).applyPatches(repaired.commit.patches))[0].status, 'applied');
  assert.equal((await f.store.getFileIntent(accepted.original.operation_id))!.state, 'superseded');
  for (const bytes of [captured.backup_bytes_base64!, captured.desired_bytes_base64!]) {
    await writeFile(join(f.config.wiki_root, accepted.path), Buffer.from(bytes, 'base64'));
    const lock = await acquireWikiLock(f.config.wiki_root); assert.ok(lock);
    try { assert.equal((await createSafeWikiWriter(f.store, f.config, { now }).recoverLocked(captured, lock)).status, 'pending'); } finally { await lock.release(); }
    await createPublisher(f.store, f.config, { now }).publish(accepted.reviewed);
    assert.deepEqual(await readFile(join(f.config.wiki_root, accepted.path)), Buffer.from(bytes, 'base64'));
    assert.equal((await f.store.getFileIntent(accepted.original.operation_id))!.state, 'superseded');
  }
});

test('Publisher SQLite archived patch returns actual pending queue IDs and preserves journal publication debt until display', async t => {
  const f = await fixture(t), prepared = bundle([event('old:event', 'Historical source', '2026-07-15T12:00:00.000Z')], 'bundle:archived');
  const path = patch(fact()).path;
  prepared.baselines = [{ schema_version: 1, path, content: null, digest: 'absent' }];
  await f.store.saveBundle(prepared);
  const reviewed = result(prepared, 'result:archived');
  reviewed.candidates[0].journal_date = value('2026-07-15'); reviewed.candidates[0].occurred_at = value('2026-07-15T12:00:00.000Z');
  reviewed.pages[0].date = '2026-07-15';
  const publisher = createPublisher(f.store, f.config, { now }), published = await publisher.publish(reviewed);
  const queued = published.files.find(file => file.path === path)!;
  assert.equal(queued.status, 'pending'); assert.deepEqual(queued.queued_work_ids, [`journal_supplement:${queued.operation_id}`]);
  assert.ok(published.pending.includes(queued.queued_work_ids![0]));
  assert.ok((await f.store.listWork('journal_publication', 'pending')).length);
  await assert.rejects(readFile(join(f.config.wiki_root, path)), { code: 'ENOENT' });
  await f.seed(monthlyPath('2026-07'), '# Manual monthly review\n');
  await publisher.resume();
  assert.equal((await f.store.listWork('journal_publication', 'pending')).length, 0);
  assert.equal((await f.store.listWork('journal_supplement', 'pending')).length, 0);
  const before = semanticState(f.store);
  await publisher.resume();
  assert.deepEqual(semanticState(f.store), before);
  await assert.rejects(readFile(join(f.config.wiki_root, path)), { code: 'ENOENT' });
});

test('verified monthly derived display terminally retires its original no-intent conflict before old accepted text reappears', async t => {
  const f = await fixture(t), historical = event('event:monthly-original', 'Historical accepted activity', '2026-07-15T12:00:00.000Z');
  const prepared = bundle([historical], 'bundle:monthly-original'), path = monthlyPath('2026-07');
  const frozen = 'frozen paragraph\n';
  await f.seed(path, frozen);
  prepared.baselines = [{ schema_version: 1, path, digest: digestBytes(Buffer.from(frozen)), content: frozen }];
  await f.store.saveBundle(prepared);
  const reviewed = result(prepared, 'result:monthly-original');
  reviewed.candidates[0].journal_date = value('2026-07-15');
  reviewed.candidates[0].occurred_at = value('2026-07-15T12:00:00.000Z');
  Object.assign(reviewed.pages[0], { date: '2026-07-15', mode: 'replace', old_text: 'frozen paragraph' });
  const original = (await f.store.commitReview(reviewed)).patches[0];
  await f.seed(path, 'Manual current monthly body\n');
  const publisher = createPublisher(f.store, f.config, { now });
  assert.equal((await publisher.applyPatches([original]))[0].status, 'conflict');
  assert.equal(await f.store.getFileIntent(original.operation_id), null);
  await publisher.exportFacts();
  const semanticBefore = semanticState(f.store);
  await publisher.resume();
  const debt = (await f.store.listWork('journal_publication')).filter(work => work.payload.operation_id === original.operation_id);
  assert.ok(debt.length && debt.every(work => work.state === 'complete'), 'Verified derived display closes only the bound exact debt');
  assert.ok(await f.store.getOperationSupersession(original.operation_id), 'Display completion must terminally retire the now-unnecessary original operation');
  const displayed = await readFile(join(f.config.wiki_root, path), 'utf8');
  assert.ok(displayed.includes('You verified the parser.'));
  const manual = displayed + '\nfrozen paragraph\n';
  await f.seed(path, manual);
  assert.equal((await publisher.applyPatches([original]))[0].status, 'pending');
  await publisher.publish(reviewed);
  assert.equal(await readFile(join(f.config.wiki_root, path), 'utf8'), manual);
  assert.deepEqual(semanticState(f.store), semanticBefore);
  assert.equal(await f.store.getFileIntent(original.operation_id), null);
});

test('monthly represented refs upgrade an old sparse applied noop intent with a new stable exact-ref operation identity',async t=>{
 const f=await fixture(t),represented=fact('fact:represented'),path=monthlyPath('2026-07');await importFacts(f.store,[represented],'represented-ref');
 const content=updateManagedBlock('# Synthetic existing monthly summary\n','monthly-review','2026-07','## 月回顾摘要\n\nSynthetic full represented statement.\n');await f.seed(path,content);
 await f.store.enqueueWork({schema_version:1,work_id:'monthly-review-record:represented',kind:'monthly_review_record',lane:'history',state:'complete',payload:{month:'2026-07',created_at:now().toISOString(),review:{fact_refs:[{schema_version:1,fact_id:represented.fact_id,revision:1}]}},reason:null,migration_key:null,updated_at:now().toISOString()});
 const monthly=createMonthlyConsumer(f.store,f.config,{now});
 // Render the existing managed body once, then model the old-version sparse noop
 // on precisely the next unchanged baseline and desired bytes.
 await f.store.enqueueWork({schema_version:1,work_id:'journal_supplement:represented',kind:'journal_supplement',lane:'history',state:'pending',payload:{patch:patch(represented)},reason:null,migration_key:null,updated_at:now().toISOString()});
 assert.equal((await monthly.refreshMonthlySupplements('2026-07')).status,'complete');
 const desired=await readFile(join(f.config.wiki_root,path)),digest=digestBytes(desired);
 const oldId=`monthly-supplement:2026-07:${digestBytes(Buffer.from(`${digest}:${digestBytes(desired)}`))}`;
 assert.equal((await createSafeWikiWriter(f.store,f.config,{now}).write({operation_id:oldId,path,baseline_digest:digest,desired_bytes:desired,fact_refs:[]})).status,'noop');
 const old=await f.store.getFileIntent(oldId);assert.deepEqual(old!.fact_refs,[]);
 const work=await debt(f.store,{...patch(represented),path},':represented');
 assert.equal((await monthly.refreshMonthlySupplements('2026-07')).status,'complete');
 assert.equal((await f.store.listWork('journal_publication')).find(w=>w.work_id===work.work_id)!.state,'complete');
 assert.deepEqual(await f.store.getFileIntent(oldId),old,'Historical sparse intent remains immutable');
 const intents=await f.store.listFileIntents();const exact=intents.filter(i=>i.operation_id!==oldId&&i.path===path&&i.baseline_digest===digest&&i.desired_digest===digest);assert.equal(exact.length,1);assert.deepEqual(exact[0].fact_refs,[{schema_version:1,fact_id:represented.fact_id,revision:1}]);
 const before=intents.length;assert.equal((await monthly.refreshMonthlySupplements('2026-07')).status,'complete');assert.equal((await f.store.listFileIntents()).length,before);
});
