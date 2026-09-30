import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runCli } from '../../src/cli.ts';
import { createStore } from '../../src/store/index.ts';
import { config, result, range } from '../store/fixtures.ts';
import type { ReviewBundle } from '../../src/contracts/types.ts';

test('actual CLI source recapture queues explicit semantic replay and publishes a correction once after process restart', async t => {
    const c = await config(), root = dirname(c.wiki_root), sources = join(root, 'sources');
    await mkdir(sources); c.providers = [{ schema_version: 1, provider: 'codex', enabled: true, roots: [sources], account_id: 'synthetic', options: {} }];
    c.journal_timezone_timeline = [{ schema_version: 1, effective_from: '1970-01-01T00:00:00Z', timezone: 'Europe/Amsterdam', basis: 'Synthetic fixture' }];
    await writeFile(join(sources, 'session.jsonl'), [
        { type: 'session_meta', payload: { id: 'synthetic-replay-session', source: 'user' } },
        { type: 'response_item', timestamp: '2026-09-30T09:00:00Z', payload: { type: 'message', id: 'human-request', role: 'user', content: [{ type: 'input_text', text: 'Synthetic verification request.' }], internal_chat_message_metadata_passthrough: { turn_id: 'human-turn' } } },
    ].map(row => JSON.stringify(row) + '\n').join(''));
    const configPath = join(root, 'config.json'); await writeFile(configPath, JSON.stringify(c));
    t.after(() => rm(root, { recursive: true, force: true }));
    let clock = range.to, sequence = 0;
    const cli = async (args: string[]) => {
        let out = '', err = ''; const code = await runCli([...args, '--config', configPath], { now: () => clock, stdout: text => { out += text; }, stderr: text => { err += text; } });
        assert.equal(code, 0, err); return JSON.parse(out);
    };
    const prepare = async (extra: string[] = []): Promise<{ manifest: any; material: ReviewBundle[] }> => {
        const dir = join(root, 'material-' + ++sequence), manifest = await cli(['prepare', '--kind', 'daily', '--lane', 'history', '--output', dir, ...extra]);
        return { manifest, material: await Promise.all(manifest.bundles.map((file: string) => readFile(join(dir, file), 'utf8').then(JSON.parse))) };
    };
    const publish = async (semantic: ReturnType<typeof result>) => {
        const path = join(root, 'result-' + ++sequence + '.json'); await writeFile(path, JSON.stringify(semantic)); return cli(['publish', '--input', path]);
    };
    await cli(['collect', '--lane', 'live']);
    // The source event has live lane only until replay recaptures history, so use
    // ordinary live preparation for initial acceptance.
    const initialDir = join(root, 'initial'), initial = await cli(['prepare', '--kind', 'daily', '--lane', 'live', '--output', initialDir]);
    const originalBundle: ReviewBundle = JSON.parse(await readFile(join(initialDir, initial.bundles[0]), 'utf8'));
    const first = result(originalBundle, 'initial-source-result'); first.pages = []; const firstPublish = await publish(first);
    const replayArgs = ['replay', '--source', 'codex', '--from', range.from, '--to', range.to];
    const requested = await cli(replayArgs); assert.equal(requested.review_state, 'pending');
    assert.equal((await prepare()).material.length, 0);
    clock = '2026-10-02T12:00:00Z'; const retry = await cli(replayArgs); assert.equal(retry.replay_id, requested.replay_id); assert.equal(retry.cutoff, requested.cutoff);
    const { manifest, material } = await prepare(['--replay-id', requested.replay_id]);
    assert.equal(manifest.cutoff, requested.cutoff); assert.equal(material[0].chunks[0].events[0].event_id, originalBundle.chunks[0].events[0].event_id);
    const correction = result(material[0], 'source-replay-correction'); correction.pages = []; correction.created_at = clock;
    correction.candidates[0].disposition = 'replace'; correction.candidates[0].content = 'Synthetic corrected interpretation.';
    correction.candidates[0].target_refs = material[0].existing_facts.map(f => ({ schema_version: 1, fact_id: f.fact_id, revision: f.revision }));
    const changed = await publish(correction), reused = await publish(correction);
    assert.notEqual(changed.batch_id, firstPublish.batch_id); assert.equal(reused.fact_commit, 'already_committed');
    const store = await createStore(c);
    assert.equal((await store.getSemanticReplay(requested.replay_id))!.state, 'complete');
    const effective = await store.readEffectiveFacts({ range }); assert.equal(effective.length, 1); assert.equal(effective[0].revision, 2);
    assert.equal(effective[0].fact_id, material[0].existing_facts[0].fact_id);
    store.close();
    assert.equal((await prepare(['--replay-id', requested.replay_id])).material.length, 0);
    assert.equal((await cli(replayArgs)).review_state, 'complete');
    // Source disappearance must not block explicit re-review of cached original
    // events, nor reopen an already completed stable job.
    await rm(sources, { recursive: true, force: true });
    const unavailable = await cli([...replayArgs, '--replay-key', 'offline-cached-review']);
    assert.equal(unavailable.review_state, 'pending');
    assert(unavailable.recapture.every((item: any) => item.capture_status !== 'complete'));
    const offline = await prepare(['--replay-id', unavailable.replay_id]);
    assert.equal(offline.material[0].chunks[0].events[0].event_id, originalBundle.chunks[0].events[0].event_id);
    assert.equal(offline.material[0].existing_facts[0].revision, 2);
    const offlineStore = await createStore(c);
    assert((await offlineStore.listCoverage(range)).some(item => item.capture_status !== 'complete' && item.gaps.length > 0));
    offlineStore.close();
    const completedOffline = await cli(replayArgs);
    assert.equal(completedOffline.review_state, 'complete');
    assert.equal(completedOffline.cutoff, requested.cutoff);
});
