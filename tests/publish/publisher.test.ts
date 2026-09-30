import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createPublisher, createSafeWikiWriter, acquireWikiLock, withWikiLock, digestBytes, wikiLockLocation } from '../../src/publish/index.ts';
import type { Store, FileIntent, WorkItem, JournalPatch, OutboxEntry, ReviewCommit, FileStatus, BookkeepingConfig } from '../../src/contracts/types.ts';
import { config as baseConfig, zeroReview } from '../../test/fixtures/basic.ts';

const fixedNow = () => new Date('2026-09-30T12:00:00Z');
class FakeStore {
  intents = new Map<string, FileIntent>();
  patches = new Map<string, JournalPatch>();
  statuses = new Map<string, FileStatus>();
  work = new Map<string, WorkItem>();
  outbox = new Map<string, OutboxEntry>();
  accepts = 0;
  constructor(patches: JournalPatch[] = []) { patches.forEach(patch => this.patches.set(patch.operation_id, patch)); }
  port(): Store { return this as unknown as Store; }
  async getFileIntent(id: string) { return structuredClone(this.intents.get(id) ?? null); }
  async saveFileIntent(intent: FileIntent) { assert.ok(!this.intents.has(intent.operation_id)); this.intents.set(intent.operation_id, structuredClone(intent)); }
  async listFileIntents(states?: FileIntent['state'][]) { return [...this.intents.values()].filter(intent => !states || states.includes(intent.state)).map(intent => structuredClone(intent)); }
  async updateFileIntent(id: string, state: FileIntent['state'], reason: string | null = null) { Object.assign(this.intents.get(id)!, { state, reason }); }
  async listPendingPatches() { return [...this.patches.values()].filter(patch => !['applied', 'noop'].includes(this.statuses.get(patch.operation_id) ?? 'pending')); }
  async markPatchStatus(id: string, status: FileStatus) { this.statuses.set(id, status); }
  async enqueueWork(work: WorkItem) { if (!this.work.has(work.work_id)) this.work.set(work.work_id, structuredClone(work)); }
  async listWork(kind?: string, state?: WorkItem['state']) { return [...this.work.values()].filter(item => (!kind || item.kind === kind) && (!state || item.state === state)); }
  async completeWork(id: string) { this.work.get(id)!.state = 'complete'; }
  async listOutbox(status?: OutboxEntry['status']) { return [...this.outbox.values()].filter(entry => !status || entry.status === status); }
  async markExportReady(id: string, export_path: string) { Object.assign(this.outbox.get(id)!, { status: 'ready', export_path }); }
  async listReadyBatches() { return [...this.outbox.values()].filter(entry => entry.status === 'ready').map(entry => entry.artifact); }
  async commitReview(): Promise<ReviewCommit> { const reused = this.accepts++ > 0; return { schema_version: 1, result_id: 'result:zero', batch_id: 'batch:zero', reused, facts: [], patches: [...this.patches.values()] }; }
  artifact(id = 'batch:zero') { this.outbox.set(id, { schema_version: 1, batch_id: id, status: 'pending', export_path: null,
    artifact: { schema_version: 1, batch_id: id, created_at: fixedNow().toISOString(), facts: [], coverage: [], affected_dates: ['2026-09-30'], affected_weeks: ['2026-10-04'] } }); }
}
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'new-bookkeeping-publish-'));
  const wiki = join(root, 'wiki'), data = join(root, 'data');
  await mkdir(wiki); await mkdir(data);
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const config = { ...baseConfig, wiki_root: wiki, data_dir: data } as BookkeepingConfig;
  return { root, wiki, data, config };
}
function patch(id: string, path = 'wiki/personal/2026-09-30.md', content = 'initial\n', text = 'synthetic entry\n'): JournalPatch {
  return { schema_version: 1, operation_id: id, date: '2026-09-30', path, baseline_digest: digestBytes(Buffer.from(content)), mode: 'append', old_text: null, new_text: text, fact_refs: [] };
}
async function seed(wiki: string, path: string, content: string) { await mkdir(join(wiki, path, '..'), { recursive: true }); await writeFile(join(wiki, path), content); }

