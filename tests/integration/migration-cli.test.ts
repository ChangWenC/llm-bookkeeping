import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runCli } from '../../src/cli.ts';
import { createStore } from '../../src/store/index.ts';
import { getAnalyticsHistoryRepository } from '../../src/store/analytics.ts';
import { createAnalyticsHistoryPort } from '../../src/store/history.ts';
import { contentHash } from '../../src/analytics/model.ts';
import { config, collection, bundle, result } from '../store/fixtures.ts';

test('CLI migration retains raw history and activates only exact current SQLite target/weekly hashes', async () => {
  const c = await config(), root = dirname(c.wiki_root);
  c.providers = [];
  c.journal_timezone_timeline = [{ schema_version: 1, effective_from: '1970-01-01T00:00:00Z', timezone: 'Europe/Amsterdam', basis: 'synthetic test' }];
  const configPath = join(root, 'config.json');
  await writeFile(configPath, JSON.stringify(c));
  const s = await createStore(c);
  try {
    const b = bundle();
    await s.saveCollection(collection()); await s.saveBundle(b);
    const r = result(b); r.pages = [];
    const committed = await s.commitReview(r);
    await s.markExportReady(committed.batch_id, join(root, 'synthetic-ready.json'));
    const repo = getAnalyticsHistoryRepository(s);
    const batch = (await s.listReadyBatches('analytics'))[0];
    repo.ingest(batch, c);
    const observation = repo.observations()[0];
    const snapshot = { schema_version: 1 as const, analysis_ref: { schema_version: 1 as const, logical_id: 'week:2026-10-04', revision: 1 }, week_end: '2026-10-04', coverage_status: 'partial' as const, observations: [observation], capabilities: [], goal_gaps: [], direction: 'unknown' as const, patterns: [], validation_action: null };
    repo.saveAnalysis({ schema_version: 1, snapshot, prior_action_disposition: null, proposed_confirmations: [], freshness_at: '2026-10-05T00:00:00Z' }, 'synthetic-week');
    const targetHash = contentHash(observation), weeklyHash = contentHash(snapshot);
    const migrate = async (id: string, hash: string) => {
      const raw = { schema_version: 'self-analytics-review-event-v1', id, weekly_id: 'old-week', weekly_revision: 1, weekly_content_hash: weeklyHash, target_id: 'old-observation', target_content_hash: hash, decision: 'confirm', reason: 'private synthetic history retained only in raw work', content_hash: 'a'.repeat(64) };
      const source = join(root, id + '.jsonl'); await writeFile(source, JSON.stringify(raw) + '\n');
      const manifest = { schema_version: 1, manifest_id: id, kind: 'migration', entries: [{ kind: 'analytics_review', format: 'jsonl', path: source, source_file_id: 'sealed:' + id, recorded_at: '2026-10-05T00:00:00Z', projections: [{ source_id: id, content_hash: raw.content_hash, professional_payload: { schema_version: 1, review_id: id, target_ref: observation.observation_ref, action: 'confirm', correction: null, evidence_refs: observation.evidence_refs, created_at: '2026-10-05T00:00:00Z' } }], mappings: [{ source_id: id, target_ref: observation.observation_ref, weekly_ref: snapshot.analysis_ref, target_content_hash: hash, weekly_content_hash: weeklyHash, confidence: 'verified', reason: null }] }] };
      const path = join(root, id + '-manifest.json'); await writeFile(path, JSON.stringify(manifest));
      let output = '', diagnostics = '';
      const code = await runCli(['migrate', '--manifest', path, '--config', configPath], { stdout: text => { output += text; }, stderr: text => { diagnostics += text; } });
      assert.equal(code, 0, diagnostics);
      return JSON.parse(output);
    };
    await migrate('wrong-hash', 'b'.repeat(64));
    assert.equal(repo.confirmed(observation.observation_ref), false);
    await migrate('exact-hash', targetHash);
    assert.equal(repo.confirmed(observation.observation_ref), true);
    await migrate('exact-hash', targetHash);
    assert.equal(repo.reviews().length, 1, 'Repeated manifest must not double-apply the confirmation');
    const revised = structuredClone(batch);
    revised.batch_id = 'synthetic-revision-two';
    revised.facts[0].revision = 2;
    revised.facts[0].action = 'replace';
    revised.facts[0].target_refs = [{ schema_version: 1, fact_id: batch.facts[0].fact_id, revision: 1 }];
    repo.ingest(revised, c);
    assert.equal(repo.confirmed(observation.observation_ref), false);
    await migrate('stale-target', targetHash);
    assert.equal(repo.reviews().length, 1, 'Old exact content hash must not transfer confirmation to a superseded target');
    const history = await createAnalyticsHistoryPort(s, c).readHistory();
    assert.equal(history.length, 3);
    assert.ok(!JSON.stringify(history).includes('private synthetic history'));
    assert.equal((await s.listWork('legacy_analytics_history')).length, 3);
    assert.ok((await s.listWork('needs_review', 'pending')).length >= 2);
  } finally { s.close(); await rm(root, { recursive: true, force: true }); }
});

test('CLI migration budget retains a large old state object whole and numeric epoch requires no source zone', async () => {
  const c = await config(), root = dirname(c.wiki_root);
  c.providers = [];
  c.journal_timezone_timeline = [{ schema_version: 1, effective_from: '1970-01-01T00:00:00Z', timezone: 'Europe/Amsterdam', basis: 'synthetic test' }];
  c.migration_limits = { max_record_bytes: 512 * 1024 };
  const state = join(root, 'state.json'), source = join(root, 'epoch.jsonl');
  await writeFile(state, JSON.stringify({ synthetic_state: 'x'.repeat(355 * 1024) }));
  await writeFile(source, JSON.stringify({ id: 'epoch-id', sender_wxid: 'self', create_time: 1790769600, message_content: 'synthetic epoch' }) + '\n');
  const entry = { kind: 'pending_state', format: 'json', category: 'needs_review', path: state, source_file_id: 'sealed:large-state', recorded_at: '2026-09-30T12:00:00Z' };
  const configPath = join(root, 'config.json'), manifestPath = join(root, 'manifest.json');
  await writeFile(configPath, JSON.stringify(c));
  const cli = async (command: string, manifest: unknown) => {
    await writeFile(manifestPath, JSON.stringify(manifest));
    let out = '', err = '';
    const code = await runCli([command, '--manifest', manifestPath, '--config', configPath], { stdout: text => { out += text; }, stderr: text => { err += text; } });
    assert.equal(code, 0, err); return JSON.parse(out);
  };
  try {
    const migrated = await cli('migrate', { schema_version: 1, manifest_id: 'state', kind: 'migration', entries: [entry] });
    assert.equal(migrated.entries[0].records, 1);
    const imported = await cli('import', { schema_version: 1, manifest_id: 'epoch', kind: 'import', entries: [{ kind: 'chat_export', format: 'legacy-jsonl', path: source, source_file_id: 'sealed:epoch', recorded_at: entry.recorded_at, account_id: 'self', owner_id: 'self', conversation_id: 'chat', identity_verified: true, time_source: 'create_time', source_timezone: null, known_range: { schema_version: 1, from: '2026-09-30T00:00:00Z', to: '2026-10-01T00:00:00Z' } }] });
    assert.ok(!imported.entries[0].pending.includes('source_timezone_unknown'));
    const store = await createStore(c);
    try { assert.equal((await store.listWork('needs_review'))[0].payload.legacy_payload.synthetic_state.length, 355 * 1024); assert.equal((await store.status()).events, 1); }
    finally { store.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
