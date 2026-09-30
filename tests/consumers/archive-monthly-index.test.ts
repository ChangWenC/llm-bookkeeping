import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createStore } from '../../src/store/index.ts';
import { createArchiveService, readArchiveRecords } from '../../src/consumers/archive/index.ts';
import { createMonthlyConsumer } from '../../src/consumers/monthly/index.ts';
import { createIndexConsumer, runPublicCommand } from '../../src/consumers/index/index.ts';
import { createPublisher, acquireWikiLock, createSafeWikiWriter, digestBytes } from '../../src/publish/index.ts';
import type { Store, FactRevision, FactArtifact, BookkeepingConfig } from '../../src/contracts/types.ts';
import { config as baseConfig } from '../../test/fixtures/basic.ts';
const now = () => new Date('2026-09-30T12:00:00Z');
const daily = (date: string) => `wiki/personal/journals/日记_${date.replaceAll('-', '_')}.md`;
const review = (month: string) => `wiki/personal/journals/reviews/回顾_${month.replaceAll('-', '_')}.md`;
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'new-bookkeeping-consumers-')), wiki = join(root, 'wiki'); await mkdir(wiki);
  const config = { ...baseConfig, wiki_root: wiki, data_dir: join(root, 'data') } as BookkeepingConfig;
  const store = await createStore(config); t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  async function seed(path: string, text: string | Uint8Array) { await mkdir(dirname(join(wiki, path)), { recursive: true }); await writeFile(join(wiki, path), text); }
  return { root, wiki, config, store, seed };
}
function fact(id: string, content: string, revision = 1, action: FactRevision['action'] = 'assert', targets: FactRevision['target_refs'] = []): FactRevision {
  return { schema_version: 1, fact_id: id, revision, event_refs: [], content, subject: 'Roy', occurred_at: { schema_version: 1, value: null, reason: 'Synthetic date-only fixture' },
    journal_date: { schema_version: 1, value: '2026-07-15', reason: null }, kind: 'fact', analytics_projection: { schema_version: 1, value: null, reason: 'Synthetic personal-only fixture' },
    action, target_refs: targets, scope: ['personal'], attribution: {}, recorded_at: `2026-09-${String(10 + revision).padStart(2, '0')}T12:00:00Z` };
}
async function importFacts(store: Store, facts: FactRevision[], identity: string) {
  await store.importLegacy({ schema_version: 1, migration_key: `synthetic:${identity}`, facts, mappings: facts.map(f => ({ schema_version: 1, source_id: `${identity}:${f.fact_id}`, target_id: f.fact_id, confidence: 'verified', reason: null })), work: [] });
}
async function indexWork(store: Store, id: string, path: string) { await store.enqueueWork({ schema_version: 1, work_id: id, kind: 'index', lane: 'live', state: 'pending', payload: { path, digest: 'synthetic' }, reason: null, migration_key: null, updated_at: now().toISOString() }); }

