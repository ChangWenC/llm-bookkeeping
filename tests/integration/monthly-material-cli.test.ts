import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runCli } from '../../src/cli.ts';
import { createStore } from '../../src/store/index.ts';
import { config, result } from '../store/fixtures.ts';
import type { ReviewBundle } from '../../src/contracts/types.ts';

const cutoff = '2026-09-30T12:00:00Z';
test('actual monthly CLI accumulates explicit original daily material across zero-fact pages without allocating facts', async () => {
  const c = await config(), root = dirname(c.wiki_root), configPath = join(root, 'config.json');
  c.providers = [];
  c.journal_timezone_timeline = [{ schema_version: 1, effective_from: '1970-01-01T00:00:00Z', timezone: 'Europe/Amsterdam', basis: 'synthetic fixture' }];
  await writeFile(configPath, JSON.stringify(c));
  const store = await createStore(c);
  const cli = async (args: string[]) => {
    let out = '', err = '';
    const code = await runCli([...args, '--config', configPath], { stdout: value => { out += value; }, stderr: value => { err += value; } });
    assert.equal(code, 0, err); return JSON.parse(out);
  };
  try {
    const prepared: ReviewBundle[] = [];
    for (let index = 0; index < 2; index++) {
      const path = `wiki/personal/journals/日记_2026_08_${index ? '02' : '01'}.md`;
      const body = `---\ntype: journal\njournal_class: daily-reconstructed\n---\n\n第${index + 1}批未结构化的合成原文，仅供月回顾核对。\n`;
      await mkdir(dirname(join(c.wiki_root, path)), { recursive: true });
      await writeFile(join(c.wiki_root, path), body);
      const manifest = join(root, `pages-${index}.json`);
      await writeFile(manifest, JSON.stringify({ schema_version: 1, paths: [path] }));
      const output = join(root, `material-${index}`);
      const response = await cli(['prepare', '--kind', 'monthly', '--lane', 'history', '--period', '2026-08', '--cutoff', cutoff, '--pages', manifest, '--output', output]);
      const bundle: ReviewBundle = JSON.parse(await readFile(join(output, response.bundles[0]), 'utf8'));
      assert.deepEqual(bundle.monthly_context!.facts, []);
      assert.equal(bundle.monthly_context!.manual_baselines.find(page => page.path === path)?.content, body);
      assert.equal(bundle.monthly_context!.coverage_status, 'unknown');
      prepared.push(bundle);
    }
    for (let index = 0; index < prepared.length; index++) {
      const review = result(prepared[index], `monthly-original-page-${index}`, false);
      review.monthly_review = { schema_version: 1, month: '2026-08', summary: `已核对第${index + 1}批原文。`, supplement_text: '', fact_refs: [], coverage_status: 'unknown' };
      const input = join(root, `review-${index}.json`);
      await writeFile(input, JSON.stringify(review));
      await cli(['publish', '--input', input]);
    }
    const monthly = await readFile(join(c.wiki_root, 'wiki/personal/journals/reviews/回顾_2026_08.md'), 'utf8');
    assert.match(monthly, /已核对第1批原文/); assert.match(monthly, /已核对第2批原文/);
    assert.equal((await store.readEffectiveFacts({ range: prepared[0].monthly_context!.range })).length, 0);
    assert.equal((await cli(['validate', '--scope', 'all'])).status, 'valid');
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('actual CLI archive originals resume bounded material, reject excerpt acknowledgement and complete only fully reviewed frozen work', async () => {
  const c = await config(), root = dirname(c.wiki_root), configPath = join(root, 'config.json');
  c.providers = [];
  c.limits.bundle_bytes = 8192; c.limits.chunk_body_bytes = 1024;
  c.journal_timezone_timeline = [{ schema_version: 1, effective_from: '1970-01-01T00:00:00Z', timezone: 'Europe/Amsterdam', basis: 'synthetic fixture' }];
  await writeFile(configPath, JSON.stringify(c));
  const store = await createStore(c);
  const cli = async (args: string[], expected = 0) => {
    let out = '', err = '';
    const code = await runCli([...args, '--config', configPath], { stdout: value => { out += value; }, stderr: value => { err += value; } });
    assert.equal(code, expected, err); return code === 0 ? JSON.parse(out) : err;
  };
  const original = '# 完整合成旧日记\n\n' + 'x'.repeat(7000) + '\n原文尾部不可丢失。\n';
  const day = 'wiki/personal/journals/日记_2026_07_15.md', month = 'wiki/personal/journals/reviews/回顾_2026_07.md';
  const fullCutoff = '2026-10-05T00:00:00Z';
  const prepare = async (directory: string, snapshot?: string): Promise<ReviewBundle> => {
    const output = join(root, directory);
    const args = ['prepare', '--kind', 'monthly', '--lane', 'history', '--period', '2026-07', '--cutoff', fullCutoff, '--archive-context-offset', '0', '--output', output];
    if (snapshot) args.push('--fact-snapshot', snapshot);
    const manifest = await cli(args);
    const bytes = await readFile(join(output, manifest.bundles[0]));
    assert.ok(bytes.length <= c.limits.bundle_bytes);
    return JSON.parse(bytes.toString());
  };
  try {
    await mkdir(dirname(join(c.wiki_root, month)), { recursive: true });
    await writeFile(join(c.wiki_root, month), '# 七月回顾\n\n已有人工月回顾全文应保留。\n');
    await writeFile(join(c.wiki_root, day), original);
    const archive = await cli(['archive', '--month', '2026-07', '--apply']);
    assert.equal(archive.pages[0].status, 'applied', archive.pages[0].reason);
    await assert.rejects(readFile(join(c.wiki_root, day)), { code: 'ENOENT' });
    const pending = (await store.listWork('archive_context', 'pending'))[0];
    const excerpt = await prepare('archive-excerpt');
    const material = excerpt.monthly_context!.archive_contexts![0];
    assert.equal(material.work_id, pending.work_id);
    assert.ok(material.excerpt_reason?.includes('limits.bundle_bytes'));
    assert.ok(!material.content_excerpt.includes('原文尾部'));
    const rejected = result(excerpt, 'excerpt-invalid-completion', false);
    rejected.monthly_review = { schema_version: 1, month: '2026-07', summary: '仅见前段，尚未完整核对。', supplement_text: '', fact_refs: [], coverage_status: 'partial', completed_archive_context_ids: [pending.work_id] };
    const rejectedPath = join(root, 'rejected.json'); await writeFile(rejectedPath, JSON.stringify(rejected));
    assert.match(await cli(['publish', '--input', rejectedPath], 1), /fully displayed/);
    assert.equal((await store.listWork('archive_context', 'pending')).length, 1);
    // Work captured after the first prepare remains unread even if it claims an old timestamp.
    await store.enqueueWork({ ...pending, work_id: 'late-unread-original', updated_at: '2026-09-29T12:00:00Z' });
    c.limits.bundle_bytes = 40000; await writeFile(configPath, JSON.stringify(c));
    const full = await prepare('archive-full', excerpt.monthly_context!.facts_page!.snapshot_id);
    assert.equal(full.monthly_context!.archive_context_page!.total, 1);
    assert.equal(full.monthly_context!.archive_contexts![0].content_excerpt, original);
    assert.equal(full.monthly_context!.archive_contexts![0].excerpt_reason, null);
    const review = result(full, 'archive-full-accepted', false);
    review.monthly_review = { schema_version: 1, month: '2026-07', summary: '已完整核对合成日记及其尾部。', supplement_text: '', fact_refs: [], coverage_status: 'partial', completed_archive_context_ids: [pending.work_id] };
    const input = join(root, 'archive-reviewed.json'); await writeFile(input, JSON.stringify(review));
    await cli(['publish', '--input', input]);
    assert.deepEqual((await store.listWork('archive_context', 'pending')).map(work => work.work_id), ['late-unread-original']);
    const body = await readFile(join(c.wiki_root, month), 'utf8');
    assert.match(body, /已有人工月回顾全文应保留/); assert.match(body, /已完整核对合成日记及其尾部/);
    assert.equal((await store.readEffectiveFacts({ range: full.monthly_context!.range })).length, 0);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
