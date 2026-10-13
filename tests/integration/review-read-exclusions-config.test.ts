import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { validateConfig, validateReviewReadExclusions, PERSONAL_DAILY_ROUND_LIMITS } from '../../src/config.ts';
import { InputError } from '../../src/contracts/validation.ts';
import { runDailyRound } from '../../src/daily-round.ts';
import { createStore } from '../../src/store/index.ts';
import { createReviewer } from '../../src/review/index.ts';
import { config as basic } from '../../test/fixtures/basic.ts';
import { config as fixtureConfig, event, collection } from '../store/fixtures.ts';
import type { ReviewReadExclusions, RuntimeServices } from '../../src/contracts/types.ts';
const entry = { schema_version: 1 as const, event_id: 'event:synthetic-protected', reason: 'Explicit private read restriction' };
const selection: ReviewReadExclusions = { schema_version: 1, events: [entry] };

test('private exact read config remains optional and versioned with bounded unique metadata', () => {
  assert.equal(validateConfig(basic).review_read_exclusions, undefined);
  assert.deepEqual(validateConfig({ ...basic, review_read_exclusions: selection }).review_read_exclusions, selection);
  validateReviewReadExclusions({ schema_version: 1, events: [] });
  validateReviewReadExclusions({ schema_version: 1, events: Array.from({ length: 100 }, (_, n) => ({ ...entry, event_id: `event:synthetic:${n}` })) });
  for (const invalid of [
    { schema_version: 2, events: [entry] }, { ...selection, provider: 'synthetic' },
    { schema_version: 1, events: [{ ...entry, conversation_id: 'synthetic' }] },
    { schema_version: 1, events: [entry, entry] },
    { schema_version: 1, events: Array.from({ length: 101 }, (_, n) => ({ ...entry, event_id: `event:${n}` })) },
    ...['event:*', 'event:?', 'event:[1]', 'event: white', 'event:bad\n', '', '界'.repeat(86)].map(event_id => ({ schema_version: 1, events: [{ ...entry, event_id }] })),
    ...['', 'bad\nreason', 'x'.repeat(513), '界'.repeat(171)].map(reason => ({ schema_version: 1, events: [{ ...entry, reason }] })),
  ]) assert.throws(() => validateReviewReadExclusions(invalid), InputError);
});

test('published exclusion schema has versioned DTO references and explicit structural bounds', async () => {
  const schema = JSON.parse(await readFile(new URL('../../schemas/contracts.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(schema.$defs.BookkeepingConfig.properties.review_read_exclusions, { $ref: '#/$defs/ReviewReadExclusions' });
  assert.equal(schema.$defs.ReviewReadExclusions.properties.events.maxItems, 100);
  assert.equal(schema.$defs.ReviewReadExclusion.additionalProperties, false);
  assert.equal(schema.$defs.ReviewReadExclusion.properties.event_id.maxLength, 256);
  assert.equal(schema.$defs.ReviewReadExclusion.properties.reason.maxLength, 512);
  assert.ok(schema.$defs.ReviewReadExclusionMetadata.properties.unreviewed);
});

test('daily active metadata guard precedes input parsing; expired round closes by metadata without reading active', async t => {
  const config = await fixtureConfig(), root = dirname(config.wiki_root), output = join(root, 'round');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(output, { mode: 0o700 });
  config.daily_round_limits = { ...PERSONAL_DAILY_ROUND_LIMITS };
  const store = await createStore(config), reviewer = createReviewer(store, config);
  t.after(() => store.close());
  await store.saveCollection({ ...collection([event(entry.event_id)], 'live'), coverage: [], checkpoints: [] });
  const services = { store, reviewer, publisher: { resume: async () => ({ schema_version: 1 }) }, consumers: [] } as unknown as RuntimeServices;
  const manifest = join(output, 'manifest.json');
  const hooks = { now: () => new Date('2026-10-06T12:00:00Z'), collect: async () => ({}) };
  const first = await runDailyRound({ manifest, output }, config, services, hooks);
  assert.equal(first.state, 'review');
  const original = await readFile(manifest, 'utf8');
  config.review_read_exclusions = selection;
  let guarded = 0;
  store.assertReviewBundleReadable = id => { assert.equal(id, first.active?.kind === 'source' ? first.active.bundle_id : ''); guarded++; throw new InputError('Synthetic metadata-only excluded bundle'); };
  const input = join(output, 'must-not-parse.json'); await writeFile(input, '{invalid JSON');
  await assert.rejects(runDailyRound({ manifest, output }, config, services, hooks), /metadata-only excluded/);
  await assert.rejects(runDailyRound({ manifest, output, input }, config, services, hooks), /metadata-only excluded/);
  const expired = await runDailyRound({ manifest, output }, config, services, { ...hooks, now: () => new Date('2026-10-06T15:00:00Z') });
  assert.equal(expired.state, 'deadline'); assert.equal(expired.terminal, true); assert.equal(guarded, 2);
  const before = JSON.parse(original).daily_round, after = JSON.parse(await readFile(manifest, 'utf8')).daily_round;
  for (const key of ['started_at', 'cutoff', 'started_bundles']) assert.deepEqual(after[key], before[key]);
  assert.equal(after.active.bundle_id, before.active.bundle_id); assert.equal(after.active.terminal_disposition, 'deferred_unreviewed');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM results').get()!.n, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM reviewed_sources').get()!.n, 0);
});