test('one-month report is read-only; apply preserves exact full originals and precise backlink descriptions before deleting only ordinary daily', async t => {
  const f = await fixture(t), source = daily('2026-07-15'), original = '---\ntype: journal\n---\n\n手写原文\n- [x] 已完成\n[[合成项目]]\n';
  await f.seed(source, original); await f.seed(daily('2026-07-16'), '---\ntags: [pinned-daily]\n---\n保留\n');
  await f.seed(daily('2026-07-17'), '---\ntags:\n  - intentional-journal\n---\n保留专题\n');
  await f.seed('wiki/personal/journals/专题_2026_07.md', '月专题不删除'); await f.seed(daily('2026-08-15'), '上一月保留');
  await f.seed(review('2026-07'), '# 七月回顾\n\n可用的人工作品与正文。\n');
  await f.seed('wiki/projects/项目.md', '[[日记_2026_07_15|原描述]] [[日记_2026_07_15]] [[日记_2026_07_150]]\n');
  await importFacts(f.store, [fact('fact:known', '已知事实')], 'known');
  const service = createArchiveService(f.store, f.config, { now });
  const report = await service.run({ month: '2026-07', mode: 'report' });
  assert.deepEqual(report.pages.map(p => p.status), ['eligible', 'retained', 'retained']); assert.equal((await f.store.listFileIntents()).length, 0);
  assert.equal(await readFile(join(f.wiki, source), 'utf8'), original);
  const applied = await service.run({ month: '2026-07', mode: 'apply' }); assert.equal(applied.status, 'complete');
  await assert.rejects(readFile(join(f.wiki, source)), { code: 'ENOENT' });
  for (const date of ['2026-07-16', '2026-07-17', '2026-08-15']) assert.ok(await readFile(join(f.wiki, daily(date))));
  const archive = JSON.parse(await readFile(join(f.wiki, applied.pages.find(page => page.path === source)!.archive_path!), 'utf8'));
  assert.equal(archive.format, 'daily-journal-archive-v2'); assert.equal(Buffer.from(archive.original_bytes_base64, 'base64').toString(), original);
  assert.equal(archive.original_digest, digestBytes(Buffer.from(original))); assert.equal(archive.fact_refs[0].fact_id, 'fact:known');
  assert.equal(await readFile(join(f.wiki, 'wiki/projects/项目.md'), 'utf8'), '[[回顾_2026_07|原描述]] [[回顾_2026_07|2026-07-15 日记]] [[日记_2026_07_150]]\n');
  assert.equal((await f.store.listWork('archive', 'complete')).length, 1);
});

test('archive blocks missing or unusable monthly body and refuses retained month', async t => {
  const f = await fixture(t); await f.seed(daily('2026-07-15'), 'human body'); await f.seed(review('2026-07'), '# 只有标题\n');
  const service = createArchiveService(f.store, f.config, { now });
  assert.equal((await service.run({ month: '2026-07', mode: 'apply' })).status, 'pending'); assert.equal(await readFile(join(f.wiki, daily('2026-07-15')), 'utf8'), 'human body');
  assert.equal((await service.run({ month: '2026-08', mode: 'apply' })).status, 'pending');
});

test('archive resumes crash before original FileIntent and after deletion without losing saved source', async t => {
  const f = await fixture(t), path = daily('2026-07-15'); await f.seed(path, 'original\n'); await f.seed(review('2026-07'), '# 回顾\n真实合成摘要\n');
  const before = await createArchiveService(f.store, f.config, { now, faultArchive(stage) { if (stage === 'plan_saved') throw new Error('synthetic crash before original intent'); } }).run({ month: '2026-07', mode: 'apply' });
  assert.equal(before.status, 'pending'); assert.equal((await f.store.listWork('archive_plan', 'pending')).length, 1);
  const deleted = await createArchiveService(f.store, f.config, { now, faultArchive(stage) { if (stage === 'after_delete') throw new Error('synthetic crash after delete'); } }).run({ month: '2026-07', mode: 'apply' });
  assert.equal(deleted.status, 'pending'); await assert.rejects(readFile(join(f.wiki, path)), { code: 'ENOENT' });
  const resumed = await createArchiveService(f.store, f.config, { now }).run({ month: '2026-07', mode: 'apply' }); assert.equal(resumed.pages[0].status, 'noop');
  assert.equal((await f.store.listWork('archive_plan', 'pending')).length, 0); assert.equal((await readArchiveRecords(f.config)).length, 1);
});

