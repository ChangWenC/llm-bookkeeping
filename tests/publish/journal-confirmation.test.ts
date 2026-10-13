import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createStore } from '../../src/store/index.ts';
import { createPublisher, createSafeWikiWriter, acquireWikiLock, digestBytes } from '../../src/publish/index.ts';
import { journalChangeKind } from '../../src/publish/journals.ts';
import { updateManagedBlock } from '../../src/consumers/monthly/blocks.ts';
import { metadataRecoveryFixture } from '../integration/metadata-recovery-fixtures.ts';
import { previewMetadataFileRecovery, applyMetadataFileRecovery } from '../../src/metadata-batch-file-recovery.ts';
import type { FileIntent, JournalConfirmationGuard, JournalConfirmationRequest, JournalPatch, Store } from '../../src/contracts/types.ts';
import { config as fixtureConfig, bundle, result, event } from '../store/fixtures.ts';
const now = () => new Date('2026-10-11T12:00:00Z');
const path = 'wiki/personal/journals/日记_2026_09_30.md';
const original = '---\ntype: journal\nsummary: Original summary\nupdated: 2026-09-30\n---\nOriginal body.\n';

test('empty monthly recovery rejects forged audit identity, state, plan or original ID and preserves later manual edits', async t => {
  for (const tamper of ['work_id', 'schema_version', 'state', 'plan_sha', 'original_id', 'manual']) {
    const f = await metadataRecoveryFixture(t), preview = await previewMetadataFileRecovery(f.config, f.batchId, f.before);
    const interrupted = await applyMetadataFileRecovery(f.config, f.batchId, f.before, preview.plan_sha, { now, fault(stage) { if (stage === 'before_target') throw new Error('Synthetic prepared recovery interruption'); } });
    assert.ok(interrupted.outcomes.every(item => item.status === 'pending'));
    const intent = (await f.store.listFileIntents()).find(item => item.operation_id.startsWith('metadata-recovery:'))!;
    const before = await readFile(join(f.config.wiki_root, intent.path));
    if (tamper === 'manual') await writeFile(join(f.config.wiki_root, intent.path), Buffer.concat([before, Buffer.from('Later manual revision.\n')]));
    else if (tamper === 'original_id') {
      const get = f.store.getFileIntent.bind(f.store);
      f.store.getFileIntent = async id => { const found = await get(id); return found && id.startsWith('monthly-supplement:') ? { ...found, operation_id: 'forged-json-id' } : found; };
    } else {
      const list = f.store.listWork.bind(f.store);
      f.store.listWork = async (kind, state) => (await list(kind, state)).map(work => kind !== 'metadata_batch_file_recovery' ? work :
        tamper === 'plan_sha' ? { ...work, payload: { ...work.payload, plan_sha: '' } } : { ...work, [tamper]: tamper === 'schema_version' ? 2 : 'forged' } as any);
    }
    const lock = await acquireWikiLock(f.config.wiki_root); assert.ok(lock);
    try {
      const outcome = await createSafeWikiWriter(f.store, f.config, { now }).recoverLocked(intent, lock);
      assert.equal(outcome.status, tamper === 'manual' ? 'conflict' : 'pending', tamper);
      if (tamper !== 'manual') assert.match(outcome.reason!, /awaiting_user_confirmation/, tamper);
    } finally { await lock.release(); }
    assert.deepEqual(await readFile(join(f.config.wiki_root, intent.path)), tamper === 'manual' ? Buffer.concat([before, Buffer.from('Later manual revision.\n')]) : before);
  }
});
async function fixture(t: test.TestContext, text = original, inject = true) {
  const config = await fixtureConfig(), store = await createStore(config, { now });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await store.close(); } };
  t.after(async () => { await close(); await rm(dirname(config.wiki_root), { recursive: true, force: true }); });
  await mkdir(dirname(join(config.wiki_root, path)), { recursive: true }); await writeFile(join(config.wiki_root, path), text);
  const file = () => readFile(join(config.wiki_root, path), 'utf8');
  // Contract-level guard injection keeps these writer tests independent of SQL
  // ownership; Store's actual human decision ledger is exercised by B's tests.
  const states = new Map<string, JournalConfirmationGuard['status']>(), requests: JournalConfirmationRequest[] = [];
  let knownConflict = false, effective = true;
  const guard = (intent: FileIntent, required: boolean): JournalConfirmationGuard => {
    const status = !effective ? 'stale' : states.get(intent.operation_id) ?? (required || knownConflict ? 'awaiting_user_confirmation' : 'not_required');
    return { schema_version: 1, status, proposal_id: status === 'not_required' ? null : `proposal:${intent.operation_id}`, work_ids: [], reason: null };
  };
  if (inject) {
    store.ensureJournalConfirmation = async request => { requests.push(structuredClone(request)); return guard(request.intent!, request.requires_confirmation); };
    store.validateJournalConfirmation = async intent => guard(intent, journalChangeKind(Buffer.from(intent.backup_bytes_base64!, 'base64'), Buffer.from(intent.desired_bytes_base64!, 'base64')) === 'replace');
  }
  return { config, store, close, file, states, requests, conflict: () => { knownConflict = true; }, invalidate: () => { effective = false; } };
}
function patch(id: string, mode: 'append' | 'replace' = 'replace'): JournalPatch { return { schema_version: 1, operation_id: id, date: '2026-09-30', path, baseline_digest: digestBytes(Buffer.from(original)), mode, old_text: mode === 'replace' ? 'Original body.' : null, new_text: 'Corrected body.\n', fact_refs: [] }; }
async function acceptedPatch(f: Awaited<ReturnType<typeof fixture>>, id: string, mode: 'append' | 'replace' = 'replace') {
  const material = bundle([event(`event:${id}`, 'Synthetic user verification')], `bundle:${id}`);
  material.baselines = [{ schema_version: 1, path, content: original, digest: digestBytes(Buffer.from(original)) }]; await f.store.saveBundle(material);
  const review = result(material, `result:${id}`); Object.assign(review.pages[0], patch(id, mode));
  return (await f.store.commitReview(review)).patches[0];
}
test('direct committed replacement exports facts independently while awaiting user confirmation', async t => {
  const f = await fixture(t), material = bundle([event('event:confirmation', 'Synthetic user verification')], 'bundle:confirmation');
  material.baselines = [{ schema_version: 1, path, content: original, digest: digestBytes(Buffer.from(original)) }]; await f.store.saveBundle(material);
  const review = result(material, 'result:confirmation'); Object.assign(review.pages[0], { path, mode: 'replace', old_text: 'Original body.', new_text: 'Corrected body.' });
  const publisher = createPublisher(f.store, f.config, { now }), receipt = await publisher.publish(review);
  const file = receipt.files.find(file => file.path === path)!;
  assert.equal(receipt.fact_commit, 'committed'); assert.equal(receipt.export_status, 'ready'); assert.equal(file.status, 'pending'); assert.match(file.reason!, /awaiting_user_confirmation/);
  assert.equal(await f.file(), original); assert.equal((await f.store.getFileIntent(file.operation_id))!.state, 'prepared');
  await publisher.resume(); assert.equal(await f.file(), original);
  f.states.set(file.operation_id, 'confirmed');
  const resumed = await publisher.resume(); assert.ok(resumed.files.some(file => file.path === path && file.status === 'applied'));
  assert.equal((await f.store.listOutbox()).length, 1); assert.equal((await publisher.publish(review)).fact_commit, 'already_committed');
  assert.equal((await f.file()).match(/Corrected body\./g)!.length, 1);
});
test('actual SQLite proposal and separate user decision bind full intent and recover idempotently', async t => {
  const f = await fixture(t, original, false), p = await acceptedPatch(f, 'actual-user-ledger');
  const publisher = createPublisher(f.store, f.config, { now });
  const first = (await publisher.applyPatches([p]))[0]; assert.equal(first.status, 'pending'); assert.match(first.reason!, /awaiting_user_confirmation/); assert.equal(await f.file(), original);
  const proposal = (await f.store.listWork('journal_confirmation'))[0].payload.proposal as import('../../src/contracts/types.ts').JournalConfirmationProposal;
  assert.equal(proposal.operation_id, p.operation_id); assert.equal(proposal.old_text, original); assert.equal(proposal.new_text, original.replace('Original body.', p.new_text)); assert.equal(proposal.baseline_digest, digestBytes(Buffer.from(original)));
  assert.deepEqual(proposal.fact_refs, p.fact_refs); assert.ok(proposal.work_ids.length);
  await publisher.applyPatches([p]); assert.equal((await f.store.listWork('journal_confirmation')).length, 1);
  const decision = { schema_version: 1 as const, decision_id: 'user:actual-confirm', proposal_id: proposal.proposal_id, proposal_digest: proposal.proposal_digest, decision: 'confirm' as const, response_source: 'synthetic-user-chat', response_content: 'Yes, apply this exact correction.', basis: 'explicit_user_response' as const, baseline_digest: proposal.baseline_digest, fact_refs: proposal.fact_refs, work_ids: proposal.work_ids, reason: 'Synthetic explicit human response' };
  const lock = await acquireWikiLock(f.config.wiki_root); assert.ok(lock);
  try { assert.equal((await f.store.decideJournalConfirmation!(decision, lock)).status, 'confirmed'); assert.equal((await f.store.decideJournalConfirmation!(decision, lock)).status, 'confirmed'); } finally { await lock.release(); }
  assert.equal((await publisher.applyPatches([p]))[0].status, 'applied'); assert.equal((await publisher.applyPatches([p]))[0].status, 'noop');
  assert.equal((await f.store.listWork('journal_confirmation')).length, 1); assert.ok((await f.store.listWork('journal_publication')).every(work => work.state === 'complete'));
});
test('old saved prepared FileIntent and writer direct path cannot bypass confirmation', async t => {
  const f = await fixture(t), desired = original.replace('Original body.', 'Unsafe replacement.');
  const intent: FileIntent = { schema_version: 1, operation_id: 'legacy-pending', path, baseline_digest: digestBytes(Buffer.from(original)), desired_digest: digestBytes(Buffer.from(desired)), backup_bytes_base64: Buffer.from(original).toString('base64'), desired_bytes_base64: Buffer.from(desired).toString('base64'), fact_refs: [], state: 'prepared', reason: null, created_at: now().toISOString() };
  await f.store.saveFileIntent(intent); assert.equal((await createPublisher(f.store, f.config, { now }).resume()).files.find(file => file.operation_id === intent.operation_id)!.status, 'pending');
  const direct = await createSafeWikiWriter(f.store, f.config, { now }).write({ operation_id: 'direct-writer', path, baseline_digest: intent.baseline_digest, desired_bytes: Buffer.from(desired) });
  assert.equal(direct.status, 'pending'); assert.equal(await f.file(), original); assert.equal(f.requests.filter(request => request.intent?.operation_id === 'legacy-pending').length, 1);
});
test('summary replacement, known conflicting append and changed append baseline require confirmation', async t => {
  const f = await fixture(t), writer = createSafeWikiWriter(f.store, f.config, { now });
  assert.equal((await writer.write({ operation_id: 'summary', path, baseline_digest: digestBytes(Buffer.from(original)), desired_bytes: Buffer.from(original.replace('Original summary', 'Changed summary')) })).status, 'pending');
  f.conflict(); assert.equal((await createPublisher(f.store, f.config, { now }).applyPatches([await acceptedPatch(f, 'known-conflict', 'append')]))[0].status, 'pending');
  const g = await fixture(t), changed = await acceptedPatch(g, 'changed-baseline', 'append'); await writeFile(join(g.config.wiki_root, path), original + 'Later manual content.\n');
  assert.equal((await createPublisher(g.store, g.config, { now }).applyPatches([changed]))[0].status, 'pending');
  assert.equal(await f.file(), original); assert.equal(await g.file(), original + 'Later manual content.\n');
});
test('confirmation becomes stale when effective facts change before atomic replacement', async t => {
  const f = await fixture(t), p = await acceptedPatch(f, 'stale-facts'); f.states.set(p.operation_id, 'confirmed');
  const outcome = await createPublisher(f.store, f.config, { now, fault(stage) { if (stage === 'before_target') f.invalidate(); } }).applyPatches([p]);
  assert.equal(outcome[0].status, 'pending'); assert.match(outcome[0].reason!, /stale/); assert.equal(await f.file(), original);
});
test('confirmed persisted intent does not rebase over a later manual edit', async t => {
  const f = await fixture(t), p = await acceptedPatch(f, 'stale-baseline'); f.states.set(p.operation_id, 'confirmed');
  assert.equal((await createPublisher(f.store, f.config, { now, fault(stage) { if (stage === 'after_intent') throw new Error('Synthetic interruption'); } }).applyPatches([p]))[0].status, 'pending');
  const edited = original + 'Manual addition.\n'; await writeFile(join(f.config.wiki_root, path), edited);
  assert.equal((await createPublisher(f.store, f.config, { now }).resume()).files.find(file => file.operation_id === p.operation_id)!.status, 'conflict'); assert.equal(await f.file(), edited);
});
test('new pages, nonconflicting append and verified metadata maintenance remain automatic', async t => {
  const f = await fixture(t), writer = createSafeWikiWriter(f.store, f.config, { now });
  assert.equal((await writer.write({ operation_id: 'metadata', path, baseline_digest: digestBytes(Buffer.from(original)), desired_bytes: Buffer.from(original.replace('updated: 2026-09-30', 'updated: 2026-10-11')) })).status, 'applied');
  const current = await f.file(); assert.equal((await writer.write({ operation_id: 'append', path, baseline_digest: digestBytes(Buffer.from(current)), desired_bytes: Buffer.from(current + 'New independent activity.\n') })).status, 'applied');
  const newPath = 'wiki/personal/journals/日记_2026_10_11.md'; assert.equal((await writer.write({ operation_id: 'new', path: newPath, baseline_digest: 'absent', desired_bytes: Buffer.from('# New synthetic journal\n') })).status, 'applied');
  assert.equal(f.requests.some(request => request.intent?.operation_id === 'metadata'), false);
});
test('fake maintenance origins and absent guard cannot authorize existing journal semantics', async t => {
  const f = await fixture(t), writer = createSafeWikiWriter(f.store, f.config, { now });
  assert.equal((await writer.write({ operation_id: 'archive-link:pretend', path, baseline_digest: digestBytes(Buffer.from(original)), desired_bytes: Buffer.from('Forged whole body.\n'), maintenance: true } as any)).status, 'pending');
  (f.store as Store).ensureJournalConfirmation = undefined; (f.store as Store).validateJournalConfirmation = undefined;
  assert.equal((await writer.write({ operation_id: 'guard-unavailable', path, baseline_digest: digestBytes(Buffer.from(original)), desired_bytes: Buffer.from(original + 'Unaudited append.\n') })).status, 'pending'); assert.equal(await f.file(), original);
});
test('keep_existing preserves differing text and prior applied history remains noop after manual edits', async t => {
  const f = await fixture(t), keep = await acceptedPatch(f, 'keep'); f.states.set(keep.operation_id, 'keep_existing'); const publisher = createPublisher(f.store, f.config, { now });
  const kept = (await publisher.applyPatches([keep]))[0]; assert.equal(kept.status, 'pending'); assert.match(kept.reason!, /keep_existing/); assert.equal(await f.file(), original);
  const applied = await acceptedPatch(f, 'applied'); f.states.set(applied.operation_id, 'confirmed'); assert.equal((await publisher.applyPatches([applied]))[0].status, 'applied');
  await writeFile(join(f.config.wiki_root, path), 'Manual after applied.\n'); f.invalidate(); const lock = await acquireWikiLock(f.config.wiki_root); assert.ok(lock);
  try { assert.equal((await createSafeWikiWriter(f.store, f.config, { now }).recoverLocked((await f.store.getFileIntent(applied.operation_id))!, lock)).status, 'noop'); } finally { await lock.release(); }
  assert.equal(await f.file(), 'Manual after applied.\n');
});
test('direct-only pending intent survives restart, separate human decision and publication resume', async t => {
  const f = await fixture(t, original, false), desired = original.replace('Original body.', 'Confirmed direct correction.');
  const outcome = await createSafeWikiWriter(f.store, f.config, { now }).write({ operation_id: 'direct-only:restart', path, baseline_digest: digestBytes(Buffer.from(original)), desired_bytes: Buffer.from(desired) });
  assert.equal(outcome.status, 'pending'); const proposal = (await f.store.listWork('journal_confirmation'))[0].payload.proposal as import('../../src/contracts/types.ts').JournalConfirmationProposal;
  await f.close(); const reopened = await createStore(f.config, { now }); t.after(() => reopened.close());
  const lock = await acquireWikiLock(f.config.wiki_root); assert.ok(lock);
  try { assert.equal((await reopened.decideJournalConfirmation!({ schema_version: 1, decision_id: 'user:direct-restart', proposal_id: proposal.proposal_id, proposal_digest: proposal.proposal_digest, decision: 'confirm', response_source: 'synthetic-user-chat', response_content: 'Yes, apply this exact correction.', basis: 'explicit_user_response', baseline_digest: proposal.baseline_digest, fact_refs: proposal.fact_refs, work_ids: proposal.work_ids, reason: 'Synthetic explicit human direct correction' }, lock)).status, 'confirmed'); } finally { await lock.release(); }
  const publisher = createPublisher(reopened, f.config, { now }); assert.ok((await publisher.resume()).files.some(file => file.operation_id === 'direct-only:restart' && file.status === 'applied')); assert.equal(await f.file(), desired);
  assert.ok((await publisher.resume()).files.some(file => file.operation_id === 'direct-only:restart' && file.status === 'noop')); assert.equal((await reopened.listFileIntents()).length, 1);
});
test('existing monthly and yearly manual body or summary cannot use journal class to bypass guard', async t => {
  const f = await fixture(t), writer = createSafeWikiWriter(f.store, f.config, { now });
  for (const [target, classification] of [['wiki/personal/journals/reviews/回顾_2026_09.md', 'monthly-review'], ['wiki/personal/journals/reviews/回顾_2026.md', 'yearly-review']]) {
    const text = original.replace('type: journal', `type: journal\njournal_class: ${classification}`); await writeFile(join(f.config.wiki_root, target), text).catch(async () => { await mkdir(dirname(join(f.config.wiki_root, target)), { recursive: true }); await writeFile(join(f.config.wiki_root, target), text); });
    assert.equal((await writer.write({ operation_id: `manual:${classification}`, path: target, baseline_digest: digestBytes(Buffer.from(text)), desired_bytes: Buffer.from(text.replace('Original body.', 'Unconfirmed full rewrite.')) })).status, 'pending');
    assert.equal((await writer.write({ operation_id: `summary:${classification}`, path: target, baseline_digest: digestBytes(Buffer.from(text)), desired_bytes: Buffer.from(text.replace('Original summary', 'Unconfirmed summary')) })).status, 'pending');
    assert.equal(await readFile(join(f.config.wiki_root, target), 'utf8'), text);
  }
});
test('exact managed monthly replacement preserves every manual byte; forged outside rewrite is blocked', async t => {
  const f = await fixture(t), target = 'wiki/personal/journals/reviews/回顾_2026_09.md', text = updateManagedBlock(original, 'monthly-supplement', '2026-09', 'Old generated supplement.\n'), desired = updateManagedBlock(text, 'monthly-supplement', '2026-09', 'New generated supplement.\n');
  await mkdir(dirname(join(f.config.wiki_root, target)), { recursive: true }); await writeFile(join(f.config.wiki_root, target), text);
  const id = (content: string) => `monthly-supplement:2026-09:${digestBytes(Buffer.from(`${digestBytes(Buffer.from(text))}:${digestBytes(Buffer.from(content))}:[]`))}`;
  const writer = createSafeWikiWriter(f.store, f.config, { now });
  const forged = desired.replace('Original body.', 'Forged manual rewrite.'); assert.equal((await writer.write({ operation_id: id(forged), path: target, baseline_digest: digestBytes(Buffer.from(text)), desired_bytes: Buffer.from(forged) })).status, 'pending');
  assert.equal((await writer.write({ operation_id: id(desired), path: target, baseline_digest: digestBytes(Buffer.from(text)), desired_bytes: Buffer.from(desired) })).status, 'applied'); assert.equal(await readFile(join(f.config.wiki_root, target), 'utf8'), desired);
});
test('nonarchive deletion and a forged archive boolean retain journals and recoverable intent', async t => {
  const f = await fixture(t), writer = createSafeWikiWriter(f.store, f.config, { now });
  for (const operation_id of ['direct-delete', 'archive-delete:forged']) {
    assert.equal((await writer.write({ operation_id, path, baseline_digest: digestBytes(Buffer.from(original)), desired_bytes: null, archive_delete_verified: true })).status, 'pending');
    assert.equal((await f.store.getFileIntent(operation_id))!.state, 'prepared');
  }
  await createPublisher(f.store, f.config, { now }).resume(); assert.equal(await f.file(), original);
});
test('changed-baseline append persists confirmation requirement before proposal creation and recovers fail closed', async t => {
  const f = await fixture(t, original, false), p = await acceptedPatch(f, 'crash-before-proposal', 'append');
  const manual = original + 'Later manual addition.\n'; await writeFile(join(f.config.wiki_root, path), manual);
  const crashed = createPublisher(f.store, f.config, { now, fault(stage) { if (stage === 'after_intent') throw new Error('Synthetic interruption before confirmation proposal'); } });
  assert.equal((await crashed.applyPatches([p]))[0].status, 'pending'); assert.equal((await f.store.listWork('journal_confirmation')).length, 0);
  assert.equal((await f.store.getFileIntent(p.operation_id))!.journal_confirmation_required, true);
  const resumed = await createPublisher(f.store, f.config, { now }).resume(); const file = resumed.files.find(file => file.operation_id === p.operation_id)!;
  assert.equal(file.status, 'pending'); assert.match(file.reason!, /awaiting_user_confirmation/); assert.equal(await f.file(), manual); assert.equal((await f.store.listWork('journal_confirmation')).length, 1);
});