test('rename-before-registration resumes without duplicate entry or re-review', async t => {
  const f = await fixture(t); const p = patch('op:rename'); await seed(f.wiki, p.path, 'initial\n');
  const store = new FakeStore([p]); store.artifact();
  const publisher = createPublisher(store.port(), f.config, { now: fixedNow, fault(stage) { if (stage === 'after_target') throw new Error('synthetic crash after rename'); } });
  const first = await publisher.publish(zeroReview as any);
  assert.equal(first.fact_commit, 'committed'); assert.equal(first.export_status, 'ready'); assert.equal(first.files[0].status, 'pending');
  assert.equal(store.intents.get(p.operation_id)?.backup_bytes_base64, Buffer.from('initial\n').toString('base64'));
  const resumed = await createPublisher(store.port(), f.config, { now: fixedNow }).resume();
  assert.equal(resumed.files[0].status, 'noop'); assert.equal(store.accepts, 1);
  assert.equal(await readFile(join(f.wiki, p.path), 'utf8'), 'initial\nsynthetic entry\n');
  assert.ok(store.work.has(`index:${p.operation_id}`));
});

test('accepted patch recovers crash before FileIntent, and multi-file failure does not block peers', async t => {
  const f = await fixture(t); const a = patch('op:a', 'a.md'), b = patch('op:b', 'b.md');
  await seed(f.wiki, a.path, 'initial\n'); await seed(f.wiki, b.path, 'initial\n');
  const store = new FakeStore([a, b]); store.artifact();
  const first = await createPublisher(store.port(), f.config, { now: fixedNow, fault(stage, operation) { if (stage === 'before_intent' && operation === a.operation_id) throw new Error('crash'); } }).publish(zeroReview as any);
  assert.deepEqual(first.files.map(file => file.status), ['pending', 'applied']); assert.equal(store.intents.has(a.operation_id), false);
  assert.equal(store.work.has(`index:${a.operation_id}`), false);
  const resumed = await createPublisher(store.port(), f.config, { now: fixedNow }).resume();
  assert.ok(resumed.files.some(file => file.operation_id === a.operation_id && file.status === 'applied'));
  assert.equal(store.accepts, 1); assert.equal(await readFile(join(f.wiki, b.path), 'utf8'), 'initial\nsynthetic entry\n');
});

test('applied registration interrupted before index queue is recovered even after manual edits', async t => {
  const f = await fixture(t); const p = patch('op:index'); await seed(f.wiki, p.path, 'initial\n');
  const store = new FakeStore([p]);
  await createPublisher(store.port(), f.config, { now: fixedNow, fault(stage) { if (stage === 'after_file_registered') throw new Error('crash'); } }).applyPatches([p]);
  assert.equal(store.intents.get(p.operation_id)?.state, 'applied'); assert.equal(store.work.has(`index:${p.operation_id}`), false);
  await writeFile(join(f.wiki, p.path), 'manual after success\n');
  await createPublisher(store.port(), f.config, { now: fixedNow }).resume();
  assert.equal(store.work.has(`index:${p.operation_id}`), true); assert.equal(await readFile(join(f.wiki, p.path), 'utf8'), 'manual after success\n');
});

