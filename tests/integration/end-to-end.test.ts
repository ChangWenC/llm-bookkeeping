import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, rename, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { runCli } from '../../src/cli.ts';
import { createStore } from '../../src/store/index.ts';
import { createReviewer } from '../../src/review/index.ts';
import { createPublisher, acquireWikiLock } from '../../src/publish/index.ts';
import type { BookkeepingConfig, FactCandidate, ReviewBundle, ReviewResult } from '../../src/contracts/types.ts';

const cutoff = '2026-09-30T21:30:00.000Z';
const value = <T>(value: T) => ({ schema_version: 1 as const, value, reason: null });
const lines = (...records: unknown[]) => records.map(record => JSON.stringify(record) + '\n').join('');
const header = { timestamp: '2026-09-30T12:00:00Z', type: 'session_meta', payload: { id: 'synthetic-session', source: 'vscode', originator: 'Codex Desktop' } };
const user = (message: string, id?: string) => ({ timestamp: '2026-09-30T12:01:00Z', type: 'event_msg', payload: { type: 'user_message', message, ...(id ? { id } : {}) } });

async function fixture(records = lines(header, user('I verified the synthetic parser.', 'user:1'))) {
  const root = await mkdtemp(join(tmpdir(), 'bookkeeping-e2e-'));
  const config: BookkeepingConfig = {
    schema_version: 1, wiki_root: join(root, 'wiki'), data_dir: join(root, 'data'),
    journal_timezone: 'Europe/Amsterdam', analysis_timezone: 'Europe/Amsterdam',
    cutover_at: '2026-09-30T00:00:00Z', live_start: '2026-09-29T22:00:00Z',
    journal_timezone_timeline: [{ schema_version: 1, effective_from: '1970-01-01T00:00:00Z', timezone: 'Europe/Amsterdam', basis: 'synthetic fixture' }],
    providers: [{ schema_version: 1, provider: 'codex', account_id: 'account:synthetic', enabled: true, roots: [join(root, 'sources')], options: {} }],
    limits: { chunk_events: 80, chunk_body_bytes: 32768, bundle_bytes: 131072, bundles_per_round: 4 },
    project_whitelist: ['project:synthetic'], goal_whitelist: [],
  };
  await mkdir(config.wiki_root);
  await mkdir(config.providers[0].roots[0]);
  const source = join(config.providers[0].roots[0], 'session.jsonl');
  await writeFile(source, records, { mode: 0o600 });
  const configPath = join(root, 'config.json');
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  async function cli(args: string[], now = cutoff) {
    let stdout = '';
    let stderr = '';
    const code = await runCli([...args, '--config', configPath], {
      stdout: text => { stdout += text; }, stderr: text => { stderr += text; }, now: () => now,
    });
    return { code, json: JSON.parse(stdout), stderr };
  }
  async function prepare() {
    const directory = join(root, 'materials');
    const result = await cli(['prepare', '--kind', 'daily', '--lane', 'live', '--output', directory]);
    assert.equal(result.code, 0, result.stderr);
    const bundles: ReviewBundle[] = [];
    for (const name of result.json.bundles) bundles.push(JSON.parse(await readFile(join(directory, name), 'utf8')));
    return bundles;
  }
  return { root, config, source, configPath, cli, prepare };
}

function candidate(bundle: ReviewBundle, eventId = bundle.chunks[0].events[0].event_id): FactCandidate {
  const ref = { schema_version: 1 as const, event_id: eventId };
  return {
    schema_version: 1, candidate_id: 'candidate:synthetic', chunk_id: bundle.chunks[0].chunk_id,
    disposition: 'add', content: 'You verified the synthetic parser.', subject: 'Roy',
    occurred_at: value('2026-09-30T12:01:00.000Z'), journal_date: value('2026-09-30'), kind: 'fact',
    analytics_projection: value({ schema_version: 1, summary: 'Verified synthetic parser', scope: ['project:synthetic'], subject: 'Roy', event_refs: [ref], attribution: { responsibility: 'verification' } }),
    event_refs: [ref], target_refs: [], scope: ['project:synthetic'], attribution: { responsibility: 'verification' },
  };
}

