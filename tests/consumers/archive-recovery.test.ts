import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStore } from '../../src/store/index.ts';
import { createArchiveService, readArchiveRecords } from '../../src/consumers/archive/index.ts';
import { createPublisher, createSafeWikiWriter, acquireWikiLock } from '../../src/publish/index.ts';
import { frontmatterScalar } from '../../src/publish/journals.ts';
import { config as base } from '../../test/fixtures/basic.ts';
const now = () => new Date('2026-10-01T12:00:00Z');
const daily = 'wiki/personal/journals/日记_2026_07_01.md';
const monthly = 'wiki/personal/journals/reviews/回顾_2026_07.md';
const original = '# July daily\n完整合成原文。\n';
const review = '# July review\n可用合成月回顾正文。\n';
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'bookkeeping-archive-recovery-'));
  const config = { ...base, wiki_root: join(root, 'wiki'), data_dir: join(root, 'data') };
  await mkdir(join(config.wiki_root, 'wiki/personal/journals/reviews'), { recursive: true });
  await writeFile(join(config.wiki_root, daily), original);
  await writeFile(join(config.wiki_root, monthly), review);
  const store = await createStore(config);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  return { config, store };
}
async function interrupt(f: Awaited<ReturnType<typeof fixture>>, stage: 'after_intent' | 'after_target') {
  const result = await createArchiveService(f.store, f.config, { now, fault(at, id) {
    if (at === stage && id.startsWith('archive-delete:')) throw new Error('Synthetic deletion crash');
  } }).run({ month: '2026-07', mode: 'apply' });
  assert.equal(result.status, 'pending');
  const records = await readArchiveRecords(f.config);
  assert.equal(Buffer.from(String(records[0].record.original_bytes_base64), 'base64').toString(), original);
}
test('daily publisher resume revalidates archive dependencies before executing a prepared delete', async t => {
  const f = await fixture(t); await interrupt(f, 'after_intent');
  await unlink(join(f.config.wiki_root, monthly));
  const resumed = await createPublisher(f.store, f.config, { now }).resume();
  assert.equal(await readFile(join(f.config.wiki_root, daily), 'utf8'), original);
  assert.ok(resumed.files.some(file => file.operation_id.startsWith('archive-delete:') && file.status === 'pending' && /monthly review/i.test(file.reason ?? '')));
  assert.equal((await f.store.listFileIntents()).find(intent => intent.operation_id.startsWith('archive-delete:'))?.state, 'prepared');
  await writeFile(join(f.config.wiki_root, monthly), review);
  const retry = await createPublisher(f.store, f.config, { now }).resume();
  assert.ok(retry.files.some(file => file.operation_id.startsWith('archive-delete:') && file.status === 'applied'));
  await assert.rejects(readFile(join(f.config.wiki_root, daily)), { code: 'ENOENT' });
  assert.equal((await f.store.listWork('archive_plan', 'pending')).length, 0);
});
test('post-unlink crash repairs intent registration even when a dependency subsequently disappears', async t => {
  const f = await fixture(t); await interrupt(f, 'after_target');
  await unlink(join(f.config.wiki_root, monthly));
  const result = await createPublisher(f.store, f.config, { now }).resume();
  assert.ok(result.files.some(file => file.operation_id.startsWith('archive-delete:') && file.status === 'noop'));
  assert.equal((await f.store.listFileIntents()).find(intent => intent.operation_id.startsWith('archive-delete:'))?.state, 'applied');
  await assert.rejects(readFile(join(f.config.wiki_root, daily)), { code: 'ENOENT' });
});
test('prepared archive deletion never overwrites or deletes a manual daily revision', async t => {
  const f = await fixture(t); await interrupt(f, 'after_intent');
  const manual = original + '人工后来补充。\n'; await writeFile(join(f.config.wiki_root, daily), manual);
  const result = await createPublisher(f.store, f.config, { now }).resume();
  assert.ok(result.files.some(file => file.operation_id.startsWith('archive-delete:') && file.status === 'pending'));
  assert.equal(await readFile(join(f.config.wiki_root, daily), 'utf8'), manual);
  const records = await readArchiveRecords(f.config);
  assert.equal(Buffer.from(String(records[0].record.original_bytes_base64), 'base64').toString(), original);
});
test('archive migrates root maintenance and new managed page backlinks, preserving every displayed label', async t => {
  const f = await fixture(t);
  const managed = ['log.md', 'log_archive.md', 'index.md', 'attention.md', 'roadmap.md', 'handoff.md', 'new-manual-page.md'];
  const linked = '[[日记_2026_07_01|原描述]] [[日记_2026_07_01]] [[日记_2026_07_01#段落|]] [[日记_2026_07_010|相似名称]]';
  for (const path of managed) await writeFile(join(f.config.wiki_root, path), linked);
  const excluded = ['raw/source.md', 'wiki/personal/_evidence/frozen.md', 'schemas/personal.md', 'templates/journal.md', 'src/code.md', 'AGENTS.md'];
  for (const path of excluded) {
    await mkdir(join(f.config.wiki_root, path, '..'), { recursive: true });
    await writeFile(join(f.config.wiki_root, path), linked);
  }
  const result = await createArchiveService(f.store, f.config, { now }).run({ month: '2026-07', mode: 'apply' });
  assert.equal(result.status, 'complete', JSON.stringify(result));
  const migrated = '[[回顾_2026_07|原描述]] [[回顾_2026_07|日记_2026_07_01]] [[回顾_2026_07|]] [[日记_2026_07_010|相似名称]]';
  for (const path of managed) assert.equal(await readFile(join(f.config.wiki_root, path), 'utf8'), migrated);
  for (const path of excluded) assert.equal(await readFile(join(f.config.wiki_root, path), 'utf8'), linked);
  await assert.rejects(readFile(join(f.config.wiki_root, daily)), { code: 'ENOENT' });
});
test('final re-enumeration protects daily when a new root backlink appears after planning', async t => {
  const f = await fixture(t), link = '[[日记_2026_07_01|稍后人工新建]]';
  const result = await createArchiveService(f.store, f.config, { now, async faultArchive(stage) {
    if (stage === 'before_delete') await writeFile(join(f.config.wiki_root, 'late-handoff.md'), link);
  } }).run({ month: '2026-07', mode: 'apply' });
  assert.equal(result.status, 'pending');
  assert.equal(await readFile(join(f.config.wiki_root, daily), 'utf8'), original);
  assert.equal(await readFile(join(f.config.wiki_root, 'late-handoff.md'), 'utf8'), link);
  assert.ok(result.pages.some(page => /backlink appeared/.test(page.reason ?? '')));
});
test('generic writer recovery refuses an extant archive delete; publisher retries only saved delete paths', async t => {
  const f = await fixture(t); await interrupt(f, 'after_intent');
  const intent = (await f.store.listFileIntents()).find(intent => intent.operation_id.startsWith('archive-delete:'))!;
  const lock = await acquireWikiLock(f.config.wiki_root); assert.ok(lock);
  try {
    const blocked = await createSafeWikiWriter(f.store, f.config, { now }).recoverLocked(intent, lock);
    assert.equal(blocked.status, 'pending');
    assert.equal(await readFile(join(f.config.wiki_root, daily), 'utf8'), original);
  } finally { await lock.release(); }
  const next = 'wiki/personal/journals/日记_2026_07_02.md', nextBytes = '# New sibling\n新出现的独立合成日记。\n';
  await writeFile(join(f.config.wiki_root, next), nextBytes);
  const resumed = await createPublisher(f.store, f.config, { now }).resume();
  assert.ok(resumed.files.some(file => file.operation_id === intent.operation_id && file.status === 'applied'));
  await assert.rejects(readFile(join(f.config.wiki_root, daily)), { code: 'ENOENT' });
  assert.equal(await readFile(join(f.config.wiki_root, next), 'utf8'), nextBytes);
  assert.equal((await readArchiveRecords(f.config)).length, 1);
  assert.ok(!(await f.store.listWork('archive_plan')).some(work => work.payload.path === next));
});
test('a new daily backlink during publisher recovery remains intact and locally defers the saved deletion', async t => {
  const f = await fixture(t); await interrupt(f, 'after_intent');
  const next = 'wiki/personal/journals/日记_2026_07_02.md', bytes = '# New sibling\n完整新原文 [[日记_2026_07_01|原有描述]]\n';
  await writeFile(join(f.config.wiki_root, next), bytes);
  const result = await createPublisher(f.store, f.config, { now }).resume();
  assert.ok(result.files.some(file => file.operation_id.startsWith('archive-delete:') && file.status === 'pending' && /backlink/.test(file.reason ?? '')));
  assert.equal(await readFile(join(f.config.wiki_root, next), 'utf8'), bytes);
  assert.equal(await readFile(join(f.config.wiki_root, daily), 'utf8'), original);
  assert.equal((await readArchiveRecords(f.config)).length, 1);
  assert.ok(!(await f.store.listFileIntents()).some(intent => intent.path === next));
});
test('plain, quoted and commented draft/pending statuses all prevent archive report and deletion', async t => {
  const variants = ['draft', 'pending # unfinished', '"draft"', "'draft' # unfinished", '"pending" # unfinished', "'pending'", '"\\u0064raft"', '"\\x64raft" # YAML escape'];
  for (const status of variants) {
    const f = await fixture(t);
    const bytes = `---\nstatus: ${status}\n---\n${review}`;
    await writeFile(join(f.config.wiki_root, monthly), bytes);
    assert.ok(['draft', 'pending'].includes(frontmatterScalar(Buffer.from(bytes), 'status')!));
    const service = createArchiveService(f.store, f.config, { now });
    assert.equal((await service.report('2026-07')).pages[0].status, 'pending', status);
    assert.equal((await service.run({ month: '2026-07', mode: 'apply' })).status, 'pending', status);
    assert.equal(await readFile(join(f.config.wiki_root, daily), 'utf8'), original);
    assert.equal((await f.store.listFileIntents()).length, 0);
  }
});
test('published quoted status and hash inside text are parsed without a prose quality gate', async t => {
  const f = await fixture(t);
  const bytes = `---\r\nstatus: 'published' # complete\r\n---\r\nOne sentence.\r\n`;
  assert.equal(frontmatterScalar(Buffer.from(bytes), 'status'), 'published');
  assert.equal(frontmatterScalar(Buffer.from('---\nstatus: "draft#literal" # comment\n---\n'), 'status'), 'draft#literal');
  assert.equal(frontmatterScalar(Buffer.from("---\nstatus: 'it''s published'\n---\n"), 'status'), "it's published");
  assert.equal(frontmatterScalar(Buffer.from('---\n"status" : "draft" # equivalent key\n---\n'), 'status'), 'draft');
  assert.equal(frontmatterScalar(Buffer.from("---\n'status' : pending\n---\n"), 'status'), 'pending');
  await writeFile(join(f.config.wiki_root, monthly), bytes);
  assert.equal((await createArchiveService(f.store, f.config, { now }).run({ month: '2026-07', mode: 'apply' })).status, 'complete');
  await assert.rejects(readFile(join(f.config.wiki_root, daily)), { code: 'ENOENT' });
});
