/** This validates native-ID shape only. A caller must supply explicit native evidence. */
export function isNativeWechatContactId(value: unknown): value is string {
    if (typeof value !== 'string' || !value || /\s/.test(value) || /^\d+$/.test(value) || value.endsWith('@chatroom')) return false;
    const lower = value.toLowerCase();
    return !lower.startsWith('gh_') && !['filehelper', 'systemholder', 'openimholder', 'brandservicesessionholder'].includes(lower);
}