test('archive source/backlink manual changes defer affected page while another page completes', async t => {
  const f = await fixture(t), one = daily('2026-07-15'), two = daily('2026-07-16');
  await f.seed(one, 'first original'); await f.seed(two, 'second original'); await f.seed(review('2026-07'), '# 月回顾\n实质摘要\n');
  await f.seed('wiki/projects/one.md', '[[日记_2026_07_15|描述]]');
  const result = await createArchiveService(f.store, f.config, { now, async faultArchive(stage, path) { if (stage === 'archive_saved' && path === one) await f.seed('wiki/projects/one.md', 'manual edit [[日记_2026_07_15|描述]]'); } }).run({ month: '2026-07', mode: 'apply' });
  assert.equal(result.status, 'partial'); assert.equal(result.pages.find(p => p.path === one)?.status, 'conflict');
  assert.equal(await readFile(join(f.wiki, one), 'utf8'), 'first original'); await assert.rejects(readFile(join(f.wiki, two)), { code: 'ENOENT' });
  const g = await fixture(t); await g.seed(one, 'preserved version'); await g.seed(review('2026-07'), '# 月回顾\n实质摘要');
  const changed = await createArchiveService(g.store, g.config, { now, async faultArchive(stage) { if (stage === 'before_delete') await g.seed(one, 'human changed after archive'); } }).run({ month: '2026-07', mode: 'apply' });
  assert.equal(changed.status, 'pending'); assert.equal(await readFile(join(g.wiki, one), 'utf8'), 'human changed after archive');
  assert.equal((await g.store.listFileIntents()).filter(i => i.desired_bytes_base64 === null).length, 0);
});

test('immutable archive tampering and a newly reintroduced backlink prevent deletion', async t => {
  const f = await fixture(t), path = daily('2026-07-15'); await f.seed(path, 'original'); await f.seed(review('2026-07'), '# 回顾\n可用摘要');
  const result = await createArchiveService(f.store, f.config, { now, async faultArchive(stage) { if (stage === 'links_saved') await f.seed('wiki/projects/late.md', 'late [[日记_2026_07_15]]'); } }).run({ month: '2026-07', mode: 'apply' });
  assert.equal(result.status, 'pending'); assert.equal(await readFile(join(f.wiki, path), 'utf8'), 'original');
  const g = await fixture(t); await g.seed(path, 'preserved source'); await g.seed(review('2026-07'), '# 回顾\n可用摘要');
  const tampered = await createArchiveService(g.store, g.config, { now, async faultArchive(stage) {
    if (stage === 'before_delete') { const records = await readArchiveRecords(g.config); await g.seed(records[0].file, '{}\n'); }
  } }).run({month: '2026-07', mode: 'apply'});
  assert.equal(tampered.status, 'pending'); assert.equal(await readFile(join(g.wiki, path), 'utf8'), 'preserved source');
});

test('archive reader filters schema and unknown families, preserves malformed-record issues and full original references', async t => {
  const f = await fixture(t), path = 'wiki/personal/_evidence/daily_journals/daily_2026.jsonl';
  const record = { schema_version: 'daily-journal-jsonl-v1', id: 'daily:2026-07-15', date: '2026-07-15', sections: { 项目: ['same real occurrence', 'same real occurrence', { text: 'other unverified narrative' }] } };
  const bytes = JSON.stringify(record) + '\n' + '{"date":"2026-07-16",bad record}\n';
  await f.seed(path, bytes);
  await f.seed('wiki/personal/_evidence/daily_journals/schema_daily_journal.json', JSON.stringify({type: 'object', properties: {date: {type: 'string'}}}));
  await f.seed('wiki/personal/_evidence/daily_journals/unrelated.json', JSON.stringify({date: '2026-01-01', source: 'not an archive family'}));
  const first = await readArchiveRecords(f.config); assert.equal(first.length, 1); assert.equal(first.issues.length, 1); assert.equal(first.issues[0].date, '2026-07-16');
  assert.deepEqual(first[0].record, record); assert.equal(await readFile(join(f.wiki, path), 'utf8'), bytes);
  await rename(join(f.wiki, path), join(f.wiki, 'wiki/personal/_evidence/daily_journals/moved_2026.jsonl'));
  assert.equal((await readArchiveRecords(f.config))[0].file_digest, first[0].file_digest);
  await f.seed('wiki/personal/_evidence/daily_journals/new.json', JSON.stringify({ schema_version: 1, format: 'daily-journal-archive-v2', archive_id: 'synthetic:new', date: '2026-07-16', original_markdown: 'already mapped narrative', fact_refs: [{ schema_version: 1, fact_id: 'fact:existing', revision: 1 }] }));
  const second = await readArchiveRecords(f.config); assert.equal(second.length, 2); assert.equal(second.issues.length, 1);
  assert.equal((await f.store.readEffectiveFacts({range: {schema_version:1,from:'2026-07-01T00:00:00Z',to:'2026-08-01T00:00:00Z'}})).length, 0);
});

