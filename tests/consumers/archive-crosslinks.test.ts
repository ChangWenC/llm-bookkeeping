import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createStore } from '../../src/store/index.ts';
import { createArchiveService, readArchiveRecords } from '../../src/consumers/archive/index.ts';
import { config as base } from '../../test/fixtures/basic.ts';
import type { ArchiveOptions } from '../../src/consumers/archive/index.ts';
import { digestBytes } from '../../src/publish/files.ts';
const now = () => new Date('2026-10-01T12:00:00Z');
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'bookkeeping-crosslinks-'));
  const config = { ...base, wiki_root: join(root, 'wiki'), data_dir: join(root, 'data') };
  const dir = join(config.wiki_root, 'wiki/personal/journals'); await mkdir(join(dir, 'reviews'), { recursive: true });
  const originals = new Map([
    ['wiki/personal/journals/日记_2026_08_01.md', '# First\n完整A [[日记_2026_08_02|B原描述]]\n'],
    ['wiki/personal/journals/日记_2026_08_02.md', '# Second\n完整B [[日记_2026_08_01|A原描述]]\n'],
  ]);
  for (const [path, bytes] of originals) await writeFile(join(config.wiki_root, path), bytes);
  await writeFile(join(dir, 'reviews/回顾_2026_08.md'), '# August\n\n实质合成回顾正文。\n');
  const store = await createStore(config); t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  return { config, store, originals };
}
async function preserved(f: Awaited<ReturnType<typeof fixture>>) {
  const records = await readArchiveRecords(f.config);
  assert.equal(records.length, 2);
  for (const record of records) assert.equal(Buffer.from(String(record.record.original_bytes_base64), 'base64').toString(), f.originals.get(String(record.record.source_path)));
}
test('cross-linked daily pages preserve both pre-migration originals before any daily deletion', async t => {
  const f = await fixture(t);
  const result = await createArchiveService(f.store, f.config, { now }).run({ month: '2026-08', mode: 'apply' });
  assert.equal(result.status, 'complete', JSON.stringify(result)); await preserved(f);
  for (const path of f.originals.keys()) await assert.rejects(readFile(join(f.config.wiki_root, path)), { code: 'ENOENT' });
});
test('all snapshots before links and partial-link crashes resume with the same first original bytes', async t => {
  for (const stop of ['snapshots_saved', 'links_saved'] as const) {
    const f = await fixture(t); let once = true;
    const options: ArchiveOptions = { now, faultArchive(stage) { if (stage === stop && once) { once = false; throw new Error('Synthetic archive crash ' + stop); } } };
    try { await createArchiveService(f.store, f.config, options).run({ month: '2026-08', mode: 'apply' }); } catch (error) { assert.match(String(error), /Synthetic archive crash/); }
    await preserved(f);
    const resumed = await createArchiveService(f.store, f.config, { now }).run({ month: '2026-08', mode: 'apply' });
    assert.equal(resumed.status, 'complete', stop + ': ' + JSON.stringify(resumed));
    await preserved(f);
  }
});
test('manual changes after a legitimate cross-link mutation defer that source but preserve frozen originals', async t => {
  const f = await fixture(t), second = [...f.originals.keys()][1]; let once = true;
  const result = await createArchiveService(f.store, f.config, { now, async faultArchive(stage) {
    if (stage === 'links_saved' && once) { once = false; await writeFile(join(f.config.wiki_root, second), 'Human changed after approved backlink rewrite'); }
  } }).run({ month: '2026-08', mode: 'apply' });
  assert.ok(result.pages.some(page => page.path === second && page.status === 'pending'));
  assert.equal(await readFile(join(f.config.wiki_root, second), 'utf8'), 'Human changed after approved backlink rewrite');
  await preserved(f);
  const retried = await createArchiveService(f.store, f.config, { now }).run({ month: '2026-08', mode: 'apply' });
  assert.ok(retried.pages.some(page => page.path === second && page.status === 'pending'));
  await preserved(f);
});
test('one source preservation failure delays linked peers but allows an unrelated source to archive', async t => {
  const f = await fixture(t), second = [...f.originals.keys()][1], third = 'wiki/personal/journals/日记_2026_08_03.md';
  await writeFile(join(f.config.wiki_root, third), '# Independent\n完整独立第三篇。\n');
  const result = await createArchiveService(f.store, f.config, { now, fault(stage, operation) {
    if (stage === 'before_target' && operation.startsWith('archive-original:')) {
      const secondDigest = digestBytes(Buffer.from(f.originals.get(second)!));
      // Public operation identity is hash(path:original digest).
      const expected = createHash('sha256').update(second + ':' + secondDigest).digest('hex');
      if (operation === 'archive-original:' + expected) throw new Error('Synthetic second snapshot disk failure');
    }
  } }).run({ month: '2026-08', mode: 'apply' });
  assert.equal(result.status, 'partial');
  assert.equal(result.pages.find(page => page.path === third)?.status, 'applied');
  for (const path of f.originals.keys()) assert.equal(await readFile(join(f.config.wiki_root, path), 'utf8'), f.originals.get(path));
  assert.equal((await createArchiveService(f.store, f.config, { now }).run({ month: '2026-08', mode: 'apply' })).status, 'complete');
});
test('unrelated-month or inexact plan intent cannot authorize a changed daily deletion baseline', async t => {
  for (const mismatch of ['month', 'digest'] as const) {
    const f = await fixture(t), path = [...f.originals.keys()][1], bytes = Buffer.from('Arbitrary changed daily bytes');
    await assert.rejects(createArchiveService(f.store, f.config, { now, faultArchive(stage) { if (stage === 'snapshots_saved') throw new Error('Stop before links'); } }).run({ month: '2026-08', mode: 'apply' }), /Stop before links/);
    await f.store.saveFileIntent({ schema_version: 1, operation_id: 'archive-link:unrelated', path, baseline_digest: digestBytes(Buffer.from(f.originals.get(path)!)),
      desired_digest: digestBytes(bytes), desired_bytes_base64: bytes.toString('base64'), backup_bytes_base64: Buffer.from(f.originals.get(path)!).toString('base64'),
      state: 'applied', fact_refs: [], created_at: now().toISOString(), reason: null });
    await f.store.enqueueWork({ schema_version: 1, work_id: 'unrelated-plan', kind: 'archive_plan', lane: 'history', state: 'complete',
      payload: { month: mismatch === 'month' ? '2026-07' : '2026-08', path: 'unrelated.md', links: [{ path, digest: digestBytes(Buffer.from(f.originals.get(path)!)),
        desired_base64: mismatch === 'digest' ? Buffer.from('Wrong exact desired bytes').toString('base64') : bytes.toString('base64'), operation_id: 'archive-link:unrelated' }] },
      reason: null, migration_key: null, updated_at: now().toISOString() });
    await writeFile(join(f.config.wiki_root, path), bytes);
    const result = await createArchiveService(f.store, f.config, { now }).run({ month: '2026-08', mode: 'apply' });
    assert.ok(result.pages.some(page => page.path === path && page.status === 'pending'));
    assert.deepEqual(await readFile(join(f.config.wiki_root, path)), bytes);
  }
});
test('deletion registered and plan completed before snapshot completion resumes the retained frozen work', async t => {
  const f = await fixture(t), complete = f.store.completeWork.bind(f.store); let once = true;
  f.store.completeWork = async id => {
    if (once && id.startsWith('archive-snapshot:')) { once = false; throw new Error('Snapshot completion interruption'); }
    return complete(id);
  };
  const failed = await createArchiveService(f.store, f.config, { now }).run({ month: '2026-08', mode: 'apply' });
  assert.ok(failed.pages.some(page => page.status === 'pending'));
  assert.ok((await f.store.listWork('archive_snapshot', 'pending')).length);
  const result = await createArchiveService(f.store, f.config, { now }).run({ month: '2026-08', mode: 'apply' });
  assert.equal(result.status, 'complete');
  assert.equal((await f.store.listWork('archive_snapshot', 'pending')).length, 0);
  await preserved(f);
});
