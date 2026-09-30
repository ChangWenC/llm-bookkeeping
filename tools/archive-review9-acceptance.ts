import assert from 'node:assert/strict';
import { realpath, writeFile, rename } from 'node:fs/promises';
import { relative, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadConfig, canonicalLocation } from '../src/config.ts';
import { createStore } from '../src/store/index.ts';
import { createArchiveService, readArchiveRecords } from '../src/consumers/archive/index.ts';
import { createPublisher, createSafeWikiWriter } from '../src/publish/index.ts';
import { digestBytes, readWikiTarget } from '../src/publish/files.ts';

const acceptanceRoot = '/private/tmp/bookkeeping-acceptance';
const month = '2026-08', monthly = 'wiki/personal/journals/reviews/回顾_2026_08.md';
const selected = ['01', '02'].map(day => `wiki/personal/journals/日记_2026_08_${day}.md`);
function isolated(path: string): void {
  const rel = relative(acceptanceRoot, path);
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Acceptance config/wiki/data must be descendants of /private/tmp/bookkeeping-acceptance');
}
function equalBytes(actual: Buffer | null, expected: Buffer, label: string): void {
  // Never include private bytes in stdout or failed assertion diagnostics.
  assert.ok(actual?.equals(expected), label);
}
/** Coordinator only: real data COPIES under a controlled clock, never scheduled
 * or production deletion evidence. All diagnostics contain counts/labels only. */