function review(bundle: ReviewBundle, options: { partial?: boolean; page?: boolean } = {}): ReviewResult {
  const selected = candidate(bundle);
  return {
    schema_version: 1, result_id: `result:${bundle.bundle_id}`, bundle_id: bundle.bundle_id,
    chunks: bundle.chunks.map(chunk => ({
      schema_version: 1, chunk_id: chunk.chunk_id, status: options.partial ? 'partial' : 'complete',
      reviewed_event_ids: options.partial ? [selected.event_refs[0].event_id] : chunk.events.map(event => event.event_id),
      zero_facts: chunk.chunk_id !== selected.chunk_id, reason: options.partial ? 'Second source event remains unreviewed' : null,
    })),
    candidates: [selected],
    pages: options.page === false ? [] : [{
      schema_version: 1, suggestion_id: 'page:synthetic', date: '2026-09-30',
      path: bundle.baselines[0].path, baseline_digest: bundle.baselines[0].digest,
      mode: 'append', old_text: null, new_text: '- You verified the synthetic parser.\n', candidate_ids: [selected.candidate_id],
    }],
    created_at: cutoff,
  };
}

const factRange = { schema_version: 1 as const, from: '2026-09-30T00:00:00Z', to: '2026-10-01T00:00:00Z' };

test('real CLI → adapters → SQLite → review → export → journal, then recapture/restore with no source', async () => {
  const f = await fixture(lines(header, user('same'), {
    timestamp: '2026-09-30T12:01:00Z', type: 'response_item',
    payload: { type: 'message', role: 'user', id: 'user:mirror', content: [{ type: 'input_text', text: 'same' }] },
  }, user('same')));
  try {
    const collected = await f.cli(['collect', '--lane', 'live']);
    assert.equal(collected.code, 0, collected.stderr);
    const bundles = await f.prepare();
    const events = bundles.flatMap(bundle => bundle.chunks.flatMap(chunk => chunk.events));
    assert.equal(events.length, 2, 'Proved mirror deduplicates; real identical repetition survives');
    assert.equal(new Set(events.map(event => event.event_id)).size, 2);
    const preparedDirectory = join(f.root, 'materials');
    assert.equal((await stat(preparedDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(preparedDirectory, 'manifest.json'))).mode & 0o777, 0o600);
    const result = review(bundles[0]);
    const input = join(f.root, 'ReviewResult.json');
    await writeFile(input, JSON.stringify(result), { mode: 0o600 });
    const published = await f.cli(['publish', '--input', input]);
    assert.equal(published.code, 0, published.stderr);
    assert.equal(published.json.fact_commit, 'committed');
    assert.equal(published.json.export_status, 'ready');
    assert.equal(published.json.files[0].status, 'applied');
    const journal = join(f.config.wiki_root, result.pages[0].path);
    assert.equal(await readFile(journal, 'utf8'), result.pages[0].new_text);
    const repeated = await f.cli(['publish', '--input', input]);
    assert.equal(repeated.json.fact_commit, 'already_committed');
    assert.equal(await readFile(journal, 'utf8'), result.pages[0].new_text);
    assert.deepEqual(await f.prepare(), [], 'Accepted events are not fed to review again');
    assert.equal((await f.cli(['collect', '--lane', 'live'], '2026-09-30T21:31:00Z')).code, 0);
    assert.equal((await f.cli(['collect', '--lane', 'history'])).code, 0);
    const store = await createStore(f.config);
    try {
      assert.equal((await store.listEvents({ range: factRange })).length, 2);
      const outbox = await store.listOutbox('ready');
      assert.equal(outbox.length, 1);
      const exported = JSON.parse(await readFile(outbox[0].export_path!, 'utf8'));
      assert.equal(exported.facts.length, 1);
      assert.equal(exported.facts[0].analytics_projection.value.summary, 'Verified synthetic parser');
    } finally { store.close(); }
    await rm(f.config.providers[0].roots[0], { recursive: true });
    const facts = await f.cli(['facts', '--from', factRange.from, '--to', factRange.to]);
    assert.equal(facts.code, 0, facts.stderr);
    assert.equal(facts.json.facts.length, 1);
    const backup = await f.cli(['backup', '--output', join(f.root, 'backups')]);
    assert.equal(backup.code, 0, backup.stderr);
    const restoredDir = join(f.root, 'restored');
    const restored = await f.cli(['restore', '--input', backup.json.path, '--data-dir', restoredDir]);
    assert.equal(restored.code, 0, restored.stderr);
    const restoredStore = await createStore({ ...f.config, data_dir: restoredDir });
    try { assert.equal((await restoredStore.readEffectiveFacts({ range: factRange })).length, 1); }
    finally { restoredStore.close(); }
    assert.equal((await f.cli(['status'])).code, 0, 'Unavailable sources do not block status');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('empty database and 2GB source tail plus bad source publish today with durable partial coverage', async () => {
  const f = await fixture();
  try {
    const handle = await open(f.source, 'w');
    const size = 2 * 1024 * 1024 * 1024;
    await handle.write(lines(header), 0, 'utf8');
    await handle.truncate(size);
    const tail = Buffer.from('\n' + lines(user('today tail', 'today')));
    await handle.write(tail, 0, tail.length, size - tail.length);
    await handle.close();
    await writeFile(join(dirname(f.source), 'bad.jsonl'), '{malformed}\n');
    const collected = await f.cli(['collect', '--lane', 'live']);
    assert.equal(collected.code, 0, collected.stderr);
    assert.ok(collected.json.coverage.some((coverage: any) => coverage.capture_status !== 'complete'));
    const bundles = await f.prepare();
    assert.ok(bundles.some(bundle => bundle.unfinished.some(gap => gap.reason.includes('prefix'))));
    const input = join(f.root, 'ReviewResult.json');
    await writeFile(input, JSON.stringify(review(bundles[0])));
    const published = await f.cli(['publish', '--input', input]);
    assert.equal(published.code, 0, published.stderr);
    assert.equal(published.json.export_status, 'ready');
    assert.equal(published.json.files[0].status, 'applied');
    const store = await createStore(f.config);
    try {
      assert.equal((await store.readEffectiveFacts({ range: factRange })).length, 1);
      const coverage = (await store.listOutbox())[0].artifact.coverage;
      assert.ok(coverage.some(item => item.capture_status !== 'complete'));
    } finally { store.close(); }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('real semantic commit recovers before any FileIntent and retains partial reviewed work', async () => {
  const f = await fixture(lines(header, user('first', 'first'), user('second', 'second')));
  try {
    assert.equal((await f.cli(['collect', '--lane', 'live'])).code, 0);
    const bundle = (await f.prepare())[0];
    const store = await createStore(f.config);
    const result = review(bundle, { partial: true });
    const commit = await store.commitReview(result);
    assert.equal((await store.listFileIntents()).length, 0);
    assert.equal((await store.listPendingPatches()).length, 1);
    assert.equal((await store.listOutbox())[0].artifact.coverage[0].review_status, 'partial');
    store.close();
    const resumed = await f.cli(['publish', '--resume']);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.equal(resumed.json.export_status, 'ready');
    assert.equal(resumed.json.files[0].status, 'applied');
    const restarted = await createStore(f.config);
    try {
      assert.equal((await restarted.listPendingPatches()).length, 0);
      assert.equal((await restarted.readEffectiveFacts({ range: factRange }))[0].fact_id, commit.facts[0].fact_id);
      const remaining = await createReviewer(restarted, f.config).prepare({ kind: 'daily', lane: 'live', cutoff });
      assert.ok(remaining.flatMap(bundle => bundle.chunks.flatMap(chunk => chunk.events)).some(event => event.body === 'second'));
      assert.ok(!remaining.flatMap(bundle => bundle.chunks.flatMap(chunk => chunk.events)).some(event => event.body === 'first'));
    } finally { restarted.close(); }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('real SQLite preserves export while lock/conflict defer files and resumes immutable intent', async () => {
  const f = await fixture();
  try {
    await f.cli(['collect', '--lane', 'live']);
    const bundle = (await f.prepare())[0];
    const store = await createStore(f.config);
    const lock = await acquireWikiLock(f.config.wiki_root);
    assert.ok(lock);
    const publisher = createPublisher(store, f.config, { now: () => new Date(cutoff) });
    const initial = await publisher.publish(review(bundle));
    assert.equal(initial.export_status, 'ready');
    assert.equal(initial.files[0].status, 'pending');
    await lock.release();
    let injected = false;
    const interrupted = createPublisher(store, f.config, {
      now: () => new Date(cutoff),
      fault(stage) { if (stage === 'after_intent' && !injected) { injected = true; throw new Error('Synthetic interruption after durable intent'); } },
    });
    const result = await interrupted.resume();
    assert.equal(result.files[0].status, 'pending');
    const intent = (await store.listFileIntents())[0];
    assert.ok(intent.desired_bytes_base64);
    const path = join(f.config.wiki_root, review(bundle).pages[0].path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'Human change after intent\n');
    const conflict = await publisher.resume();
    assert.equal(conflict.files[0].status, 'conflict');
    assert.equal(conflict.export_status, 'ready');
    assert.equal(await readFile(path, 'utf8'), 'Human change after intent\n');
    assert.equal((await store.readEffectiveFacts({ range: factRange })).length, 1);
    assert.equal((await store.listFileIntents())[0].desired_bytes_base64, intent.desired_bytes_base64);
    store.close();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('relocated native source replay can persist identical immutable fragments through actual SQLite', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.cli(['collect', '--lane', 'live'])).code, 0);
    await rename(f.source, join(dirname(f.source), 'moved.jsonl'));
    const replayed = await f.cli(['replay', '--source', 'codex', '--from', factRange.from, '--to', factRange.to]);
    assert.equal(replayed.code, 0, replayed.stderr);
    const store = await createStore(f.config);
    try { assert.equal((await store.listEvents({ range: factRange })).length, 1); }
    finally { store.close(); }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('monthly review target is not a daily journal even when its date is outside retention window', async () => {
  const f = await fixture();
  try {
    const store = await createStore(f.config);
    const publisher = createPublisher(store, f.config, { now: () => new Date(cutoff) });
    // A persisted accepted monthly patch must be recovered independently of daily retention.
    const bundle: ReviewBundle = {
      schema_version: 1, bundle_id: 'bundle:monthly-target', kind: 'monthly', lane: 'history', period: '2026-01', cutoff,
      chunks: [{ schema_version: 1, chunk_id: 'chunk:monthly-target', events: [], context_events: [], body_bytes: 0 }],
      existing_facts: [], baselines: [{ schema_version: 1, path: 'wiki/personal/journals/reviews/回顾_2026_01.md', digest: 'absent', content: null }], coverage: [], unfinished: [],
    };
    await store.saveBundle(bundle);
    const result: ReviewResult = {
      schema_version: 1, result_id: 'result:monthly-target', bundle_id: bundle.bundle_id, created_at: cutoff,
      chunks: [{ schema_version: 1, chunk_id: bundle.chunks[0].chunk_id, status: 'complete', reviewed_event_ids: [], zero_facts: true, reason: null }], candidates: [],
      pages: [{ schema_version: 1, suggestion_id: 'page:monthly', date: '2026-01-31', path: bundle.baselines[0].path, baseline_digest: 'absent', mode: 'append', old_text: null, new_text: 'Synthetic monthly review\n', candidate_ids: [] }],
    };
    const published = await publisher.publish(result);
    assert.equal(published.files[0].status, 'applied');
    assert.equal(await readFile(join(f.config.wiki_root, bundle.baselines[0].path), 'utf8'), 'Synthetic monthly review\n');
    store.close();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('prepared actual bundle files use compact JSON within final configured bytes', async () => {
  const f = await fixture(lines(header, ...Array.from({ length: 70 }, (_, index) => user(`Work ${index}: ${'x'.repeat(300)}`, `message:${index}`))));
  try {
    assert.equal((await f.cli(['collect', '--lane', 'live'])).code, 0);
    const output = await f.cli(['prepare', '--kind', 'daily', '--lane', 'live', '--output', join(f.root, 'bounded')]);
    assert.equal(output.code, 0, output.stderr);
    assert.ok(output.json.bundles.length);
    for (const name of output.json.bundles) {
      const bytes = await readFile(join(f.root, 'bounded', name));
      assert.ok(bytes.length <= f.config.limits.bundle_bytes, `${bytes.length} > ${f.config.limits.bundle_bytes}`);
      assert.ok(!bytes.toString().includes('\n  "'), 'Material is serialized in compact form');
      assert.equal((await stat(join(f.root, 'bounded', name))).mode & 0o777, 0o600);
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