test('monthly consume only queues preparation and acknowledges exported inputs without creating a Markdown review', async t => {
  const f = await fixture(t); await importFacts(f.store, [fact('fact:queue', '活动')], 'queue'); await createPublisher(f.store, f.config, { now }).exportFacts();
  const monthly = createMonthlyConsumer(f.store, f.config, { now }); const result = await monthly.consume(); assert.equal(result.status, 'complete');
  assert.equal((await f.store.listReadyBatches('monthly')).length, 0); assert.ok((await f.store.listWork('prepare_monthly', 'pending')).length > 0);
  await assert.rejects(readFile(join(f.wiki, review('2026-07'))), { code: 'ENOENT' });
  const count = (await f.store.listWork('prepare_monthly')).length; await monthly.consume(); assert.equal((await f.store.listWork('prepare_monthly')).length, count);
});

test('monthly supplement folds replacement/retraction and protects manual body and derived-region edits', async t => {
  const f = await fixture(t); await f.seed(review('2026-07'), '# 人工月回顾\n\n人工正文与 [[链接]]。\n');
  await importFacts(f.store, [fact('fact:a', '旧内容'), fact('fact:b', '另一有效内容')], 'initial');
  const monthly = createMonthlyConsumer(f.store, f.config, { now }); assert.equal((await monthly.refreshMonthlySupplements('2026-07')).status, 'complete');
  await importFacts(f.store, [fact('fact:a', '更正内容', 2, 'replace', [{ schema_version: 1, fact_id: 'fact:a', revision: 1 }])], 'replace');
  assert.equal((await monthly.refreshMonthlySupplements('2026-07')).status, 'complete');
  let bytes = await readFile(join(f.wiki, review('2026-07')), 'utf8'); assert.ok(bytes.startsWith('# 人工月回顾\n\n人工正文与 [[链接]]。\n')); assert.ok(bytes.includes('更正内容')); assert.ok(!bytes.includes('旧内容'));
  await importFacts(f.store, [fact('fact:b', '', 2, 'retract', [{ schema_version: 1, fact_id: 'fact:b', revision: 1 }])], 'retract');
  assert.equal((await monthly.refreshMonthlySupplements('2026-07')).status, 'complete'); bytes = await readFile(join(f.wiki, review('2026-07')), 'utf8'); assert.ok(!bytes.includes('另一有效内容'));
  await f.seed(review('2026-07'), bytes.replace('更正内容', '人工在派生区修改'));
  assert.equal((await monthly.refreshMonthlySupplements('2026-07')).status, 'partial'); assert.ok((await readFile(join(f.wiki, review('2026-07')), 'utf8')).includes('人工在派生区修改'));
});

test('monthly semantic summary persists history, recovers file fault, excludes already mapped fact refs from supplement', async t => {
  const f = await fixture(t); await importFacts(f.store, [fact('fact:summary', '已在摘要映射内容')], 'summary'); await createPublisher(f.store, f.config, { now }).exportFacts();
  const base = (await f.store.listReadyBatches('monthly'))[0];
  const batch: FactArtifact = { ...base, monthly_review: { schema_version: 1, month: '2026-07', summary: '合成月回顾摘要。', fact_refs: [{ schema_version: 1, fact_id: 'fact:summary', revision: 1 }], supplement_text: '', coverage_status: 'partial' } };
  const failed = await createMonthlyConsumer(f.store, f.config, { now, fault(stage) { if (stage === 'after_target') throw new Error('monthly rename crash'); } }).publishMonthlyReview(batch);
  assert.equal(failed.status, 'pending');
  const monthly = createMonthlyConsumer(f.store, f.config, { now }); assert.equal((await monthly.publishMonthlyReview(batch)).status, 'complete');
  const content = await readFile(join(f.wiki, review('2026-07')), 'utf8'); assert.ok(content.includes('合成月回顾摘要。')); assert.ok(content.includes('仍有采集或审阅缺口')); assert.ok(!content.includes('已在摘要映射内容'));
  assert.equal((await f.store.listWork('monthly_review_record', 'complete')).length, 1); assert.equal((await f.store.listReadyBatches('monthly-publish')).length, 0);
  const context = await monthly.prepareMonthlyContext('2026-07'); assert.equal(context.coverage_status, 'unknown'); assert.equal(context.facts.length, 1);
});

