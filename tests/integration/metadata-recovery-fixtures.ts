import assert from 'node:assert/strict';
import type test from 'node:test';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { config as fixtureConfig, bundle } from '../store/fixtures.ts';
import { createStore } from '../../src/store/index.ts';
import { createPublisher } from '../../src/publish/index.ts';
import { SafeWikiWriter, digestBytes } from '../../src/publish/files.ts';

const fArtifact = (row: any) => JSON.parse(row.json);
const now = () => new Date('2026-10-02T16:00:00Z');
export async function metadataRecoveryFixture(t: test.TestContext) {
  const config = await fixtureConfig(); t.after(() => rm(dirname(config.wiki_root), { recursive: true, force: true }));
  const store = await createStore(config); t.after(() => store.close());
  const paths = ['2026_01', '2026_02'].map(month => `wiki/personal/journals/reviews/回顾_${month}.md`);
  const originals = paths.map((_, index) => Buffer.from(`---\ntype: monthly-review\n---\n# Synthetic month ${index}\n\nManual prose stays exact 🧪\n`));
  for (let i = 0; i < paths.length; i++) { await mkdir(dirname(join(config.wiki_root, paths[i])), { recursive: true }); await writeFile(join(config.wiki_root, paths[i]), originals[i]); }
  await writeFile(join(config.wiki_root, 'VERSION.md'), 'Synthetic version before\n');
  const writer = new SafeWikiWriter(store, config, { now });
  await writer.write({ operation_id: 'prior:synthetic-metadata', path: 'VERSION.md', baseline_digest: digestBytes(Buffer.from('Synthetic version before\n')), desired_bytes: Buffer.from('Synthetic version baseline\n') });
  const before = await store.backup(join(dirname(config.wiki_root), 'before'));
  const saved = bundle([], 'bundle:synthetic-bad-metadata');
  saved.coverage[0].query_range = { schema_version: 1, from: '2026-01-01T00:00:00Z', to: '2026-03-01T00:00:00Z' };
  saved.cutoff = now().toISOString(); saved.baselines = [{ schema_version: 1, path: 'VERSION.md', digest: digestBytes(Buffer.from('Synthetic version baseline\n')), content: 'Synthetic version baseline\n' }];
  await store.saveBundle(saved);
  const result = { schema_version: 1 as const, result_id: 'result:synthetic-bad-metadata', bundle_id: saved.bundle_id, chunks: [], candidates: [], pages: [{ schema_version: 1 as const, suggestion_id: 'suggestion:synthetic-version', date: '2026-10-02', path: 'VERSION.md', baseline_digest: saved.baselines[0].digest, mode: 'append' as const, old_text: null, new_text: 'Authorized metadata patch\n', candidate_ids: [] }], created_at: now().toISOString() };
  // Model an already-persisted pre-fix artifact; the corrected semantic commit must not reproduce this fanout.
  const accepted = await store.commitReview(result);
  const historic = fArtifact(store.db.prepare('SELECT json FROM outbox WHERE id=?').get(accepted.batch_id));
  historic.affected_dates = ['2026-01-01', '2026-02-01']; historic.affected_months = ['2026-01', '2026-02'];
  store.db.prepare('UPDATE outbox SET json=? WHERE id=?').run(JSON.stringify(historic), accepted.batch_id);
  const publisher = createPublisher(store, config, { now }); const published = await publisher.publish(result);
  assert.equal(published.export_status, 'ready'); assert.ok(published.batch_id);
  for (const path of paths) assert.match(await readFile(join(config.wiki_root, path), 'utf8'), /当前没有待展示的有效补记/);
  return { config, store, paths, originals, before: before.path, batchId: published.batch_id!, publisher };
}

