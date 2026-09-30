import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createStore } from '../../src/store/index.ts';
import { createArchiveService } from '../../src/consumers/archive/index.ts';
import { config as base } from '../../test/fixtures/basic.ts';
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'bookkeeping-archive-safety-'));
  const config = { ...base, wiki_root: join(root, 'wiki'), data_dir: join(root, 'data'), providers: [] };
  await mkdir(config.wiki_root);
  const store = await createStore(config);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const monthly = join(config.wiki_root, 'wiki/personal/journals/reviews/回顾_2026_07.md');
  await mkdir(dirname(monthly), { recursive: true }); await writeFile(monthly, '# 七月回顾\n\n已完成合成月回顾核对。\n');
  const daily = async (day: string, body: string) => { const path = join(config.wiki_root, `wiki/personal/journals/日记_2026_07_${day}.md`); await writeFile(path, body); return path; };
  return { config, store, monthly, daily };
}
test('canonical daily pinned and intentional journal_class preserves originals with ordinary tags', async t => {
  const f = await fixture(t);
  const pinned = await f.daily('15', '---\ntype: journal\njournal_class: pinned-daily\ntags: [journal]\n---\n\n合成长期保留原文。\n');
  const intentional = await f.daily('16', '---\ntype: journal\njournal_class: "intentional-journal"\ntags: [journal]\n---\n\n合成主动日记原文。\n');
  const nonDaily = [];
  for (const [day, classification] of [['17', 'monthly-review'], ['18', 'yearly-review'], ['19', 'unknown-topic']]) nonDaily.push(await f.daily(day, `---\ntype: journal\njournal_class: ${classification}\ntags: [journal]\n---\n\n显式非普通日记保持原样。\n`));
  const service = createArchiveService(f.store, f.config, { now: () => new Date('2026-09-30T12:00:00Z') });
  assert.ok((await service.report('2026-07')).pages.every(page => page.status === 'retained'));
  assert.ok((await service.run({ month: '2026-07', mode: 'apply' })).pages.every(page => page.status === 'retained'));
  await access(pinned); await access(intentional);
  for (const path of nonDaily) await access(path);
  assert.equal((await f.store.listWork('archive_plan')).length, 0);
});
test('a substantive human monthly review change before deletion defers only that archive source', async t => {
  const f = await fixture(t), daily = await f.daily('15', '# 合成日记\n\n完整原文不可丢失。\n');
  const service = createArchiveService(f.store, f.config, { now: () => new Date('2026-09-30T12:00:00Z'), async faultArchive(stage) {
    if (stage === 'before_delete') await writeFile(f.monthly, '# 七月回顾\n\n人工刚更正后的有效回顾，应保持并本轮延迟归档。\n');
  } });
  const result = await service.run({ month: '2026-07', mode: 'apply' });
  assert.equal(result.pages[0].status, 'pending'); assert.match(result.pages[0].reason!, /Monthly review changed/);
  assert.ok((await readFile(daily, 'utf8')).includes('完整原文'));
  const plan = (await f.store.listWork('archive_plan', 'pending'))[0];
  const archived = JSON.parse(await readFile(join(f.config.wiki_root, String(plan.payload.archive_path)), 'utf8'));
  assert.equal(Buffer.from(archived.original_bytes_base64, 'base64').toString(), await readFile(daily, 'utf8'));
});
test('authorized monthly backlink replacement uses its desired review digest and permits safe deletion', async t => {
  const f = await fixture(t), daily = await f.daily('15', '# 合成日记\n\n保存全文后可归档。\n');
  await writeFile(f.monthly, '# 七月回顾\n\n已核对[[日记_2026_07_15|当天合成工作]]。\n');
  const result = await createArchiveService(f.store, f.config, { now: () => new Date('2026-09-30T12:00:00Z') }).run({ month: '2026-07', mode: 'apply' });
  assert.equal(result.pages[0].status, 'applied', result.pages[0].reason!);
  await assert.rejects(access(daily), { code: 'ENOENT' });
  assert.ok((await readFile(f.monthly, 'utf8')).includes('[[回顾_2026_07|当天合成工作]]'));
});

test('ordinary daily-active and daily-reconstructed journal classes remain archivable', async t => {
  const f = await fixture(t);
  const active = await f.daily('20', '---\ntype: journal\njournal_class: daily-active\ntags: [journal]\n---\n\n合成普通日记。\n');
  const reconstructed = await f.daily('21', '---\ntype: journal\njournal_class: daily-reconstructed\ntags: [journal]\n---\n\n合成重建日记。\n');
  const service = createArchiveService(f.store, f.config, { now: () => new Date('2026-09-30T12:00:00Z') });
  assert.ok((await service.report('2026-07')).pages.every(page => page.status !== 'retained'));
  assert.ok((await service.run({ month: '2026-07', mode: 'apply' })).pages.every(page => page.status === 'applied'));
  await assert.rejects(access(active)); await assert.rejects(access(reconstructed));
});