export async function runArchiveReview9Acceptance(configPath: string, now: string) {
  isolated(await realpath(configPath));
  const instant = new Date(now);
  if (!now.endsWith('Z') || !Number.isFinite(instant.getTime()) || instant.toISOString().slice(0, 10) !== '2026-10-01') throw new Error('Controlled UTC --now must fall on 2026-10-01');
  const config = await loadConfig(configPath);
  isolated(await canonicalLocation(config.wiki_root)); isolated(await canonicalLocation(config.data_dir));
  const store = await createStore(config), clock = { now: () => instant };
  try {
    assert.equal((await store.listFileIntents()).length, 0, 'Use a fresh isolated Store without existing file intents');
    assert.equal((await store.listOutbox()).length, 0, 'Use a fresh isolated Store without accepted batches');
    let initialReview = await readWikiTarget(config.wiki_root, monthly);
    const syntheticReview = initialReview.bytes === null;
    if (syntheticReview) {
      const output = await createSafeWikiWriter(store, config, clock).write({ operation_id: `acceptance-review:${randomUUID()}`, path: monthly,
        baseline_digest: 'absent', desired_bytes: Buffer.from('---\nstatus: stable\n---\n# 验收专用合成前置回顾\n\n仅验证隔离副本的归档恢复；不是业务八月月回顾。[[日记_2026_08_01|验收第一篇]] [[日记_2026_08_02|验收第二篇]]\n') });
      assert.equal(output.status, 'applied', 'Synthetic acceptance review is created only inside the isolated copy');
      initialReview = await readWikiTarget(config.wiki_root, monthly);
    }
    const service = createArchiveService(store, config, clock);
    const report = await service.report(month);
    assert.deepEqual(report.pages.filter(page => page.status === 'eligible').map(page => page.path).sort(), selected,
      'Only the two previously reviewed August daily pages may be eligible');
    const originals = new Map(await Promise.all(report.pages.map(async page => [page.path, (await readWikiTarget(config.wiki_root, page.path)).bytes!] as const)));
    assert.ok(initialReview.bytes);
    const text = initialReview.bytes.toString('utf8'); equalBytes(Buffer.from(text), initialReview.bytes, 'Review must be lossless UTF-8');
    const draft = text.startsWith('---\n') || text.startsWith('---\r\n')
      ? text.replace(/^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/, (_whole, start: string, header: string, end: string) =>
        start + header.replace(/^[ \t]*(?:status|'status'|"status")[ \t]*:[^\r\n]*(?:\r?\n|$)/gm, '') + '\nstatus: "draft" # isolated acceptance\n' + end)
      : '---\nstatus: "draft" # isolated acceptance\n---\n' + text;
    await writeFile(initialReview.absolute, draft);
    try {
      const draftReport = await service.report(month);
      assert.ok(draftReport.pages.filter(page => selected.includes(page.path)).every(page => page.status === 'pending'), 'Quoted draft must not be eligible');
      assert.equal((await service.run({ month, mode: 'apply' })).status, 'pending', 'Quoted draft must defer deletion');
      for (const path of selected) equalBytes((await readWikiTarget(config.wiki_root, path)).bytes, originals.get(path)!, 'Draft check preserves daily bytes');
    } finally { await writeFile(initialReview.absolute, initialReview.bytes); }
    const log = await readWikiTarget(config.wiki_root, 'log.md');
    const seededLog = Buffer.concat([log.bytes ?? Buffer.alloc(0), Buffer.from('\n隔离验收：[[日记_2026_08_01|验收保留显示文本]] [[日记_2026_08_02|第二篇显示文本]]\n')]);
    await writeFile(log.absolute, seededLog);
    const interrupted = await createArchiveService(store, config, { ...clock, fault(stage, operation) {
      if (stage === 'after_intent' && operation.startsWith('archive-delete:')) throw new Error('Isolated crash after delete intent');
    } }).run({ month, mode: 'apply' });
    assert.equal(interrupted.status, 'pending');
    assert.equal((await store.listFileIntents()).filter(intent => intent.operation_id.startsWith('archive-delete:') && intent.state === 'prepared').length, 2);
    const pendingDaily = new Map(await Promise.all(selected.map(async path => [path, (await readWikiTarget(config.wiki_root, path)).bytes!] as const)));
    assert.ok([...pendingDaily.values()].every(bytes => bytes !== null), 'No delete occurred before injected crash');
    const reviewBeforeMove = await readWikiTarget(config.wiki_root, monthly); assert.ok(reviewBeforeMove.bytes);
    const parked = join(config.data_dir, `acceptance-review-${randomUUID()}.saved`);
    await rename(reviewBeforeMove.absolute, parked);
    try {
      const resumed = await createPublisher(store, config, clock).resume();
      assert.equal(resumed.files.filter(file => file.operation_id.startsWith('archive-delete:') && file.status === 'pending').length, 2, 'Missing review keeps both saved deletes pending');
      for (const path of selected) equalBytes((await readWikiTarget(config.wiki_root, path)).bytes, pendingDaily.get(path)!, 'Generic resume must preserve extant daily');
    } finally { await rename(parked, reviewBeforeMove.absolute); }
    equalBytes((await readWikiTarget(config.wiki_root, monthly)).bytes, reviewBeforeMove.bytes, 'Restored review bytes remain unchanged');
    const completed = await createPublisher(store, config, clock).resume();
    assert.equal(new Set(completed.files.filter(file => file.operation_id.startsWith('archive-delete:') && file.status === 'applied').map(file => file.path)).size, 2);
    assert.ok(!completed.files.some(file => file.operation_id.startsWith('archive-delete:') && ['pending', 'conflict'].includes(file.status)), 'Every saved delete attempt converges after real absence');
    const records = await readArchiveRecords(config);
    for (const path of selected) {
      assert.equal((await readWikiTarget(config.wiki_root, path)).bytes, null);
      const record = records.find(item => item.record.format === 'daily-journal-archive-v2' && item.record.source_path === path)?.record;
      assert.ok(record, 'Complete immutable original exists');
      equalBytes(Buffer.from(String(record.original_bytes_base64), 'base64'), originals.get(path)!, 'Original bytes preserved across every stage');
      assert.equal(record.original_digest, digestBytes(originals.get(path)!));
    }
    for (const page of report.pages.filter(page => page.status === 'retained')) equalBytes((await readWikiTarget(config.wiki_root, page.path)).bytes, originals.get(page.path)!, 'Retained handwritten page unchanged');
    const logText = (await readWikiTarget(config.wiki_root, 'log.md')).bytes!.toString('utf8');
    assert.ok(logText.includes('[[回顾_2026_08|验收保留显示文本]]') && logText.includes('[[回顾_2026_08|第二篇显示文本]]'), 'Root log aliases migrate exactly');
    assert.equal((await service.run({ month, mode: 'apply' })).status, 'complete', 'Repeat archive completes without duplicate deletion');
    assert.ok((await store.listFileIntents()).filter(intent => intent.operation_id.startsWith('archive-delete:')).every(intent => intent.state === 'applied'), 'Every old/new delete registration is repaired');
    return { schema_version: 1, acceptance: 'isolated-controlled-clock-review9', now: instant.toISOString(), month,
      quoted_draft_deferred: 2, missing_review_deferred: 2, preserved_and_deleted: 2,
      retained: report.pages.filter(page => page.status === 'retained').length, root_log_links_migrated: 2,
      review_precondition: syntheticReview ? 'acceptance-only-synthetic-review' : 'supplied-isolated-review-copy',
      repeated: 'complete', production_writes: false, scheduled_evidence: false };
  } finally { store.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--config' || args[2] !== '--now') throw new Error('Usage: archive-review9-acceptance.ts --config ABS --now UTC_ON_2026-10-01');
  process.stdout.write(JSON.stringify(await runArchiveReview9Acceptance(args[1], args[3])) + '\n');
}
