import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileAdapter } from '../../src/adapters/files.ts';
import { hash } from '../../src/adapters/common.ts';
import { config as defaults } from '../../test/fixtures/basic.ts';
import type { AdapterContext, BookkeepingConfig, CollectionBatch, CollectRequest, SourceCheckpoint } from '../../src/contracts/types.ts';
const request: CollectRequest = { lane: 'live', cutoff: '2026-10-01T00:00:00Z', range: { schema_version: 1, from: '2026-09-30T00:00:00Z', to: '2026-10-01T00:00:00Z' }, budget: { max_duration_ms: 10000, max_bytes: 1024 * 1024, max_directory_entries: 100 } };
const header = { type: 'session_meta', timestamp: '2026-09-30T12:00:00Z', payload: { id: 'synthetic-generation-session', source: 'vscode', originator: 'Codex Desktop' } };
const user = (body: string, id = 'stable-native-message') => ({ type: 'event_msg', timestamp: '2026-09-30T12:01:00Z', payload: { type: 'user_message', message: body, id } });
const text = (body: string) => JSON.stringify(header) + '\n' + JSON.stringify(user(body)) + '\n';
const events = (batches: CollectionBatch[]) => batches.flatMap(batch => batch.events);
const checkpoints = (batches: CollectionBatch[]) => batches.flatMap(batch => batch.checkpoints);
async function collect(config: BookkeepingConfig, req: CollectRequest, context: Omit<AdapterContext, 'config'>) {
  const batches: CollectionBatch[] = [];
  for await (const batch of new FileAdapter(config.providers[0], config).collect(req, { config, ...context })) batches.push(batch);
  return batches;
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'bookkeeping-generation-witness-')), sources = join(root, 'sources');
  await mkdir(sources); await mkdir(join(root, 'wiki')); t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(sources, 'source.jsonl'), config: BookkeepingConfig = { ...defaults, wiki_root: join(root, 'wiki'), data_dir: join(root, 'data'), providers: [{ schema_version: 1, provider: 'codex', account_id: 'synthetic-account', enabled: true, roots: [sources], options: {} }] };
  await writeFile(file, text('anonymous long initial content '.repeat(20)));
  const first = await collect(config, request, { checkpoints: [] });
  await writeFile(file, text('anonymous revised content'));
  const normal = await collect(config, request, { checkpoints: checkpoints(first) });
  const witness = checkpoints(normal).find(checkpoint => checkpoint.locator === file)!;
  assert.notEqual(witness.generation, '0');
  return { file, config, normal, witness };
}
test('fresh scoped history reuses a proven nonzero normal generation without borrowing normal progress or parser state', async t => {
  const f = await fixture(t), before = JSON.stringify(checkpoints(f.normal));
  const poisoned: SourceCheckpoint = { ...f.witness, cursor: { ...f.witness.cursor,
    history_end: 0, pending_line_base64: Buffer.from('not a source row\n').toString('base64'), pending_line_start: 0,
    parse_state: { codex_turn_origin: { classification: 'automation', turn_id: 'synthetic-poison' } },
    recent_event_ids: events(f.normal).map(event => event.event_id),
  } };
  const scoped = await collect(f.config, { ...request, lane: 'history' }, { checkpoints: [], generation_checkpoints: [poisoned, ...checkpoints(f.normal).filter(c => c.locator === '@discovery')] });
  assert.equal(events(scoped).length, 1, 'normal EOF and history_end zero cannot suppress independent scope scan');
  assert.equal(events(scoped)[0].event_id, events(f.normal)[0].event_id);
  assert.equal(events(scoped)[0].generation, f.witness.generation);
  assert.equal(events(scoped)[0].classification, 'main');
  assert(!scoped.flatMap(b => b.coverage).flatMap(c => c.gaps).some(gap => gap.reason.startsWith('malformed_line')));
  assert.equal(JSON.stringify(checkpoints(f.normal)), before);
});
test('scope append retains proven generation and reads appended native IDs independently of normal EOF progress', async t => {
  const f = await fixture(t), before = JSON.stringify(f.witness);
  await appendFile(f.file, JSON.stringify(user('anonymous appended content', 'append-native-message')) + '\n');
  const scoped = await collect(f.config, { ...request, lane: 'history' }, { checkpoints: [], generation_checkpoints: [f.witness] });
  assert.deepEqual(events(scoped).map(e => e.source.message_id), ['stable-native-message', 'append-native-message']);
  assert(events(scoped).every(event => event.generation === f.witness.generation));
  assert.equal(events(scoped)[0].event_id, events(f.normal)[0].event_id);
  assert.equal(JSON.stringify(f.witness), before);
});
test('changed witness source starts the same new generation as normal capture and reports rewrite uncertainty honestly', async t => {
  const f = await fixture(t);
  await writeFile(f.file, text('anonymous changed content'));
  const scoped = await collect(f.config, { ...request, lane: 'history' }, { checkpoints: [], generation_checkpoints: [f.witness] });
  const normal = await collect(f.config, request, { checkpoints: checkpoints(f.normal) });
  assert.equal(events(scoped).length, 1); assert.equal(events(normal).length, 1);
  assert.notEqual(events(scoped)[0].generation, f.witness.generation);
  assert.equal(events(scoped)[0].event_id, events(normal)[0].event_id);
  assert(scoped.flatMap(b => b.coverage).some(coverage => coverage.capture_status === 'partial' && coverage.gaps.some(gap => gap.reason === 'source_truncated_or_rewritten_new_generation')));
});
test('legacy empty or missing witness anchor remains partial without falsely creating a generation or normal completion', async t => {
  const f = await fixture(t);
  for (const anchor of [hash(Buffer.alloc(0)), null]) {
    const witness: SourceCheckpoint = { ...f.witness, cursor: { ...f.witness.cursor, anchor } };
    delete witness.cursor.anchor_length;
    const scoped = await collect(f.config, { ...request, lane: 'history' }, { checkpoints: [], generation_checkpoints: [witness] });
    assert.equal(events(scoped)[0].generation, f.witness.generation);
    assert(scoped.flatMap(b => b.coverage).some(coverage => coverage.capture_status === 'partial' && coverage.gaps.some(gap => gap.reason.includes('anchor_unproven'))));
    assert(!scoped.flatMap(b => b.coverage).flatMap(c => c.gaps).some(gap => gap.reason === 'source_truncated_or_rewritten_new_generation'));
  }
});
test('malformed generation witness metadata leaves the scoped file unread and retryable rather than assigning generation zero', async t => {
  const f = await fixture(t);
  const witness: SourceCheckpoint = { ...f.witness, cursor: { ...f.witness.cursor, header_hash: 'invalid-digest' } };
  const scoped = await collect(f.config, { ...request, lane: 'history' }, { checkpoints: [], generation_checkpoints: [witness] });
  assert.deepEqual(events(scoped), []);
  assert(!checkpoints(scoped).some(checkpoint => checkpoint.locator === f.file));
  assert(scoped.flatMap(b => b.coverage).some(coverage => coverage.capture_status === 'partial' && coverage.gaps.some(gap => gap.reason === 'generation_witness_metadata_invalid')));
  assert((checkpoints(scoped).find(checkpoint => checkpoint.locator === '@discovery')!.cursor.files as string[]).includes(f.file));
});
test('exact file witness takes precedence over a newer different locator sharing the same session identity', async t => {
  const f = await fixture(t);
  const alias: SourceCheckpoint = { ...f.witness, locator: join(f.config.providers[0].roots[0], 'other-copy.jsonl'), generation: 'different-copy-generation', updated_at: '2026-10-02T00:00:00Z' };
  const scoped = await collect(f.config, { ...request, lane: 'history' }, { checkpoints: [], generation_checkpoints: [alias, f.witness] });
  assert.equal(events(scoped)[0].event_id, events(f.normal)[0].event_id);
  assert.equal(events(scoped)[0].generation, f.witness.generation);
});
test('witness anchor budget gap persists across scoped checkpoint continuation instead of silently becoming complete', async t => {
  const f = await fixture(t), small = { ...request, lane: 'history' as const, budget: { ...request.budget, max_bytes: Buffer.byteLength(text('anonymous revised content')) } };
  const first = await collect(f.config, small, { checkpoints: [], generation_checkpoints: [f.witness] });
  assert.deepEqual(events(first), []);
  const checkpoint = checkpoints(first).find(checkpoint => checkpoint.locator === f.file)!;
  assert.equal((checkpoint.cursor.anchor_uncertainty as { reason: string }).reason, 'generation_witness_anchor_budget_pending');
  const next = await collect(f.config, { ...request, lane: 'history' }, { checkpoints: checkpoints(first), generation_checkpoints: [f.witness] });
  assert.equal(events(next)[0].event_id, events(f.normal)[0].event_id);
  assert(next.flatMap(batch => batch.coverage).some(coverage => coverage.capture_status === 'partial' && coverage.gaps.some(gap => gap.reason.includes('generation_witness_anchor_budget_pending'))));
});
