import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createStore } from '../../src/store/index.ts';
import { createIndexConsumer, runPublicCommand, PUBLIC_OUTPUT_LIMIT_BYTES, type CommandResult } from '../../src/consumers/index/index.ts';
import { sha } from '../../src/consumers/archive/records.ts';
import { config as base } from '../../test/fixtures/basic.ts';
import type { BookkeepingConfig } from '../../src/contracts/types.ts';
const path = 'wiki/personal/journals/日记_2026_10_11.md';
const now = () => new Date('2026-10-11T12:00:00Z');
const diagnostic = { level: 'Error', code: 'E197', path, message: 'Invalid full-v2 archive record' };
function value(extra: Record<string, unknown> = {}) { return { report_contract_version: 1, capabilities: ['daily-journal-archive-target-v2'], counts: { pages: 1, errors: 0, warnings: 0, suggestions: 0 }, disabled_checks: [], errors: [], generated_at: now().toISOString(), suggestions: [], synthesis_candidates: [], tag_source_report: [], warnings: [], ...extra }; }
const report = (extra: Record<string, unknown> = {}) => JSON.stringify(value(extra));
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'bookkeeping-index-contract-')), wiki = join(root, 'wiki');
  await mkdir(dirname(join(wiki, path)), { recursive: true }); await writeFile(join(wiki, path), '# Synthetic journal\n');
  const config = { ...base, wiki_root: wiki, data_dir: join(root, 'data') } as BookkeepingConfig;
  const store = await createStore(config, { now });
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  await store.enqueueWork({ schema_version: 1, work_id: 'index:synthetic', kind: 'index', lane: 'live', state: 'pending', payload: { path }, reason: null, migration_key: null, updated_at: now().toISOString() });
  const stages: string[] = [];
  const run = (lint: CommandResult, qmdExit = 0, commands = { lint: { executable: 'lint', args: [] as string[] }, build_index: { executable: 'build', args: [] as string[] }, qmd: { executable: 'qmd', args: [] as string[] } }) => createIndexConsumer(store, config, { now, commands, async runner(command) { stages.push(command.executable); return command.executable === commands.lint.executable ? lint : { exit_code: command.executable === 'qmd' ? qmdExit : 0, stdout: '', stderr: '' }; } }).consume();
  return { root, wiki, store, config, stages, run };
}
test('supported full-v2 report tolerates informational additions and passes known warnings', async t => {
  const f = await fixture(t), stdout = report({ extra_information: { text: 'x'.repeat(100_000) }, counts: { pages: 1, errors: 0, warnings: 1, suggestions: 1 }, warnings: [{ ...diagnostic, code: 'W101', level: 'Warning' }], suggestions: [{ ...diagnostic, code: 'S101', level: 'Suggestion' }] });
  assert.equal((await f.run({ exit_code: 0, stdout, stderr: 'synthetic diagnostic' })).status, 'complete'); assert.deepEqual(f.stages, ['lint', 'build', 'qmd']);
  const audit = (await f.store.listWork('index_diagnostic')).find(work => work.payload.stage === 'lint')!;
  assert.equal(audit.payload.stdout, stdout); assert.equal(audit.payload.stderr, 'synthetic diagnostic'); assert.equal(audit.payload.exit_code, 0);
});
for (const [name, stdout] of Object.entries({ unknownMajor: report({ report_contract_version: 2 }), missingCapability: report({ capabilities: [] }), legacy: report({ report_contract_version: undefined }), missingFields: '{}', truncated: '{"errors":[', malformedV2: report({ errors: [diagnostic], counts: { pages: 1, errors: 1, warnings: 0, suggestions: 0 } }), mixed: report({ errors: [diagnostic, { ...diagnostic, code: 'E101' }], counts: { pages: 1, errors: 2, warnings: 0, suggestions: 0 } }), severity: report({ warnings: [{ ...diagnostic, level: 'Unknown' }], counts: { pages: 1, errors: 0, warnings: 1, suggestions: 0 } }), counts: report({ counts: { pages: 1, errors: 1, warnings: 0, suggestions: 0 } }), malformedDiagnostic: report({ errors: [{ level: 'Error', code: 'unknown' }], counts: { pages: 1, errors: 1, warnings: 0, suggestions: 0 } }) })) {
  test(`lint ${name} fails closed before downstream stages`, async t => { const f = await fixture(t); assert.equal((await f.run({ exit_code: 0, stdout, stderr: '' })).status, 'pending'); assert.deepEqual(f.stages, ['lint']); assert.equal((await f.store.listWork('index', 'pending')).length, 1); });
}
test('old annual E197 nonzero failure has no compatibility override', async t => {
  const f = await fixture(t), stdout = report({ errors: [{ ...diagnostic, message: 'archive_target must be wiki/personal/_evidence/daily_journals/daily_2026.jsonl, found none' }], counts: { pages: 1, errors: 1, warnings: 0, suggestions: 0 } });
  assert.equal((await f.run({ exit_code: 1, stdout, stderr: 'real exit' })).status, 'pending'); const audit = (await f.store.listWork('index_diagnostic'))[0]; assert.equal(audit.payload.exit_code, 1); assert.equal(audit.payload.stdout, stdout);
});
test('custom exit zero without the report is insufficient', async t => { const f = await fixture(t); assert.equal((await f.run({ exit_code: 0, stdout: '', stderr: '' })).status, 'pending'); });
test('every pending attempt reruns lint, ignores old unversioned cache and binds downstream identity', async t => {
  const f = await fixture(t);
  for (const stage of ['lint', 'build_index']) await f.store.enqueueWork({ schema_version: 1, work_id: `index-stage:${sha(JSON.stringify(['index:synthetic']))}:${stage}`, kind: 'index_stage', lane: 'live', state: 'complete', payload: { stage, work_ids: ['index:synthetic'] }, reason: null, migration_key: null, updated_at: now().toISOString() });
  assert.equal((await f.run({ exit_code: 0, stdout: report(), stderr: '' }, 1)).status, 'partial');
  assert.equal((await f.run({ exit_code: 0, stdout: report({ capabilities: [] }), stderr: '' })).status, 'pending');
  assert.deepEqual(f.stages, ['lint', 'build', 'qmd', 'lint']);
  assert.equal((await f.run({ exit_code: 0, stdout: report(), stderr: '' })).status, 'complete'); assert.deepEqual(f.stages.slice(-2), ['lint', 'qmd']);
});
test('validator/helper upgrade after build passed and qmd failed reruns lint and downstream build', async t => {
  const f = await fixture(t); await mkdir(join(f.wiki, 'scripts')); const helper = join(f.wiki, 'scripts/daily-journal-archive-target.mjs'); await writeFile(helper, '// validator version one');
  assert.equal((await f.run({ exit_code: 0, stdout: report(), stderr: '' }, 1)).status, 'partial'); await writeFile(helper, '// validator version two');
  assert.equal((await f.run({ exit_code: 0, stdout: report(), stderr: '' })).status, 'complete'); assert.deepEqual(f.stages, ['lint', 'build', 'qmd', 'lint', 'build', 'qmd']);
});
test('command changes invalidate downstream completion cache', async t => {
  const f = await fixture(t); assert.equal((await f.run({ exit_code: 0, stdout: report(), stderr: '' }, 1)).status, 'partial');
  const commands = { lint: { executable: 'lint', args: [] }, build_index: { executable: 'build-v2', args: [] }, qmd: { executable: 'qmd', args: [] } };
  assert.equal((await f.run({ exit_code: 0, stdout: report(), stderr: '' }, 0, commands)).status, 'complete'); assert.deepEqual(f.stages, ['lint', 'build', 'qmd', 'lint', 'build-v2', 'qmd']);
});
test('relevant input change invalidates build cache', async t => {
  const f = await fixture(t); assert.equal((await f.run({ exit_code: 0, stdout: report(), stderr: '' }, 1)).status, 'partial'); await writeFile(join(f.wiki, path), '# Changed synthetic journal\n');
  assert.equal((await f.run({ exit_code: 0, stdout: report(), stderr: '' })).status, 'complete'); assert.deepEqual(f.stages, ['lint', 'build', 'qmd', 'lint', 'build', 'qmd']);
});
test('over 8MiB output or explicit truncation retains pending', async t => {
  for (const output of [{ exit_code: 0, stdout: 'x'.repeat(PUBLIC_OUTPUT_LIMIT_BYTES + 1), stderr: '' }, { exit_code: 0, stdout: report(), stderr: '', output_limit_exceeded: true }]) { const f = await fixture(t); assert.equal((await f.run(output)).status, 'pending'); assert.deepEqual(f.stages, ['lint']); }
});
test('real runner preserves complete UTF8 beyond 64KiB and stops overflow', async t => {
  const f = await fixture(t), expected = '合成'.repeat(30_000);
  const valid = await runPublicCommand({ executable: process.execPath, args: ['-e', 'process.stdout.write("合成".repeat(30000))'] }, { wiki_root: f.wiki, paths: [] }); assert.equal(valid.stdout, expected);
  const overflow = await runPublicCommand({ executable: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(9*1024*1024));setInterval(()=>{},1000)'], timeout_ms: 5000 }, { wiki_root: f.wiki, paths: [] }); assert.equal(overflow.output_limit_exceeded, true);
});
test('configured Wiki lint gains JSON without changing other arguments', async t => {
  const f = await fixture(t), seen: string[][] = [];
  const consumer = createIndexConsumer(f.store, f.config, { commands: { lint: { executable: process.execPath, args: ['scripts/lint.mjs', '--quiet'] }, build_index: { executable: 'build', args: [] }, qmd: { executable: 'qmd', args: [] } }, async runner(command) { seen.push(command.args); return { exit_code: 0, stdout: command.args.includes('--json') ? report() : '', stderr: '' }; } });
  assert.equal((await consumer.consume()).status, 'complete'); assert.deepEqual(seen[0], ['scripts/lint.mjs', '--quiet', '--json']);
});
