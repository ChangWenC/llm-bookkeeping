import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { readGoalPageBaselines } from '../../src/review/goals.ts';
import { config } from '../store/fixtures.ts';

test('goal material reads only exact whitelist pages with full digest and shared bounded UTF-8 excerpts', async () => {
  const c = await config(), root = dirname(c.wiki_root);
  const path = 'wiki/personal/plans/规划_synthetic.md';
  const body = '显式目标上下文。\n' + '职业'.repeat(10000) + '\n全文尾部。';
  c.goal_whitelist = [path, path];
  try {
    await mkdir(dirname(join(c.wiki_root, path)), { recursive: true }); await writeFile(join(c.wiki_root, path), body);
    await writeFile(join(c.wiki_root, 'wiki/personal/plans/规划_unlisted.md'), 'PRIVATE_UNLISTED_DO_NOT_READ');
    const { baselines, gaps } = await readGoalPageBaselines(c, 2048);
    assert.equal(baselines.length, 1); assert.equal(baselines[0].path, path);
    assert.equal(baselines[0].digest, createHash('sha256').update(body).digest('hex'));
    assert.equal(baselines[0].context_excerpt, true); assert.ok(!baselines[0].content!.includes('全文尾部'));
    assert.ok(!baselines[0].content!.includes('\uFFFD')); assert.ok(Buffer.byteLength(JSON.stringify(baselines)) <= 2048);
    assert.ok(gaps.some(item => item.locator === path && item.reason.includes('full goal page')));
    assert.ok(!JSON.stringify({ baselines, gaps }).includes('PRIVATE_UNLISTED_DO_NOT_READ'));
    assert.ok(!('confirmed' in baselines[0]), 'Page evidence never becomes a confirmed contract');
    c.limits.bundle_bytes = 600000;
    const full = await readGoalPageBaselines(c);
    assert.equal(full.baselines[0].content, body); assert.equal(full.gaps.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('invalid, raw, traversal, symlink and missing goal targets remain local gaps beside a readable exact page', async () => {
  const c = await config(), root = dirname(c.wiki_root), good = 'wiki/personal/plans/规划_good.md';
  try {
    await mkdir(dirname(join(c.wiki_root, good)), { recursive: true }); await writeFile(join(c.wiki_root, good), '明确合成目标。');
    const outside = join(root, 'outside.md'); await writeFile(outside, 'PRIVATE_OUTSIDE');
    const link = 'wiki/personal/plans/规划_symlink.md'; await symlink(outside, join(c.wiki_root, link));
    c.goal_whitelist = [good, 'goal:abstract-id', 'raw/private.md', 'wiki/../outside.md', link, 'wiki/personal/plans/规划_missing.md'];
    const result = await readGoalPageBaselines(c);
    assert.equal(result.baselines.find(page => page.path === good)?.content, '明确合成目标。');
    assert.equal(result.baselines.find(page => page.path.endsWith('规划_missing.md'))?.digest, 'absent');
    assert.equal(result.gaps.length, 5);
    assert.ok(!JSON.stringify(result).includes('PRIVATE_OUTSIDE'));
    assert.equal((await readGoalPageBaselines(c, 64)).baselines.length, 0);
    await assert.rejects(readGoalPageBaselines(c, -1), /budget/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
