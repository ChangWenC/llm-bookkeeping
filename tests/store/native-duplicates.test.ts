import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createStore } from '../../src/store/index.ts';
import { createPublisher } from '../../src/publish/index.ts';
import { previewNativeDuplicates, prepareNativeDuplicates, type NativeDuplicateManifest } from '../../src/store/native-duplicates.ts';
import { config, event, collection, bundle, result, range } from './fixtures.ts';
import type { SourceEvent } from '../../src/contracts/types.ts';

function twins(id: string): [SourceEvent, SourceEvent] {
    const a = event(id + '-canonical'), b = event(id + '-redundant');
    b.body = a.body; b.source.message_id = a.source.message_id = 'native-' + id;
    b.generation = 'two';
    return [a, b];
}
function manifest(pairs: [SourceEvent, SourceEvent][]): NativeDuplicateManifest {
    return { schema_version: 1, source: 'synthetic', range, pairs: pairs.map(([a, b]) => ({ canonical_event_id: a.event_id, redundant_event_id: b.event_id })) };
}
function truth(store: Awaited<ReturnType<typeof createStore>>) {
    return ['events', 'fragments', 'facts', 'results', 'reviewed_sources', 'bundles'].map(table => store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}

test('native duplicate preview is read only; prepared zero-fact review closes only redundant IDs through Publisher', async () => {
    const c = await config(), store = await createStore(c), pair = twins('unreviewed');
    await store.saveCollection(collection(pair));
    const before = truth(store), plan = previewNativeDuplicates(c, manifest([pair]));
    assert.deepEqual(truth(store), before); assert.equal(plan.counts.eligible, 1);
    const output = join(dirname(c.data_dir), 'private-duplicate-material');
    const prepared = await prepareNativeDuplicates(c, manifest([pair]), plan.plan_sha, output);
    assert.equal(prepared.counts.prepared, 1); assert.equal(prepared.files.length, 1);
    assert.equal((await lstat(output)).mode & 0o777, 0o700);
    assert.equal((await lstat(join(output, prepared.files[0].result))).mode & 0o777, 0o600);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM results').get()!.n, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM reviewed_sources').get()!.n, 0);
    const semantic = JSON.parse(await readFile(join(output, prepared.files[0].result), 'utf8'));
    const material = JSON.parse(await readFile(join(output, prepared.files[0].bundle), 'utf8'));
    assert.deepEqual(material.chunks.flatMap((chunk: any) => chunk.events.map((e: any) => e.event_id)), [pair[1].event_id]);
    const publisher = createPublisher(store, c);
    assert.equal((await publisher.publish(semantic)).fact_commit, 'committed');
    assert.equal((await publisher.publish(semantic)).fact_commit, 'already_committed');
    const remaining = await store.getReviewableEvents({ range, lane: 'live' }, 'daily');
    assert.deepEqual(remaining.map(e => e.event_id), [pair[0].event_id]);
    assert.equal((await store.readEffectiveFacts({ range })).length, 0);
    assert.deepEqual(store.db.prepare('SELECT * FROM events ORDER BY rowid').all(), before[0]);
    const next = previewNativeDuplicates(c, manifest([pair]));
    assert.equal(next.counts.already_reviewed, 1); assert.equal(next.counts.prepared, 0);
    store.close();
});

test('canonical selection prioritizes reviewed identity, then only monotonic completion, then earliest persistent row', async () => {
    const c = await config(), store = await createStore(c), completed = twins('completion');
    completed[0].role = completed[1].role = 'assistant';
    completed[0].context.turn_complete = false; completed[1].context.turn_complete = true;
    await store.saveCollection(collection(completed));
    assert.throws(() => previewNativeDuplicates(c, manifest([completed])), /canonical.*priority/);
    const chosen: [SourceEvent, SourceEvent] = [completed[1], completed[0]];
    assert.equal(previewNativeDuplicates(c, manifest([chosen])).counts.eligible, 1);
    const older = twins('already-reviewed');
    await store.saveCollection(collection(older, 'live', 'already-reviewed-collection'));
    const accepted = bundle([older[1]], 'reviewed-later-canonical'); await store.saveBundle(accepted);
    await store.commitReview(result(accepted, 'reviewed-later-canonical-result', false));
    assert.equal(previewNativeDuplicates(c, manifest([[older[1], older[0]]])).counts.eligible, 1);
    const repeated = previewNativeDuplicates(c, manifest([older])); assert.equal(repeated.counts.already_reviewed, 1);
    // Earliest row is enforced when no review/completion distinction exists.
    const order = twins('earliest'); await store.saveCollection(collection(order, 'live', 'earliest-collection'));
    assert.throws(() => previewNativeDuplicates(c, manifest([[order[1], order[0]]])), /canonical.*priority/);
    store.close();
});

