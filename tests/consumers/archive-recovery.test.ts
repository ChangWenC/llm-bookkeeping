import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStore } from '../../src/store/index.ts';
import { createArchiveService, readArchiveRecords } from '../../src/consumers/archive/index.ts';
import { createPublisher } from '../../src/publish/index.ts';
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