test('privacy add, remove and changed value require confirmation; equivalent formatting and status are mechanical', async t => {
  for (const [id, before, after, expected] of [
    ['add', original, original.replace('type: journal', 'type: journal\nprivacy: private'), 'pending'],
    ['remove', original.replace('type: journal', 'type: journal\nprivacy: private'), original, 'pending'],
    ['value', original.replace('type: journal', 'type: journal\nprivacy: private'), original.replace('type: journal', 'type: journal\nprivacy: public'), 'pending'],
    ['format', original.replace('type: journal', 'type: journal\nprivacy: private'), original.replace('type: journal', 'type: journal\nprivacy: "private" # unchanged'), 'applied'],
    ['status', original, original.replace('type: journal', 'type: journal\nstatus: stable'), 'applied'],
  ]) {
    const f = await fixture(t, before), writer = createSafeWikiWriter(f.store, f.config, { now });
    assert.equal((await writer.write({ operation_id: `privacy:${id}`, path, baseline_digest: digestBytes(Buffer.from(before)), desired_bytes: Buffer.from(after) })).status, expected);
    assert.equal(await f.file(), expected === 'pending' ? before : after);
  }
});
test('manual edit during the last awaited confirmation validation conflicts without overwrite', async t => {
  for (const route of ['direct', 'saved-intent', 'publisher']) {
    const f = await fixture(t), desired = original.replace('Original body.', 'Confirmed correction.'), manual = original + 'Manual edit during gate.\n';
    const operation = `last-gate:${route}`; f.states.set(operation, 'confirmed');
    f.store.validateJournalConfirmation = async () => { await writeFile(join(f.config.wiki_root, path), manual); return { schema_version: 1, status: 'confirmed', proposal_id: operation, work_ids: [], reason: null }; };
    const writer = createSafeWikiWriter(f.store, f.config, { now });
    let receipt;
    if (route === 'saved-intent') {
      const intent: FileIntent = { schema_version: 1, operation_id: operation, path, baseline_digest: digestBytes(Buffer.from(original)), desired_digest: digestBytes(Buffer.from(desired)), backup_bytes_base64: Buffer.from(original).toString('base64'), desired_bytes_base64: Buffer.from(desired).toString('base64'), fact_refs: [], state: 'prepared', reason: null, created_at: now().toISOString() };
      await f.store.saveFileIntent(intent); receipt = (await createPublisher(f.store, f.config, { now }).resume()).files.find(file => file.operation_id === operation)!;
    } else if (route === 'publisher') {
      const p = await acceptedPatch(f, operation); f.states.set(p.operation_id, 'confirmed'); receipt = (await createPublisher(f.store, f.config, { now }).applyPatches([p]))[0];
    } else receipt = await writer.write({ operation_id: operation, path, baseline_digest: digestBytes(Buffer.from(original)), desired_bytes: Buffer.from(desired) });
    assert.equal(receipt.status, 'conflict', route); assert.equal(await f.file(), manual, route);
  }
});