test('strict duplicate proof rejects different native messages, content, time, source boundaries and independent incomplete input', async () => {
    for (const mutate of [
        (e: SourceEvent) => { e.source.message_id = 'different-native'; },
        (e: SourceEvent) => { e.body += 'different'; },
        (e: SourceEvent) => { e.utc_time.value = '2026-09-30T09:00:00.000000001Z'; },
        (e: SourceEvent) => { e.original_time.value = 'different-wire'; },
        (e: SourceEvent) => { e.role = 'assistant'; },
        (e: SourceEvent) => { e.context.sender_id = 'different-sender'; },
        (e: SourceEvent) => { e.context.incomplete_turn = true; },
        (e: SourceEvent) => { e.context.turn_complete = 'unproven'; },
        (e: SourceEvent) => { e.source.message_id = null; },
        (e: SourceEvent) => { e.utc_time.value = null; e.utc_time.reason = 'Unknown'; },
        (e: SourceEvent) => { e.classification = 'automation'; },
    ]) {
        const c = await config(), store = await createStore(c), pair = twins('strict'); mutate(pair[1]);
        await store.saveCollection(collection(pair));
        assert.throws(() => previewNativeDuplicates(c, manifest([pair])), /Duplicate|completion/);
        assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM results').get()!.n, 0); store.close();
    }
});

test('accepted redundant evidence, partial progress and changed preview are not silently closed', async () => {
    const c = await config(), store = await createStore(c), pair = twins('referenced'); await store.saveCollection(collection(pair));
    const b = bundle([pair[1]], 'referenced'); await store.saveBundle(b); const r = result(b); r.pages = [];
    await store.commitReview(r);
    assert.throws(() => previewNativeDuplicates(c, manifest([pair])), /accepted nonlegacy fact/);
    const pending = twins('preview-cas'); await store.saveCollection(collection(pending, 'live', 'cas-collection'));
    const old = previewNativeDuplicates(c, manifest([pending]));
    const done = bundle([pending[1]], 'other-review'); await store.saveBundle(done); await store.commitReview(result(done, 'other-review', false));
    await assert.rejects(prepareNativeDuplicates(c, manifest([pending]), old.plan_sha, join(dirname(c.data_dir), 'cas-output')), /plan changed/);
    const partial = twins('partial'); await store.saveCollection(collection(partial, 'live', 'partial-collection'));
    // A real partial slice is audit evidence, not an invitation to complete the
    // unsupplied remainder; helper skips it conservatively.
    const original = partial[1], slice = { ...original, event_id: 'partial-slice', body: original.body!.slice(0, 3),
        context: { review_slice: { source_event_id: original.event_id, start_byte: 0, end_byte: 3, total_bytes: Buffer.byteLength(original.body!) } } };
    const sliced = bundle([slice], 'partial-slice-bundle'); await store.saveBundle(sliced);
    await store.commitReview(result(sliced, 'partial-zero', false));
    const preview = previewNativeDuplicates(c, manifest([partial])); assert.equal(preview.counts.partial_review, 1); assert.equal(preview.counts.prepared, 0);
    store.close();
});

