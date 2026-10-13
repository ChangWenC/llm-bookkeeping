import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCli } from '../../src/cli.ts';
import { createStore } from '../../src/store/index.ts';
import { createSafeWikiWriter } from '../../src/publish/index.ts';
import type { BookkeepingConfig } from '../../src/contracts/types.ts';

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'bookkeeping-consumer-cli-'));
  const config: BookkeepingConfig = {
    schema_version: 1, wiki_root: join(root, 'wiki'), data_dir: join(root, 'data'),
    journal_timezone: 'Europe/Amsterdam', analysis_timezone: 'Europe/Amsterdam',
    cutover_at: '2026-09-30T00:00:00Z', live_start: '2026-09-29T22:00:00Z',
    journal_timezone_timeline: [{ schema_version: 1, effective_from: '1970-01-01T00:00:00Z', timezone: 'Europe/Amsterdam', basis: 'synthetic fixture' }],
    providers: [], limits: { chunk_events: 80, chunk_body_bytes: 32768, bundle_bytes: 131072, bundles_per_round: 4 },
    project_whitelist: [], goal_whitelist: [],
    index_commands: {
      schema_version: 1,
      lint: { schema_version: 1, executable: process.execPath, args: ['-e', 'console.log(JSON.stringify({report_contract_version:1,capabilities:["daily-journal-archive-target-v2"],generated_at:"2026-10-13T10:00:00Z",counts:{pages:1,errors:0,warnings:0,suggestions:0},errors:[],warnings:[],suggestions:[],disabled_checks:[],tag_source_report:{},synthesis_candidates:[]}))'] },
      build_index: { schema_version: 1, executable: process.execPath, args: ['-e', 'require("node:fs").writeFileSync("index-proof.txt","built")'] },
      qmd: { schema_version: 1, executable: process.execPath, args: ['-e', 'process.exitCode=1'] },
    },
  };
  await mkdir(config.wiki_root);
  const path = join(root, 'config.json');
  await writeFile(path, JSON.stringify(config));
  const cli = async (args: string[]) => {
    let output = '', diagnostics = '';
    const code = await runCli([...args, '--config', path], { stdout: text => { output += text; }, stderr: text => { diagnostics += text; } });
    return { code, json: JSON.parse(output), diagnostics };
  };
  return { root, config, path, cli };
}

test('monthly and archive CLI reach actual SQLite consumers without source initialization', async () => {
  const f = await setup();
  try {
    const monthly = await f.cli(['consume', '--target', 'monthly']);
    assert.equal(monthly.code, 0, monthly.diagnostics);
    assert.equal(monthly.json.consumers[0].target, 'monthly');
    const report = await f.cli(['archive', '--month', '2026-01', '--report']);
    assert.equal(report.code, 0, report.diagnostics);
    const apply = await f.cli(['archive', '--month', '2026-01', '--apply']);
    assert.equal(apply.code, 0, apply.diagnostics);
    const store = await createStore(f.config);
    try { assert.equal((await store.status()).facts, 0); } finally { store.close(); }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('index CLI executes configured public commands and leaves qmd failure pending without changing facts', async () => {
  const f = await setup();
  try {
    const store = await createStore(f.config);
    try {
      const writer = createSafeWikiWriter(store, f.config);
      assert.equal((await writer.write({ operation_id: 'operation:index-fixture', path: 'project.md', baseline_digest: 'absent', desired_bytes: Buffer.from('Synthetic manual project page\n') })).status, 'applied');
    } finally { store.close(); }
    const index = await f.cli(['consume', '--target', 'index']);
    assert.equal(index.code, 0, index.diagnostics);
    assert.equal(index.json.consumers[0].status, 'partial');
    assert.match(index.json.consumers[0].reason, /qmd/);
    assert.equal(await readFile(join(f.config.wiki_root, 'index-proof.txt'), 'utf8'), 'built');
    const restarted = await createStore(f.config);
    try {
      assert.equal((await restarted.listWork('index', 'pending')).length, 1);
      assert.equal((await restarted.listWork('index_failure', 'pending')).length, 1);
      assert.equal((await restarted.status()).facts, 0);
    } finally { restarted.close(); }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
