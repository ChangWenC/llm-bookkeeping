import { basename } from 'node:path';
import type { BookkeepingConfig } from '../contracts/types.ts';

export function frontmatter(bytes: Uint8Array | null): string {
  if (!bytes) return '';
  return Buffer.from(bytes).toString('utf8').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? '';
}
export function retainedJournal(bytes: Uint8Array | null): boolean {
  const header = frontmatter(bytes);
  if (/^\s*(?:pinned:\s*true|retention:\s*["']?pinned["']?|intentional-journal:\s*true|intentional_journal:\s*true)\s*$/m.test(header)) return true;
  if (/^\s*journal_class:\s*["']?(?:pinned-daily|intentional-journal)["']?\s*$/m.test(header)) return true;
  const classification = header.match(/^\s*journal_class:\s*["']?([^"'\r\n]*?)["']?\s*$/m)?.[1]?.trim();
  if (classification !== undefined && classification !== 'daily-journal') return true;
  const explicitType = header.match(/^\s*type:\s*["']?([^"'\r\n]*?)["']?\s*$/m)?.[1]?.trim();
  if (explicitType !== undefined && !['journal', 'daily-journal'].includes(explicitType)) return true;
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