test('append and exact local replacement preserve changed manual content; ambiguity conflicts', async t => {
  const f = await fixture(t); const append = patch('op:append', 'append.md'); await seed(f.wiki, append.path, 'manual preface\ninitial\n');
  const replace = { ...patch('op:replace', 'replace.md'), mode: 'replace' as const, old_text: 'old fragment', new_text: 'new fragment' };
  await seed(f.wiki, replace.path, 'manual preface\nold fragment\ncompleted todo\n');
  const ambiguous = { ...replace, operation_id: 'op:ambiguous', path: 'ambiguous.md' }; await seed(f.wiki, ambiguous.path, 'old fragment and old fragment\n');
  const store = new FakeStore([append, replace, ambiguous]);
  const result = await createPublisher(store.port(), f.config, { now: fixedNow }).applyPatches([append, replace, ambiguous]);
  assert.deepEqual(result.map(file => file.status), ['applied', 'applied', 'conflict']);
  assert.equal(await readFile(join(f.wiki, append.path), 'utf8'), 'manual preface\ninitial\nsynthetic entry\n');
  assert.equal(await readFile(join(f.wiki, replace.path), 'utf8'), 'manual preface\nnew fragment\ncompleted todo\n');
  assert.equal(store.work.has('index:op:ambiguous'), false); assert.equal((await store.listPendingPatches()).length, 1);
});

test('manual changes after durable intent remain conflict and keep complete desired/backup bytes', async t => {
  const f = await fixture(t); const p = patch('op:manual', 'manual.md'); await seed(f.wiki, p.path, 'initial\n');
  const store = new FakeStore([p]);
  const first = await createPublisher(store.port(), f.config, { now: fixedNow, async fault(stage) { if (stage === 'before_target') await writeFile(join(f.wiki, p.path), 'human concurrent edit\n'); } }).applyPatches([p]);
  assert.equal(first[0].status, 'conflict'); const intent = store.intents.get(p.operation_id)!;
  assert.equal(Buffer.from(intent.backup_bytes_base64!, 'base64').toString(), 'initial\n');
  assert.equal(Buffer.from(intent.desired_bytes_base64!, 'base64').toString(), 'initial\nsynthetic entry\n');
  const second = await createPublisher(store.port(), f.config, { now: fixedNow }).resume(); assert.equal(second.files[0].status, 'conflict');
  assert.equal(await readFile(join(f.wiki, p.path), 'utf8'), 'human concurrent edit\n'); assert.equal((await store.listPendingPatches()).length, 1);
});

test('creation and deletion recover explicit absent sentinels after target mutation', async t => {
  const f = await fixture(t); const store = new FakeStore();
  const writer = createSafeWikiWriter(store.port(), f.config, { now: fixedNow, fault(stage) { if (stage === 'after_target') throw new Error('crash'); } });
  const create = { operation_id: 'file:create', path: 'new/note.md', baseline_digest: 'absent', desired_bytes: Buffer.from('new bytes\n') };
  await assert.rejects(writer.write(create), /crash/);
  assert.equal(store.intents.get(create.operation_id)?.backup_bytes_base64, null);
  assert.equal((await createSafeWikiWriter(store.port(), f.config).write(create)).status, 'noop');
  const deletion = { operation_id: 'file:delete', path: create.path, baseline_digest: digestBytes(create.desired_bytes), desired_bytes: null };
  await assert.rejects(writer.write(deletion), /crash/);
  assert.equal(store.intents.get(deletion.operation_id)?.desired_digest, 'absent');
  assert.equal((await createSafeWikiWriter(store.port(), f.config).write(deletion)).status, 'noop');
  await assert.rejects(readFile(join(f.wiki, create.path)), { code: 'ENOENT' });
  assert.equal(store.work.has('index:file:delete'), true);
});

test('active lock delays files while facts and affected date/week/month consumer work export', async t => {
  const f = await fixture(t); const p = patch('op:busy'); await seed(f.wiki, p.path, 'initial\n');
  const store = new FakeStore([p]); store.artifact(); const lock = await acquireWikiLock(f.wiki); assert.ok(lock);
  try {
    assert.equal(await acquireWikiLock(f.wiki), null);
    const result = await createPublisher(store.port(), f.config, { now: fixedNow }).publish(zeroReview as any);
    assert.equal(result.export_status, 'ready'); assert.equal(result.files[0].status, 'pending');
    for (const kind of ['consumer', 'date', 'week', 'month']) assert.ok([...store.work.values()].some(work => work.kind === kind));
    assert.equal(store.work.has(`index:${p.operation_id}`), false);
  } finally { await lock.release(); }
  assert.equal((await createPublisher(store.port(), f.config, { now: fixedNow }).resume()).files[0].status, 'applied');
});