test('index merges paths, protects build with shared lock, releases before qmd and retains pending on qmd failure', async t => {
  const f = await fixture(t); await f.seed('wiki/projects/a.md', 'a');
  await indexWork(f.store, 'index:one', 'wiki/projects/a.md'); await indexWork(f.store, 'index:two', 'wiki/projects/a.md');
  const stages: string[] = []; let failQmd = true;
  const commands = Object.fromEntries(['lint', 'build_index', 'qmd'].map(stage => [stage, { executable: stage, args: [] }])) as any;
  const consumer = createIndexConsumer(f.store, f.config, { commands, async runner(command, context) {
    stages.push(command.executable); assert.deepEqual(context.paths, ['wiki/projects/a.md']);
    const lock = await acquireWikiLock(f.wiki);
    if (command.executable === 'build_index') { assert.equal(lock, null); await f.seed('index.md', 'synthetic generated index'); }
    else { assert.ok(lock); await lock.release(); }
    return { exit_code: command.executable === 'qmd' && failQmd ? 1 : 0, stdout: '', stderr: 'synthetic qmd failure' };
  } });
  assert.equal((await consumer.consume()).status, 'partial'); assert.equal((await f.store.listWork('index', 'pending')).length, 2);
  failQmd = false; assert.equal((await consumer.consume()).status, 'complete'); assert.deepEqual(stages, ['lint', 'build_index', 'qmd', 'qmd']);
  assert.equal((await f.store.listWork('index', 'pending')).length, 0); assert.equal((await f.store.listWork('index_failure', 'pending')).length, 0);
});

test('busy index writer delays build and new work arriving during qmd is not swallowed', async t => {
  const f = await fixture(t); await f.seed('wiki/a.md', 'a'); await indexWork(f.store, 'index:a', 'wiki/a.md');
  const lock = await acquireWikiLock(f.wiki); assert.ok(lock);
  const commands = Object.fromEntries(['lint', 'build_index', 'qmd'].map(stage => [stage, { executable: stage, args: [] }])) as any;
  const invoked: string[] = [];
  const consumer = createIndexConsumer(f.store, f.config, { commands, async runner(command) { invoked.push(command.executable); if (command.executable === 'qmd') await indexWork(f.store, 'index:late', 'wiki/a.md'); return { exit_code: 0, stdout: '', stderr: '' }; } });
  assert.equal((await consumer.consume()).status, 'pending'); assert.deepEqual(invoked, ['lint']); await lock.release();
  assert.equal((await consumer.consume()).status, 'complete'); assert.deepEqual((await f.store.listWork('index', 'pending')).map(work => work.work_id), ['index:late']);
});

test('public command runner uses explicit argv, reports failures and bounded timeout on real synthetic process', async t => {
  const f = await fixture(t);
  const out = await runPublicCommand({ executable: process.execPath, args: ['-e', "process.stdout.write(process.env.BOOKKEEPING_CHANGED_PATHS_JSON);process.exit(3)"] }, { wiki_root: f.wiki, paths: ['x.md'] });
  assert.equal(out.exit_code, 3); assert.equal(out.stdout, '["x.md"]');
  const timed = await runPublicCommand({ executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], timeout_ms: 30 }, { wiki_root: f.wiki, paths: [] }); assert.notEqual(timed.exit_code, 0);
});