test('maintenance CLI prints only counts/digest and body budgets defer oversized originals without partial closure', async () => {
    const c = await config(), store = await createStore(c), pair = twins('cli'); pair[0].body = pair[1].body = 'PRIVATE_SYNTHETIC_BODY '.repeat(50);
    await store.saveCollection(collection(pair)); c.limits.chunk_body_bytes = 32;
    c.journal_timezone_timeline = [{ schema_version: 1, effective_from: '1970-01-01T00:00:00Z', timezone: 'Europe/Amsterdam', basis: 'Synthetic' }];
    const root = dirname(c.data_dir), configPath = join(root, 'config.json'), manifestPath = join(root, 'manifest.json');
    await writeFile(configPath, JSON.stringify(c)); await writeFile(manifestPath, JSON.stringify(manifest([pair])));
    const command = spawnSync(process.execPath, ['tools/native-duplicate-review.ts', '--config', configPath, '--manifest', manifestPath, '--preview'],
        { cwd: new URL('../..', import.meta.url), encoding: 'utf8' });
    assert.equal(command.status, 0, command.stderr); assert(!command.stdout.includes('PRIVATE_SYNTHETIC_BODY'));
    const receipt = JSON.parse(command.stdout); assert.equal(receipt.counts.deferred, 1); assert.equal(receipt.counts.prepared, 0);
    assert.equal(receipt.required_chunk_body_bytes, Buffer.byteLength(pair[0].body!));
    c.limits.chunk_body_bytes = 32768; await writeFile(configPath, JSON.stringify(c));
    const approved = previewNativeDuplicates(c, manifest([pair]));
    const prepared = spawnSync(process.execPath, ['tools/native-duplicate-review.ts', '--config', configPath, '--manifest', manifestPath,
        '--prepare', '--expected-plan-sha', approved.plan_sha, '--output', join(root, 'actual-cli-material')],
        { cwd: new URL('../..', import.meta.url), encoding: 'utf8' });
    assert.equal(prepared.status, 0, prepared.stderr); assert(!prepared.stdout.includes('PRIVATE_SYNTHETIC_BODY'));
    assert.equal(JSON.parse(prepared.stdout).files.length, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM reviewed_sources').get()!.n, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM results').get()!.n, 0); store.close();
});

test('multiple redundant generations remain bounded and a later pass retains the canonical and unread peer', async () => {
    const c = await config(); c.limits.chunk_events = 1; c.limits.bundles_per_round = 1;
    const store = await createStore(c), [kept, first] = twins('multiple'), second = structuredClone(first);
    second.event_id = 'multiple-third'; second.generation = 'three';
    await store.saveCollection(collection([kept, first, second]));
    const input = manifest([[kept, first], [kept, second]]), output = join(dirname(c.data_dir), 'bounded-material');
    const initial = previewNativeDuplicates(c, input);
    assert.equal(initial.counts.eligible, 2); assert.equal(initial.counts.prepared, 1); assert.equal(initial.counts.deferred, 1);
    const prepared = await prepareNativeDuplicates(c, input, initial.plan_sha, output);
    const r = JSON.parse(await readFile(join(output, prepared.files[0].result), 'utf8'));
    await createPublisher(store, c).publish(r);
    const following = previewNativeDuplicates(c, input);
    assert.equal(following.counts.already_reviewed, 1); assert.equal(following.counts.prepared, 1);
    const pending = await store.getReviewableEvents({ range, lane: 'live' }, 'daily');
    assert.equal(pending.length, 2); assert(pending.some(e => e.event_id === kept.event_id));
    store.close();
});

test('corrupt row identity or schema refuses the entire manifest before any bundle or source progress', async () => {
    for (const corruption of ['event_id', 'schema_version'] as const) {
        const c = await config(), store = await createStore(c), valid = twins('valid'), broken = twins('corrupt');
        await store.saveCollection(collection([...valid, ...broken]));
        const damaged: any = structuredClone(broken[1]);
        if (corruption === 'event_id') damaged.event_id = broken[0].event_id;
        else damaged.schema_version = 2;
        store.db.prepare('UPDATE events SET json=? WHERE id=?').run(JSON.stringify(damaged), broken[1].event_id);
        const input = manifest([valid, broken]), before = truth(store);
        assert.throws(() => previewNativeDuplicates(c, input), /primary key\/schema mismatch/);
        await assert.rejects(prepareNativeDuplicates(c, input, '0'.repeat(64), join(dirname(c.data_dir), 'corrupt-material')), /primary key\/schema mismatch/);
        assert.deepEqual(truth(store), before); store.close();
    }
});