test('two writers share one lock and dead owner is reclaimed without TTL', async t => {
  const f = await fixture(t);
  const competing = await Promise.all([acquireWikiLock(f.wiki), acquireWikiLock(f.wiki)]);
  assert.equal(competing.filter(Boolean).length, 1); await competing.find(Boolean)!.release();
  const moduleUrl = new URL('../../src/publish/lock.ts', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { acquireWikiLock } from ${JSON.stringify(moduleUrl)}; const lock = await acquireWikiLock(${JSON.stringify(f.wiki)}); if (!lock) process.exit(2); process.exit(0);`], { stdio: ['ignore', 'pipe', 'pipe'] });
  const [code] = await once(child, 'exit'); assert.equal(code, 0);
  const reapers = await Promise.all([acquireWikiLock(f.wiki), acquireWikiLock(f.wiki)]);
  assert.equal(reapers.filter(Boolean).length, 1);
  assert.ok((await readdir(await wikiLockLocation(f.wiki))).some(name => name.startsWith('dead-')));
  await reapers.find(Boolean)!.release();
});

test('local immutable export interrupted after rename retries registration without overwrite', async t => {
  const f = await fixture(t); const store = new FakeStore(); store.artifact();
  const first = await createPublisher(store.port(), f.config, { fault(stage) { if (stage === 'after_export_rename') throw new Error('export crash'); } }).exportFacts();
  assert.deepEqual(first.pending, ['batch:zero']); assert.equal(store.outbox.get('batch:zero')!.status, 'pending');
  const second = await createPublisher(store.port(), f.config).exportFacts(); assert.deepEqual(second.ready, ['batch:zero']);
  assert.equal(store.work.get('export:batch:zero')?.state, 'complete');
  const path = store.outbox.get('batch:zero')!.export_path!, bytes = await readFile(path);
  store.outbox.get('batch:zero')!.artifact.created_at = '2026-09-30T13:00:00Z';
  assert.deepEqual((await createPublisher(store.port(), f.config).exportFacts()).pending, ['batch:zero']);
  assert.deepEqual(await readFile(path), bytes);
});

test('archived and window-excluded missing pages queue supplements while retained manual page allows local append', async t => {
  const f = await fixture(t); const archived = { ...patch('op:archived', 'archived.md', ''), date: '2026-09-15', baseline_digest: 'absent' };
  const old = { ...patch('op:old', 'old.md', ''), date: '2026-07-31', baseline_digest: 'absent' };
  const retained = { ...patch('op:retained', 'retained.md', ''), date: '2026-09-15' };
  await seed(f.wiki, retained.path, '---\nintentional-journal: true\n---\nhuman body\n');
  const archivePath = 'wiki/personal/_evidence/daily_journals/daily_2026.jsonl';
  await seed(f.wiki, archivePath, JSON.stringify({ schema_version: 'daily-journal-jsonl-v1', date: '2026-09-15', retention: 'archived' }) + '\n');
  const original = await readFile(join(f.wiki, archivePath)); const store = new FakeStore([archived, old, retained]);
  const result = await createPublisher(store.port(), f.config, { now: fixedNow }).applyPatches([archived, old, retained]);
  assert.deepEqual(result.map(file => file.status), ['noop', 'noop', 'applied']);
  assert.equal((await store.listWork('journal_supplement')).length, 2);
  for (const p of [archived, old]) await assert.rejects(readFile(join(f.wiki, p.path)), { code: 'ENOENT' });
  assert.deepEqual(await readFile(join(f.wiki, archivePath)), original);
});

test('retention reconstruction uses completed archive work and timezone timeline at frozen instant', async t => {
  const f = await fixture(t); const store = new FakeStore();
  store.work.set('archive:synthetic', { schema_version: 1, work_id: 'archive:synthetic', kind: 'archive', state: 'complete', lane: 'history', payload: { entries: [{ date: '2026-09-16' }] }, reason: null, migration_key: null, updated_at: fixedNow().toISOString() });
  const config = { ...f.config, journal_timezone_timeline: [{ schema_version: 1 as const, effective_from: '1970-01-01T00:00:00Z', timezone: 'Asia/Tokyo', basis: 'synthetic timeline' }] };
  const ps = [{ ...patch('op:from-work', 'work.md', ''), date: '2026-09-16', baseline_digest: 'absent' }, { ...patch('op:timeline', 'timeline.md', ''), date: '2026-08-15', baseline_digest: 'absent' }];
  const result = await createPublisher(store.port(), config, { now: () => new Date('2026-09-30T16:00:00Z') }).applyPatches(ps);
  assert.deepEqual(result.map(file => file.status), ['noop', 'noop']);
});

test('safe writes reject traversal, outside absolute, symlink escape, raw, immutable archives and released lock', async t => {
  const f = await fixture(t); const store = new FakeStore(); const writer = createSafeWikiWriter(store.port(), f.config);
  await symlink(f.data, join(f.wiki, 'escape')); await seed(f.wiki, 'raw/source.txt', 'raw original');
  await seed(f.wiki, 'wiki/personal/_evidence/daily_journals/daily_2026.jsonl', '{}\n');
  for (const path of ['../outside.md', join(f.data, 'outside.md'), 'escape/out.md', 'raw/source.txt', 'wiki/personal/_evidence/daily_journals/daily_2026.jsonl']) {
    await assert.rejects(writer.write({ operation_id: `bad:${path}`, path, baseline_digest: 'absent', desired_bytes: Buffer.from('unsafe') }));
  }
  const lock = await acquireWikiLock(f.wiki); assert.ok(lock); await lock.release();
  await assert.rejects(writer.writeLocked({ operation_id: 'bad:released', path: 'x.md', baseline_digest: 'absent', desired_bytes: Buffer.from('x') }, lock));
  assert.equal(await withWikiLock(f.wiki, async held => held.root), await (await import('node:fs/promises')).realpath(f.wiki));
});

test('old-content intent resumes, unchanged bytes do not queue index, and manual non-UTF8 bytes stay intact', async t => {
  const f = await fixture(t); const p = patch('op:old-content', 'old-content.md'); await seed(f.wiki, p.path, 'initial\n');
  const store = new FakeStore([p]);
  const first = await createPublisher(store.port(), f.config, { now: fixedNow, fault(stage) { if (stage === 'after_intent') throw new Error('crash after intent'); } }).applyPatches([p]);
  assert.equal(first[0].status, 'pending'); assert.equal(await readFile(join(f.wiki, p.path), 'utf8'), 'initial\n');
  assert.equal((await createPublisher(store.port(), f.config, { now: fixedNow }).resume()).files[0].status, 'applied');
  const writer = createSafeWikiWriter(store.port(), f.config);
  const unchanged = { operation_id: 'file:unchanged', path: p.path, baseline_digest: digestBytes(Buffer.from('initial\nsynthetic entry\n')), desired_bytes: Buffer.from('initial\nsynthetic entry\n') };
  assert.equal((await writer.write(unchanged)).status, 'noop'); assert.equal(store.work.has('index:file:unchanged'), false);
  const binary = Buffer.from([0xff, 0xfe, 0x0a, 0x41]); await writeFile(join(f.wiki, 'manual-bytes.md'), binary);
  const bytesPatch = { ...patch('op:bytes', 'manual-bytes.md', '', 'entry\n'), baseline_digest: digestBytes(binary) };
  assert.equal((await createPublisher(store.port(), f.config, { now: fixedNow }).applyPatches([bytesPatch]))[0].status, 'applied');
  assert.deepEqual(await readFile(join(f.wiki, 'manual-bytes.md')), Buffer.concat([binary, Buffer.from('\nentry\n')]));
});
