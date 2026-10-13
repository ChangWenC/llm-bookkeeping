import { sha } from '../archive/records.ts';
import type { MonthlyReviewResult } from '../../contracts/types.ts';
/** Only a previously unedited generated block can be replaced. */
export function updateManagedBlock(content: string, name: string, month: string, body: string): string {
  const prefix = `<!-- bookkeeping:${name}:start`, endMarker = `<!-- bookkeeping:${name}:end -->`;
  const opening = new RegExp(`<!-- bookkeeping:${name}:start month=(\\d{4}-\\d{2}) digest=([a-f\\d]{64}) -->\\n`, 'g');
  const matches = [...content.matchAll(opening)];
  if (content.split(prefix).length - 1 !== matches.length || matches.length > 1 || content.split(endMarker).length - 1 !== matches.length || matches.some(match => match[1] !== month)) throw new Error('Managed monthly markers are missing, duplicated or malformed');
  const block = `${prefix} month=${month} digest=${sha(body)} -->\n${body}${endMarker}`;
  if (!matches.length) return `${content}${content.endsWith('\n') ? '\n' : '\n\n'}${block}\n`;
  const match = matches[0], begin = match.index!, bodyStart = begin + match[0].length, end = content.indexOf(endMarker, bodyStart);
  if (end < bodyStart || sha(content.slice(bodyStart, end)) !== match[2]) throw new Error('Manual edits inside managed monthly region retained');
  return content.slice(0, begin) + block + content.slice(end + endMarker.length);
}
export function safeRegionText(text: string): string { return text.replaceAll('<!--', '&lt;!--').replaceAll('-->', '--&gt;'); }
export function monthlyReviewBody(review: MonthlyReviewResult): string {
  const coverage = review.coverage_status === 'complete' ? '覆盖：已采集并审阅的范围完整。' : review.coverage_status === 'partial' ? '覆盖：仍有采集或审阅缺口，不能据此判断整月无活动。' : '覆盖：范围未知，仍待补全。';
  return `## 月回顾摘要\n\n${safeRegionText(review.summary)}\n\n${coverage}\n${review.supplement_text ? `\n${safeRegionText(review.supplement_text)}\n` : ''}\n`;
}
/** Full outside bytes and old generated digest must survive a managed update. */
export function isManagedMonthlyChange(oldText: string, newText: string, name: 'monthly-review' | 'monthly-supplement', month: string): boolean {
  const opening = new RegExp(`<!-- bookkeeping:${name}:start month=${month} digest=([a-f0-9]{64}) -->\\n`, 'g');
  const matches = [...newText.matchAll(opening)], endMarker = `<!-- bookkeeping:${name}:end -->`;
  if (matches.length !== 1 || newText.split(`<!-- bookkeeping:${name}:start`).length !== 2 || newText.split(endMarker).length !== 2) return false;
  const begin = matches[0].index! + matches[0][0].length, end = newText.indexOf(endMarker, begin), body = newText.slice(begin, end);
  if (end < begin || sha(body) !== matches[0][1]) return false;
  try { return updateManagedBlock(oldText, name, month, body) === newText; } catch { return false; }
}
