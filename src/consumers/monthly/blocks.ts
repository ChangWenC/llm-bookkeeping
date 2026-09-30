import { sha } from '../archive/records.ts';
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