test('publisher resume actually refreshes old-month effective supplements without another semantic review', async t => {
  const f = await fixture(t); await f.seed(review('2026-07'), '# 人工回顾\n人工正文'); await importFacts(f.store, [fact('fact:auto', '自动展示的旧月补记')], 'auto');
  const result = await createPublisher(f.store, f.config, { now }).resume(); assert.equal(result.export_status, 'ready');
  assert.ok(result.consumers.some(outcome => outcome.target.startsWith('monthly-display:') && outcome.status === 'complete'));
  assert.ok((await readFile(join(f.wiki, review('2026-07')), 'utf8')).includes('自动展示的旧月补记'));
  assert.equal((await f.store.listReadyBatches('monthly-display')).length, 0);
  await importFacts(f.store, [fact('fact:auto', '无需重审的修订', 2, 'replace', [{schema_version:1,fact_id:'fact:auto',revision:1}])], 'auto-replace');
  await createPublisher(f.store, f.config, {now}).resume(); const content = await readFile(join(f.wiki, review('2026-07')), 'utf8');
  assert.ok(content.includes('无需重审的修订')); assert.ok(!content.includes('自动展示的旧月补记')); assert.ok(content.startsWith('# 人工回顾\n人工正文'));
});

test('killed archive process leaves durable deletion/plan and its dead lock resumes safely', async t => {
  const f = await fixture(t), path = daily('2026-07-15'); await f.seed(path, 'crash original'); await f.seed(review('2026-07'), '# 月回顾\n实质摘要');
  const storeUrl = new URL('../../src/store/index.ts', import.meta.url).href, serviceUrl = new URL('../../src/consumers/archive/index.ts', import.meta.url).href;
  const code = `import {createStore} from ${JSON.stringify(storeUrl)};import {createArchiveService} from ${JSON.stringify(serviceUrl)};const config=${JSON.stringify(f.config)};const store=await createStore(config);await createArchiveService(store,config,{now:()=>new Date('2026-09-30T12:00:00Z'),faultArchive(stage){if(stage==='after_delete')process.exit(7)}}).run({month:'2026-07',mode:'apply'});process.exit(8);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {stdio:'ignore'}); const [exit] = await once(child,'exit'); assert.equal(exit,7);
  await assert.rejects(readFile(join(f.wiki,path)),{code:'ENOENT'});
  const result = await createArchiveService(f.store,f.config,{now}).run({month:'2026-07',mode:'apply'}); assert.equal(result.status,'complete'); assert.equal(result.pages[0].status,'noop');
  assert.equal((await f.store.listWork('archive_plan','pending')).length,0);
});

test('real index subprocess holds its own PID lock even when coordinator dies', async t => {
  const f = await fixture(t), marker = join(f.root,'child-running'), done = join(f.root,'child-done');
  const runnerUrl = new URL('../../src/consumers/index/index.ts',import.meta.url).href;
  const childCode = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));setTimeout(()=>{fs.writeFileSync(${JSON.stringify(done)},'done')},500);`;
  const code = `import {runPublicCommand} from ${JSON.stringify(runnerUrl)};import {access} from 'node:fs/promises';const task=runPublicCommand({executable:process.execPath,args:['-e',${JSON.stringify(childCode)}]},{wiki_root:${JSON.stringify(f.wiki)},paths:[],requires_wiki_lock:true});const timer=setInterval(async()=>{try{await access(${JSON.stringify(marker)});process.exit(9)}catch{}},5);await task;clearInterval(timer);process.exit(10);`;
  const parent = spawn(process.execPath,['--input-type=module','-e',code],{stdio:'ignore'}); const [exit] = await once(parent,'exit'); assert.equal(exit,9);
  assert.equal(await acquireWikiLock(f.wiki),null); // executing writer PID survives the coordinator
  for(let attempt=0;attempt<100;attempt++){try{await readFile(done);break}catch{await new Promise(resolve=>setTimeout(resolve,10))}}
  assert.equal(await readFile(done,'utf8'),'done');
  let lock=null;for(let attempt=0;attempt<100;attempt++){lock=await acquireWikiLock(f.wiki);if(lock)break;await new Promise(resolve=>setTimeout(resolve,10))}
  assert.ok(lock);await lock.release();
});
