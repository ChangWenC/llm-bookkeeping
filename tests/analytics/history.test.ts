import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../src/store/index.ts';
import { getAnalyticsHistoryRepository } from '../../src/store/analytics.ts';
import { createAnalyticsHistoryPort } from '../../src/store/history.ts';
import { contentHash } from '../../src/analytics/model.ts';
import { config, collection, bundle, result } from '../store/fixtures.ts';
async function fixture() {
    const c = await config(), s = await createStore(c), b = bundle();
    await s.saveCollection(collection());
    await s.saveBundle(b);
    const r = result(b);
    r.pages = [];
    const commit = await s.commitReview(r);
    await s.markExportReady(commit.batch_id, c.data_dir + '/synthetic.json');
    const repo = getAnalyticsHistoryRepository(s);
    repo.ingest((await s.listReadyBatches('analytics'))[0], c);
    const observation = repo.observations()[0];
    const snapshot = { schema_version: 1 as const, analysis_ref: { schema_version: 1 as const, logical_id: 'week:2026-10-04', revision: 1 }, week_end: '2026-10-04', coverage_status: 'partial' as const, observations: [observation], capabilities: [], goal_gaps: [], direction: 'unknown' as const, patterns: [], validation_action: null };
    repo.saveAnalysis({ schema_version: 1, snapshot, prior_action_disposition: null, proposed_confirmations: [], freshness_at: '2026-10-05T00:00:00Z' }, 'synthetic-week');
    const event = { schema_version: 1 as const, review_id: 'legacy-confirm', target_ref: observation.observation_ref, action: 'confirm' as const, correction: null, evidence_refs: observation.evidence_refs, created_at: '2026-10-05T00:00:00Z' };
    const input = { schema_version: 1 as const, migration_key: 'legacy:1', records: [{ kind: 'review' as const, source_id: 'old-review', logical_id: 'legacy-confirm', revision: 1, content_hash: 'a'.repeat(64), professional_payload: event }], mappings: [{ source_id: 'old-review', target_ref: observation.observation_ref, weekly_ref: snapshot.analysis_ref, target_content_hash: contentHash(observation), weekly_content_hash: contentHash(snapshot), confidence: 'verified' as const, reason: null }] };
    return { c, s, repo, port: createAnalyticsHistoryPort(s, c), input, observation };
}
test('history confirmation compares both actual immutable targets, preserves history and is idempotent', async () => { const f = await fixture(); try {
    const bad = structuredClone(f.input);
    bad.migration_key = 'bad';
    bad.mappings[0].target_content_hash = 'b'.repeat(64);
    assert.equal((await f.port.importHistory(bad)).activated, 0);
    assert.equal(f.repo.confirmed(f.observation.observation_ref), false);
    const r = await f.port.importHistory(f.input);
    assert.equal(r.activated, 1);
    assert(f.repo.confirmed(f.observation.observation_ref));
    assert((await f.port.importHistory(f.input)).reused);
    assert.equal((await f.port.readHistory()).length, 2);
    await assert.rejects(f.port.importHistory({ ...f.input, records: [] }), /identity conflict/);
}
finally {
    f.s.close();
} });
test('failure retaining migration history rolls back exact revision confirmation in the same SQLite transaction', async () => { const f = await fixture(); try {
    f.s.db.exec("CREATE TRIGGER fail_history BEFORE INSERT ON analytics_legacy BEGIN SELECT RAISE(ABORT,'synthetic history failure'); END;");
    await assert.rejects(f.port.importHistory(f.input), /history failure/);
    assert.equal(f.repo.confirmed(f.observation.observation_ref), false);
    assert.equal(f.repo.reviews().length, 0);
    f.s.db.exec('DROP TRIGGER fail_history');
    assert.equal((await f.port.importHistory(f.input)).activated, 1);
}
finally {
    f.s.close();
} });
test('raw history payload is refused before mutation', async () => { const f = await fixture(); try {
    const bad = structuredClone(f.input);
    (bad.records[0].professional_payload as any).body = 'private';
    await assert.rejects(f.port.importHistory(bad), /Raw legacy/);
    assert.equal((await f.port.readHistory()).length, 0);
}
finally {
    f.s.close();
} });
