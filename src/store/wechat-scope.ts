import { openSync, readSync, closeSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { wechatScopeError, wechatConversationScope } from '../adapters/wechat-policy.ts';
import { isNativeWechatContactId } from './wechat-identity.ts';
import type { BookkeepingConfig, SourceEvent, WechatPersonMapping } from '../contracts/types.ts';

/** A metadata-only gate. SQL invokes this before selecting any body or LIMIT. */
export class WechatReviewScope {
    readonly config?: BookkeepingConfig;
    constructor(config?: BookkeepingConfig) { this.config = config; }
    validate(): void {
        for (const provider of this.config?.providers.filter(p => p.provider === 'wechat') ?? []) {
            const error = wechatScopeError(provider.options);
            if (error) throw new Error(error + '; WeChat review remains pending');
        }
    }
    allowed(provider: unknown, account: unknown, conversation: unknown, group: unknown): boolean {
        if (provider !== 'wechat') return true;
        const entries = this.config?.providers.filter(p => p.provider === 'wechat') ?? [];
        if (!entries.length) return true;
        const configured = entries.find(p => p.account_id === account);
        if (!configured?.enabled) return false;
        return wechatConversationScope(configured.options, String(conversation ?? ''), group === 1 ? true : typeof group === 'string' || typeof group === 'boolean' ? group : undefined).admitted;
    }
    pendingReason(provider: unknown, account: unknown, conversation: unknown, type: unknown, role: unknown, verified: unknown, sender: unknown): string | null {
        if (provider !== 'wechat') return null;
        const entries = this.config?.providers.filter(p => p.provider === 'wechat') ?? [];
        const configured = entries.find(p => p.account_id === account);
        if (!configured) return entries.length ? 'WeChat account scope unknown; local review remains pending' : null;
        if (!configured.enabled) return null;
        const scope = wechatConversationScope(configured.options, String(conversation ?? ''), typeof type === 'string' || typeof type === 'boolean' ? type : undefined);
        if (scope.reason === 'wechat_conversation_type_unknown') return 'WeChat conversation type unknown; local review remains pending';
        if (scope.admitted && (role === 'unknown' || verified !== 1 || sender == null)) return 'WeChat sender identity unknown; local review remains pending';
        return null;
    }
    excludesFactGroup(provider: unknown, account: unknown, conversation: unknown, type: unknown): boolean {
        if (provider !== 'wechat' || typeof conversation !== 'string') return false;
        const configured = this.config?.providers.find(p => p.provider === 'wechat' && p.account_id === account);
        if (!configured) return false;
        const chatTypes = configured.options.chat_types;
        const resolved = type ?? (chatTypes && typeof chatTypes === 'object' && !Array.isArray(chatTypes) ? (chatTypes as Record<string, unknown>)[conversation] : undefined);
        const knownGroup = conversation.endsWith('@chatroom') || resolved === true || resolved === 'group'
            || (Array.isArray(configured.options.group_allowlist) && configured.options.group_allowlist.includes(conversation));
        if (!knownGroup) return false;
        return !configured.enabled || !wechatConversationScope(configured.options, conversation, typeof resolved === 'string' || typeof resolved === 'boolean' ? resolved : undefined).admitted;
    }
    isGroupEvent(event: SourceEvent): boolean {
        const configured = this.config?.providers.find(p => p.provider === event.source.provider && p.account_id === event.source.account_id);
        const type = typeof event.context.is_group === 'boolean' ? event.context.is_group : event.context.conversation_type ?? event.context.chat_type;
        return wechatConversationScope(configured?.options ?? {}, event.source.conversation_id ?? '', typeof type === 'string' || typeof type === 'boolean' ? type : undefined).is_group;
    }
    eventAllowed(event: SourceEvent): boolean {
        return this.allowed(event.source.provider, event.source.account_id, event.source.conversation_id, typeof event.context.is_group === 'boolean' ? event.context.is_group : event.context.conversation_type ?? event.context.chat_type);
    }
    registryGaps(): string[] {
        const gaps: string[] = [];
        for (const provider of this.config?.providers.filter(p => p.provider === 'wechat') ?? []) {
            const entries = provider.options.private_person_registry;
            if (entries === undefined) continue;
            if (!Array.isArray(entries)) { gaps.push('WeChat private person registry malformed; no person attribution applied'); continue; }
            const counts = new Map<string, number>();
            for (const entry of entries) if (entry && typeof entry.wxid === 'string') counts.set(entry.wxid, (counts.get(entry.wxid) ?? 0) + 1);
            if (entries.some(entry => !validMapping(entry) || !this.personalPage(entry.wiki_path) || counts.get(entry.wxid)! > 1))
                gaps.push('Unverified, unsafe or ambiguous WeChat person mapping remains pending; no fuzzy attribution applied');
        }
        return gaps;
    }
    private personalPage(path: string): boolean {
        if (!this.config || typeof path !== 'string') return false;
        let fd: number | undefined;
        try {
            const root = realpathSync(this.config.wiki_root), target = realpathSync(join(root, path));
            if (!target.startsWith(resolve(root, 'wiki/personal/people') + sep)) return false;
            fd = openSync(target, 'r');
            const bytes = Buffer.alloc(8192), count = readSync(fd, bytes, 0, bytes.length, 0);
            const header = bytes.subarray(0, count).toString('utf8').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
            return !!header && /^type:\s*["']?personal-person["']?\s*$/m.test(header);
        } catch { return false; }
        finally { if (fd !== undefined) closeSync(fd); }
    }
    enrich(event: SourceEvent): SourceEvent {
        if (event.source.provider !== 'wechat' || event.context.identity_verified !== true) return event;
        const configured = this.config?.providers.find(p => p.provider === 'wechat' && p.account_id === event.source.account_id);
        const entries = configured?.options.private_person_registry;
        if (!configured?.enabled || !Array.isArray(entries)) return event;
        const mappingFor = (native: unknown): WechatPersonMapping | null => {
            if (!isNativeWechatContactId(native) || (Array.isArray(configured.options.group_allowlist) && configured.options.group_allowlist.includes(native))) return null;
            const chatTypes = configured.options.chat_types;
            if (chatTypes && typeof chatTypes === 'object' && !Array.isArray(chatTypes) && ['group', true].includes((chatTypes as Record<string, unknown>)[native] as string | boolean)) return null;
            const matches = entries.filter(entry => entry?.wxid === native);
            return matches.length === 1 && validMapping(matches[0]) && this.personalPage(matches[0].wiki_path) ? matches[0] : null;
        };
        const person = (mapping: WechatPersonMapping) => ({ schema_version: 1, wxid: mapping.wxid, display_name: mapping.display_name, wiki_path: mapping.wiki_path, relationship: mapping.relationship, verified: true });
        const conversation = event.source.conversation_id;
        const configuredTypes = configured.options.chat_types;
        const type = typeof event.context.is_group === 'boolean' ? event.context.is_group : event.context.conversation_type ?? event.context.chat_type
            ?? (configuredTypes && typeof configuredTypes === 'object' && !Array.isArray(configuredTypes) && conversation ? (configuredTypes as Record<string, unknown>)[conversation] : undefined);
        const scope = wechatConversationScope(configured.options, conversation ?? '', typeof type === 'string' || typeof type === 'boolean' ? type : undefined);
        const privateConversation = scope.admitted && !scope.is_group && (type === false || type === 'private') && conversation !== 'filehelper';
        const context = { ...event.context };
        // The counterpart identifies the private conversation, never its author.
        const counterpart = privateConversation ? mappingFor(conversation) : null;
        if (counterpart) context.conversation_person_context = person(counterpart);
        // A native sender field can contain a custom username. Legacy sender_id
        // needs a native wxid or exact verified private counterpart evidence.
        if (event.role !== 'unknown') {
            const nativeSender = event.context.sender_wxid;
            const legacySender = event.context.sender_id;
            const sender = nativeSender !== undefined ? nativeSender
                : typeof legacySender === 'string' && (legacySender.startsWith('wxid_') || (event.role === 'other' && privateConversation && legacySender === conversation)) ? legacySender : null;
            const mapping = mappingFor(sender);
            if (mapping) context.person_context = person(mapping);
        }
        return { ...event, context };
    }
}
function validMapping(entry: any): entry is WechatPersonMapping {
    return entry?.schema_version === 1 && entry.verified === true && isNativeWechatContactId(entry.wxid) && typeof entry.display_name === 'string' && entry.display_name.trim().length > 0
        && typeof entry.relationship === 'string' && entry.relationship.trim().length > 0 && typeof entry.wiki_path === 'string'
        && /^wiki\/personal\/people\/[^/]+\.md$/.test(entry.wiki_path) && !entry.wiki_path.includes('..');
}
export const conversationTypeSql = (json: string) => `CASE WHEN json_extract(${json},'$.context.is_group')=1 THEN 'group' WHEN json_extract(${json},'$.context.is_group')=0 THEN 'private' ELSE COALESCE(json_extract(${json},'$.context.conversation_type'),json_extract(${json},'$.context.chat_type')) END`;
export const scopeValueSql = (json: string) => `review_scope_allowed(json_extract(${json},'$.source.provider'),json_extract(${json},'$.source.account_id'),json_extract(${json},'$.source.conversation_id'),${conversationTypeSql(json)})=1`;
export const scopeSql = (alias = 'events') => scopeValueSql(alias + '.json');
export const senderSql = (alias = 'events') => `(json_extract(${alias}.json,'$.source.provider')!='wechat' OR (json_extract(${alias}.json,'$.role')!='unknown' AND json_extract(${alias}.json,'$.context.identity_verified')=1 AND json_extract(${alias}.json,'$.context.sender_id') IS NOT NULL))`;

export const pendingScopeSql = (alias = 'events') => `review_scope_pending(json_extract(${alias}.json,'$.source.provider'),json_extract(${alias}.json,'$.source.account_id'),json_extract(${alias}.json,'$.source.conversation_id'),${conversationTypeSql(alias + '.json')},json_extract(${alias}.json,'$.role'),json_extract(${alias}.json,'$.context.identity_verified'),json_extract(${alias}.json,'$.context.sender_id'))`;
