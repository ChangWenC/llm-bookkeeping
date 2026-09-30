import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { BookkeepingConfig, Store, FactRevision } from '../../contracts/types.ts';
import { readWikiTarget } from '../../publish/files.ts';

export const archiveFolder = 'wiki/personal/_evidence/daily_journals';
export const sha = (text: string | Uint8Array): string => createHash('sha256').update(text).digest('hex');
export const monthlyPath = (month: string): string => `wiki/personal/journals/reviews/回顾_${month.replaceAll('-', '_')}.md`;
export function checkMonth(month: string): void {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) throw new Error('Month must be YYYY-MM');
}
export function monthRange(month: string) {
  checkMonth(month);
  const start = new Date(`${month}-01T00:00:00Z`), end = new Date(start); end.setUTCMonth(end.getUTCMonth() + 1);
  start.setUTCDate(start.getUTCDate() - 2); end.setUTCDate(end.getUTCDate() + 2);
  return { schema_version: 1 as const, from: start.toISOString(), to: end.toISOString() };
}
export async function effectiveMonthFacts(store: Store, month: string): Promise<FactRevision[]> {
  return (await store.readEffectiveFacts({ range: monthRange(month) })).filter(fact => (fact.journal_date.value ?? fact.occurred_at.value?.slice(0, 10))?.startsWith(month))
    .sort((a, b) => (a.journal_date.value ?? a.occurred_at.value ?? '').localeCompare(b.journal_date.value ?? b.occurred_at.value ?? '') || a.fact_id.localeCompare(b.fact_id) || a.revision - b.revision);
}
/** Shared scope for backlink planning AND final deletion checks. Root Markdown
 * maintenance pages are managed too, including newly created untracked pages.
 * Bootloaders, code/config/schema/template directories and immutable evidence
 * are outside this scope; only the wiki subtree is recursively scanned. */
export async function listMarkdown(root: string): Promise<string[]> {
  const result: string[] = [];
  async function scan(path: string): Promise<void> {
    let entries;
    try { entries = await readdir(join(root, path), { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (entry.name === 'raw' || entry.name === '_evidence' || entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink()) throw new Error(`Cannot enumerate Wiki symlink ${join(path, entry.name)}`);
      const child = join(path, entry.name);
      if (entry.isDirectory()) await scan(child);
      else if (entry.isFile() && entry.name.endsWith('.md')) result.push(child);
    }
  }
  await scan('wiki');
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.name.endsWith('.md') || ['AGENTS.md', 'CLAUDE.md'].includes(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new Error(`Cannot enumerate Wiki symlink ${entry.name}`);
    if (entry.isFile()) result.push(entry.name);
  }
  return result.sort();
}

export interface ArchiveRecord { file: string; file_digest: string; record: Record<string, unknown> }
export interface ArchiveReadIssue { file: string; line: number | null; date: string | null; reason: string }
export type ArchiveRecords = ArchiveRecord[] & { issues: ArchiveReadIssue[] };
/** Independent old/new data reader. Never reads old implementation or edits archives. */
export async function readArchiveRecords(config: BookkeepingConfig): Promise<ArchiveRecords> {
  const records = Object.assign([] as ArchiveRecord[], { issues: [] as ArchiveReadIssue[] });
  async function scan(path: string): Promise<void> {
    let entries;
    try { entries = await readdir(join(config.wiki_root, path), { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const file = join(path, entry.name);
      if (entry.isSymbolicLink()) { records.issues.push({ file, line: null, date: null, reason: 'Archive symlink rejected' }); continue; }
      if (entry.isDirectory()) { await scan(file); continue; }
      if (!entry.isFile() || !/\.jsonl?$/.test(entry.name) || /^schema(?:[_.-]|$)/i.test(entry.name)) continue;
      let bytes: Buffer;
      try { const target = await readWikiTarget(config.wiki_root, file); if (target.bytes === null) throw new Error('Archive disappeared'); bytes = target.bytes; }
      catch (error) { records.issues.push({ file, line: null, date: null, reason: (error as Error).message }); continue; }
      const digest = sha(bytes);
      const lines = entry.name.endsWith('.jsonl') ? bytes.toString('utf8').split(/\r?\n/) : [bytes.toString('utf8')];
      for (let index = 0; index < lines.length; index++) {
        if (!lines[index].trim()) continue;
        try {
          const value = JSON.parse(lines[index]);
          for (const record of Array.isArray(value) ? value : value.records ?? value.entries ?? [value]) {
            if (!record || typeof record !== 'object') continue;
            if (record.schema_version !== 'daily-journal-jsonl-v1' && record.format !== 'daily-journal-archive-v2') continue;
            const date = typeof record.date === 'string' ? record.date : null;
            if (date === null || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { records.issues.push({ file, line: entry.name.endsWith('.jsonl') ? index + 1 : null, date, reason: 'Archive date is missing or invalid' }); continue; }
            records.push({ file, file_digest: digest, record });
          }
        } catch (error) { records.issues.push({ file, line: entry.name.endsWith('.jsonl') ? index + 1 : null, date: lines[index].match(/"date"\s*:\s*"(\d{4}-\d{2}-\d{2})"/)?.[1] ?? null, reason: (error as Error).message }); }
      }
    }
  }
  await scan(archiveFolder);
  return records;
}
