/** Display aliases are explicit verified fallback evidence; native sender IDs always take precedence. */
const normalized = (value: string): string => value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
export function verifiedAliases(options: Record<string, unknown>, key: 'self_aliases' | 'mention_aliases'): string[] {
  return options.identity_verified === true && options.aliases_verified === true && Array.isArray(options[key])
    ? options[key].filter((value): value is string => typeof value === 'string' && !!value.trim()).map(normalized) : [];
}
export function selfAlias(row: Record<string, unknown>, options: Record<string, unknown>): boolean {
  if (row.sender_wxid != null || row.real_sender_id != null || row.sender_id != null) return false;
  const display = row.sender_name ?? row.sender_display_name ?? row.sender;
  return typeof display === 'string' && verifiedAliases(options, 'self_aliases').includes(normalized(display));
}
export function selfMention(row: Record<string, unknown>, body: string, options: Record<string, unknown>): boolean {
  if (typeof row.is_mentioned === 'boolean') return row.is_mentioned;
  const text = normalized(body);
  return verifiedAliases(options, 'mention_aliases').some(alias => {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`@${escaped}(?=$|[\\s,，。:：;；!?！？])`, 'u').test(text);
  });
}
