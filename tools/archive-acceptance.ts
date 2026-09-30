import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { relative, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, canonicalLocation } from '../src/config.ts';
import { createStore } from '../src/store/index.ts';
import { createArchiveService } from '../src/consumers/archive/index.ts';
import { digestBytes, readWikiTarget } from '../src/publish/files.ts';

const acceptanceRoot = '/private/tmp/bookkeeping-acceptance';
const month = '2026-08';
const selected = ['01', '02'].map(day => `wiki/personal/journals/日记_2026_08_${day}.md`);
function isolated(path: string): void {
  const rel = relative(acceptanceRoot, path);
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Acceptance inputs/wiki/data must be descendants of /private/tmp/bookkeeping-acceptance');
}
/** Coordinator only: controlled-clock isolated copies, never scheduled/production archive acceptance. */
export async function runArchiveAcceptance(configPath: string, now: string) {
  isolated(await realpath(configPath));
  const instant = new Date(now);
  if (!now.endsWith('Z') || !Number.isFinite(instant.getTime())) throw new Error('Explicit UTC --now required');
  const config = await loadConfig(configPath);
  isolated(await canonicalLocation(config.wiki_root)); isolated(await canonicalLocation(config.data_dir));
  const store = await createStore(config);
  try {
    const service = createArchiveService(store, config, { now: () => instant });
    const report = await service.report(month);
    const eligible = report.pages.filter(page => page.status === 'eligible').map(page => page.path).sort();
    assert.deepEqual(eligible, selected, 'Only the two previously reviewed August originals may be eligible in this isolated copy');
    const originals = new Map(await Promise.all(report.pages.map(async page => [page.path, (await readWikiTarget(config.wiki_root, page.path)).bytes!] as const)));
    const applied = await service.run({ month, mode: 'apply' });
    assert.equal(applied.status, 'complete', 'Preservation/review/links/deletion must all complete');
    for (const page of applied.pages) {
      if (page.status === 'retained') assert.deepEqual((await readWikiTarget(config.wiki_root, page.path)).bytes, originals.get(page.path));
      else {
        assert.ok(selected.includes(page.path)); assert.equal(page.status, 'applied');
        assert.equal((await readWikiTarget(config.wiki_root, page.path)).bytes, null);
        const record = JSON.parse(await readFile(join(config.wiki_root, page.archive_path!), 'utf8'));
        assert.deepEqual(Buffer.from(record.original_bytes_base64, 'base64'), originals.get(page.path));
        assert.equal(record.original_digest, digestBytes(originals.get(page.path)!));
        assert.equal(record.date, page.date); assert.equal(record.source_path, page.path);
        assert.equal(typeof record.locator, 'string'); assert.ok(Array.isArray(record.fact_refs));
      }
    }
    const repeated = await service.run({ month, mode: 'apply' });
    assert.equal(repeated.status, 'complete'); assert.ok(repeated.pages.every(page => page.status === 'retained'));
    const intents = await store.listFileIntents();
    assert.equal(intents.filter(intent => intent.operation_id.startsWith('archive-delete:')).length, 2);
    return { schema_version: 1, acceptance: 'isolated-controlled-clock', now: instant.toISOString(), month,
      preserved_and_deleted: 2, retained: applied.pages.filter(page => page.status === 'retained').length,
      backlink_files: intents.filter(intent => intent.operation_id.startsWith('archive-link:')).length,
      repeated: 'complete', production_writes: false, scheduled_evidence: false };
  } finally { store.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--config' || args[2] !== '--now') throw new Error('Usage: archive-acceptance.ts --config ABS --now UTC');
  process.stdout.write(JSON.stringify(await runArchiveAcceptance(args[1], args[3])) + '\n');
}
