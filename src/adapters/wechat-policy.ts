/** Pure metadata admission. Call before obtaining or parsing any chat bodies. */
export function wechatScopeError(options: Record<string, unknown>): string | null {
  const list = options.group_allowlist;
  if (list !== undefined && (!Array.isArray(list) || list.some(id => typeof id !== 'string' || !id.trim() || id !== id.trim())))
    return 'wechat_group_allowlist_invalid';
  return null;
}
export function wechatConversationScope(
  options: Record<string, unknown>, conversationId: string, conversationType?: string | boolean,
): { admitted: boolean; is_group: boolean; reason: string | null } {
  const is_group = conversationId.endsWith('@chatroom') || conversationType === true || conversationType === 'group' || conversationType === 'unknown';
  const error = wechatScopeError(options);
  if (error) return { admitted: false, is_group, reason: error };
  const service = conversationId === 'systemholder' || conversationId.toLowerCase() === 'openimholder'
    || conversationId === 'brandservicesessionholder' || conversationId.startsWith('gh_') || conversationType === 'official_account' || conversationType === 'service';
  if (service) return { admitted: false, is_group, reason: 'wechat_service_chat_excluded' };
  if (Array.isArray(options.ignored_chats) && options.ignored_chats.includes(conversationId))
    return { admitted: false, is_group, reason: 'wechat_ignored_chat_excluded' };
  if (conversationId === 'filehelper') return { admitted: true, is_group: false, reason: null };
  if (is_group && Array.isArray(options.group_allowlist) && !options.group_allowlist.includes(conversationId))
    return { admitted: false, is_group, reason: 'wechat_group_not_allowlisted' };
  return { admitted: true, is_group, reason: null };
}
