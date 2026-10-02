import type { ProviderConfig } from "../contracts/types.ts";
/** Pure metadata admission. Call before obtaining or parsing any chat bodies. */
export function wechatScopeError(options: Record<string, unknown>): string | null {
  const list = options.group_allowlist;
  if (list !== undefined && (!Array.isArray(list) || list.some(id => typeof id !== 'string' || !id.trim() || id !== id.trim())))
    return 'wechat_group_allowlist_invalid';
  const types = options.chat_types;
  if (types !== undefined && (types === null || typeof types !== 'object' || Array.isArray(types)))
    return 'wechat_chat_types_invalid';
  return null;
}
export function wechatConversationScope(
  options: Record<string, unknown>, conversationId: string, conversationType?: string | boolean,
): { admitted: boolean; is_group: boolean; reason: string | null } {
  const configuredTypes = options.chat_types as Record<string, unknown> | undefined;
  if (conversationType === undefined && configuredTypes && typeof configuredTypes === 'object' && !Array.isArray(configuredTypes) && typeof configuredTypes[conversationId] === 'string')
    conversationType = configuredTypes[conversationId] as string;
  const is_group = (Array.isArray(options.group_allowlist) && options.group_allowlist.includes(conversationId)) || conversationId.endsWith('@chatroom') || conversationType === true || conversationType === 'group' || conversationType === 'unknown';
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
  if (options.group_allowlist !== undefined && !is_group && conversationType !== 'private' && conversationType !== false)
    return { admitted: false, is_group, reason: 'wechat_conversation_type_unknown' };
  return { admitted: true, is_group, reason: null };
}

/** A configured account policy cannot be bypassed by claiming another import account. */
export function wechatImportScope(
  providers: ProviderConfig[], accountId: string, conversationId: string, conversationType?: string,
): ReturnType<typeof wechatConversationScope> {
  const configured = providers.filter(source => source.provider === 'wechat');
  const matching = configured.filter(source => source.account_id === accountId);
  if (configured.length && matching.length !== 1)
    return { admitted: false, is_group: conversationId.endsWith('@chatroom') || conversationType === 'group' || conversationType === 'unknown', reason: 'wechat_import_account_scope_missing_or_ambiguous' };
  return wechatConversationScope(matching[0]?.options ?? {}, conversationId, conversationType);
}
