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
export interface WechatSender {
  sender_id: string | null;
  sender_wxid: string | null;
  role: string;
}
/** A numeric value cannot establish stable WeChat identity, regardless of the input field name. */
export function stableWechatId(value: unknown): value is string {
  return typeof value === 'string' && !!value && value.trim() === value && Number.isNaN(Number(value));
}
/** Numeric query IDs are chat-local. Explicit sender flags are usable only after their semantics were verified. */
export function resolveWechatSender(
  row: Record<string, unknown>, options: Record<string, unknown>, chat: string,
  platformSender = false,
): WechatSender {
  const ids = Array.isArray(options.self_ids) ? options.self_ids.filter(stableWechatId) : [];
  const verified = options.identity_verified === true;
  const stable = row.sender_wxid ?? (platformSender ? row.sender_id ?? row.sender : null);
  if (stableWechatId(stable)) {
    const sender_id = stable;
    return { sender_id, sender_wxid: stable, role: verified && ids.length ? ids.includes(sender_id) ? 'user' : 'other' : 'unknown' };
  }
  const localMap = options.self_ids_by_chat as Record<string, unknown> | undefined;
  const locals = Array.isArray(localMap?.[chat]) ? (localMap![chat] as unknown[]).map(String) : [];
  const numericStable = stable != null && !stableWechatId(stable) && (typeof stable === "number" || typeof stable === "string") ? String(stable) : null;
  const local = row.real_sender_id == null ? numericStable : String(row.real_sender_id);
  const flag = verified && options.sender_is_self_verified === true && typeof row.sender_is_self === 'boolean'
    ? row.sender_is_self : null;
  const self = flag ?? (verified && local && locals.length ? locals.includes(local) : null);
  if (self !== null) {
    // A stable owner makes changing query-local numeric representations immaterial.
    return { sender_id: self && ids.length === 1 ? ids[0] : self ? null : local,
      sender_wxid: self && ids.length === 1 ? ids[0] : null, role: self ? 'user' : 'other' };
  }
  if (selfAlias(row, options)) return { sender_id: ids.length === 1 ? ids[0] : null, sender_wxid: ids.length === 1 ? ids[0] : null, role: 'user' };
  // Legacy exports may explicitly name their owner ID without claiming a display nickname is a stable contact ID.
  if (verified && typeof row.sender === 'string' && ids.includes(row.sender)) return { sender_id: row.sender, sender_wxid: row.sender, role: 'user' };
  return { sender_id: local, sender_wxid: null, role: 'unknown' };
}
