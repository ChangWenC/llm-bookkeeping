import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCli } from '../../src/cli.ts';
import { createStore } from '../../src/store/index.ts';
import { createPublisher } from '../../src/publish/index.ts';
import { config as base } from '../../test/fixtures/basic.ts';
import type { BookkeepingConfig, FactRevision, ReviewBundle } from '../../src/contracts/types.ts';
const cutoff = '2026-09-30T12:00:00Z';
const fact = (id: string): FactRevision => ({ schema_version: 1, fact_id: id, revision: 1, kind: 'fact', action: 'assert', target_refs: [], event_refs: [], subject: 'Roy', content: 'PRIVATE synthetic context ' + 'm'.repeat(900), occurred_at: { schema_version: 1, value: '2026-09-15T12:00:00Z', reason: null }, journal_date: { schema_version: 1, value: '2026-09-15', reason: null }, analytics_projection: { schema_version: 1, value: { schema_version: 1, summary: id + ' ' + 'p'.repeat(700), scope: ['project:a'], subject: 'Roy', event_refs: [], attribution: {} }, reason: null }, scope: ['personal', 'project:a'], attribution: {}, recorded_at: '2026-09-20T12:00:00Z', legacy_locator: null });

for (const kind of ['weekly', 'monthly'] as const) test(`CLI ${kind} fact pages retain frozen immutable refs across historical inserts and retractions`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'bookkeeping-frozen-pages-'));
  const config: BookkeepingConfig = { ...base, wiki_root: join(root, 'wiki'), data_dir: join(root, 'data'), providers: [], project_whitelist: ['a'], limits: { chunk_events: 80, chunk_body_bytes: 1024, bundle_bytes: 8192, bundles_per_round: 4 } };
  await mkdir(config.wiki_root);
  const configPath = join(root, 'config.json'); await writeFile(configPath, JSON.stringify(config));
  const store = await createStore(config);
  const cli = async (args: string[]) => { let out = '', err = ''; const code = await runCli([...args, '--config', configPath], { stdout: value => { out += value; }, stderr: value => { err += value; } }); assert.equal(code, 0, err); return JSON.parse(out); };
  const save = async (facts: FactRevision[], key: string) => { await store.importLegacy({ schema_version: 1, migration_key: key, facts, mappings: facts.map(item => ({ schema_version: 1, source_id: item.fact_id + ':' + item.revision, target_id: item.fact_id, confidence: 'verified', reason: null })), work: [] }); await createPublisher(store, config).exportFacts(); };
  try {
    const originals = Array.from({ length: 12 }, (_, index) => fact(`fact:frozen:${index}`));
    await save(originals, 'frozen-originals');
    const period = kind === 'weekly' ? '2026-09-20' : '2026-09';
    let next = 0, snapshot: string | null = null, count = 0;
    const seen: string[] = [];
    do {
      const output = join(root, 'page-' + count);
      const args = ['prepare', '--kind', kind, '--lane', 'history', '--period', period, '--cutoff', cutoff, '--output', output];
      if (snapshot) args.push('--fact-snapshot', snapshot, '--fact-offset', String(next));
      const manifest = await cli(args);
      assert.equal(manifest.cutoff, cutoff);
      const bytes = await readFile(join(output, manifest.bundles[0]));
      assert.ok(bytes.length <= config.limits.bundle_bytes);
      const bundle: ReviewBundle = JSON.parse(bytes.toString());
      const context = bundle.analysis_context ?? bundle.monthly_context!;
      const page = context.facts_page!;
      assert.ok(page, 'Every prepared evidence page exposes its frozen continuation');
      assert.equal(page.total, 12);
      assert.equal(page.cutoff, cutoff);
      if (snapshot) assert.equal(page.snapshot_id, snapshot);
      else snapshot = page.snapshot_id;
      const refs = kind === 'weekly' ? bundle.analysis_context!.facts.map(item => item.fact_ref) : bundle.monthly_context!.facts;
      assert.ok(refs.length > 0, 'Coverage metadata cannot crowd out every available fact');
      seen.push(...refs.map(item => `${item.fact_id}:${item.revision}`));
      if (kind === 'weekly') assert.ok(!bytes.toString().includes('PRIVATE'));
      next = page.next_offset ?? -1;
      if (count === 0) {
        await save([fact('fact:historical-late')], 'historical-insert');
        const retraction: FactRevision = { ...originals[11], revision: 2, action: 'retract', target_refs: [{ schema_version: 1, fact_id: originals[11].fact_id, revision: 1 }], recorded_at: '2026-09-29T12:00:00Z' };
        await save([retraction], 'historical-retraction');
      }
      count++;
      assert.ok(count <= 12, 'Bounded pagination makes progress');
    } while (next >= 0);
    assert.ok(count > 1);
    assert.deepEqual([...seen].sort(), originals.map(item => `${item.fact_id}:1`).sort());
    assert.equal(new Set(seen).size, 12);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
