import { basename } from 'node:path';
import type { BookkeepingConfig } from '../contracts/types.ts';

export function frontmatter(bytes: Uint8Array | null): string {
  if (!bytes) return '';
  return Buffer.from(bytes).toString('utf8').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? '';
}
/** Read a single frontmatter text scalar with YAML quoting/comment semantics.
 * This deliberately does not interpret nested objects or build a YAML schema. */
export function frontmatterScalar(bytes: Uint8Array | null, key: string): string | null {
  if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(key)) throw new Error('Invalid frontmatter scalar key');
  const raw = frontmatter(bytes).match(new RegExp(`^[ \\t]*(?:${key}|'${key}'|"${key}")[ \\t]*:[ \\t]*(.*)$`, 'm'))?.[1]?.trim();
  if (raw === undefined) return null;
  if (raw.startsWith("'")) return raw.match(/^'((?:[^']|'')*)'[ \t]*(?:#.*)?$/)?.[1]?.replaceAll("''", "'") ?? raw;
  if (raw.startsWith('"')) {
    const quoted = raw.match(/^("(?:[^"\\]|\\.)*")[ \t]*(?:#.*)?$/)?.[1];
    if (!quoted) return raw;
    try { return JSON.parse(quoted.replace(/\\x([0-9a-fA-F]{2})/g, '\\u00$1')); } catch { return raw; }
  }
  return raw.replace(/[ \t]+#.*$/, '').trim();
}
export function retainedJournal(bytes: Uint8Array | null): boolean {
  const header = frontmatter(bytes);
  if (['pinned', 'intentional-journal', 'intentional_journal'].some(key => frontmatterScalar(bytes, key) === 'true') || frontmatterScalar(bytes, 'retention') === 'pinned') return true;
  const classification = frontmatterScalar(bytes, 'journal_class');
  if (classification !== null && !['daily-active', 'daily-reconstructed', 'daily-journal'].includes(classification)) return true;
  const explicitType = frontmatterScalar(bytes, 'type');
  if (explicitType !== null && !['journal', 'daily-journal'].includes(explicitType)) return true;
  const tags = header.match(/^tags:\s*(.*(?:\n[ \t]+[^\n]*)*)/m)?.[1] ?? '';
  return /(?:^|[\s,\["'])\b(?:pinned-daily|intentional-journal)\b(?:$|[\s,\]"'])/.test(tags);
}
export function canonicalDailyDate(path: string, bytes: Uint8Array | null = null): string | null {
  const normalized = path.replaceAll('\\', '/');
  if (!normalized.startsWith('wiki/personal/journals/') || normalized.includes('/reviews/')) return null;
  const match = basename(normalized).match(/^日记_(\d{4})_(\d{2})_(\d{2})\.md$/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  // Explicit daily metadata permits older canonical stems, but topical/month/year
  // pages are never inferred as daily from their date alone.
  const header = frontmatter(bytes);
  const dailyType = /^type:\s*["']?daily-journal["']?\s*$/m.test(header);
  const journalType = /^type:\s*["']?journal["']?\s*$/m.test(header);
  const tags = header.match(/^tags:\s*(.*(?:\n[ \t]+[^\n]*)*)/m)?.[1] ?? '';
  if (!dailyType && !(journalType && /(?:^|[\s,\["'])daily-journal(?:$|[\s,\]"'])/.test(tags))) return null;
  return header.match(/^date:\s*["']?(\d{4}-\d{2}-\d{2})["']?\s*$/m)?.[1] ?? null;
}
export function retainedWindowStart(config: BookkeepingConfig, instant: Date): string {
  let zone = config.journal_timezone;
  for (const entry of config.journal_timezone_timeline) if (Date.parse(entry.effective_from) <= instant.getTime()) zone = entry.timezone;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit' }).formatToParts(instant);
  const year = Number(parts.find(part => part.type === 'year')!.value), month = Number(parts.find(part => part.type === 'month')!.value);
  return new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 10);
}
