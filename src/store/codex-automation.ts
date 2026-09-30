import type { RawFragment, SourceEvent } from '../contracts/types.ts';
import { digest } from '../analytics/serialization.ts';

interface RawMessage { turn_id: string | null; conflict: boolean; offset: number }
export interface ClassificationCorrection { event: SourceEvent; reason: string | null }

// This reader intentionally does not infer a turn from timestamps or from an
// incoming context label. The immutable original JSONL row is the authority.
function rawMessage(event: SourceEvent, fragment: RawFragment | null): RawMessage | null {
    if (!fragment || !event.body || event.source.provider !== 'codex') return null;
    const bytes = Buffer.from(fragment.bytes_base64, 'base64');
    if (digest(bytes) !== fragment.sha256) return null;
    const offset = Number(event.physical_order.split(':')[0]);
    if (!Number.isSafeInteger(offset) || offset < 0) return null;
    const prefix = `source:codex:${event.source.account_id}:${event.source.conversation_id}:${event.generation}:${offset}:`;
    if (fragment.locator !== prefix + (offset + bytes.length)) return null;
    try {
        const row = JSON.parse(bytes.toString('utf8'));
        const p = row.payload ?? row;
        let role: string, body: unknown;
        if (row.type === 'response_item' && p.type === 'message') {
            role = p.role;
            if (role === 'user' && (!Array.isArray(p.content) || p.content.filter((block: any) => ['input_text', 'output_text', 'text'].includes(block?.type)).length !== 1)) return null;
            const block = Number(event.source.block_id?.split(':')[0] ?? 0);
            const content = p.content?.[block];
            if (!['input_text', 'output_text', 'text'].includes(content?.type)) return null;
            body = content.text;
        } else if (row.type === 'event_msg' && ['user_message', 'agent_message', 'final_answer'].includes(p.type)) {
            role = p.type === 'user_message' ? 'user' : 'assistant';
            body = p.type === 'final_answer' ? p.text ?? p.message : p.message;
        } else return null;
        if (role !== event.role || body !== event.body) return null;
        const message = p.id ?? p.message_id ?? null;
        if (event.source.message_id !== null && String(message) !== event.source.message_id) return null;
        const ids = [p.internal_chat_message_metadata_passthrough?.turn_id,
            row.metadata?.retained_source?.id?.turn_id, p.turn_id, row.turn_id].filter(id => id != null);
        const conflict = ids.some(id => typeof id !== 'string' || !id.trim()) || new Set(ids).size > 1;
        return { turn_id: !conflict && ids.length ? ids[0] : null, conflict, offset };
    } catch { return null; }
}

function heartbeat(body: string | null): string | null {
    const match = body?.trim().match(/^<heartbeat>\s*<automation_id>([^<>\r\n]+)<\/automation_id>\s*<current_time_iso>([^<>\r\n]+)<\/current_time_iso>\s*<instructions>([\s\S]*)<\/instructions>\s*<\/heartbeat>$/);
    if (!match || !match[1].trim() || /<\/?(?:heartbeat|instructions)>/.test(match[3])) return null;
    const time = match[2].trim();
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(time) || !Number.isFinite(Date.parse(time))
        || new Date(time).toISOString().slice(0, 19) !== time.slice(0, 19)) return null;
    return match[1].trim();
}
const suspicious = (event: SourceEvent) => event.role === 'user' && event.body?.trimStart().startsWith('<heartbeat>');

export function correctCodexClassification(event: SourceEvent, fragment: RawFragment | null,
    anchor: SourceEvent | null, anchorFragment: RawFragment | null): ClassificationCorrection {
    if (event.source.provider !== 'codex' || !['main', 'unknown'].includes(event.classification))
        return { event, reason: null };
    if (anchor && (anchor.role !== 'user' || anchor.source.provider !== event.source.provider
        || anchor.source.account_id !== event.source.account_id || anchor.source.conversation_id !== event.source.conversation_id
        || anchor.locator !== event.locator || anchor.generation !== event.generation || anchor.physical_order >= event.physical_order)) anchor = null;
    const raw = rawMessage(event, fragment);
    const hold = (reason: string): ClassificationCorrection => ({
        event: { ...event, classification: 'unknown' }, reason,
    });
    if (raw?.conflict) return hold('Codex source turn IDs disagree');
    let packet = event.role === 'user' && raw ? heartbeat(event.body) : null;
    let source = event;
    let sourceRaw = raw;
    if (event.role === 'assistant' && anchor && rawMessage(anchor, anchorFragment)?.conflict)
        return hold('Codex assistant source boundary has conflicting turn IDs');
    if (event.role === 'assistant' && anchor && (heartbeat(anchor.body) || suspicious(anchor))) {
        // The caller supplies the nearest earlier user in the exact same source
        // generation. A next human input ends the old automation boundary.
        sourceRaw = rawMessage(anchor, anchorFragment);
        packet = sourceRaw && !sourceRaw.conflict ? heartbeat(anchor.body) : null;
        source = anchor;
        if (!packet || !raw || !raw.turn_id || !sourceRaw?.turn_id || raw.turn_id !== sourceRaw.turn_id)
            return hold('Codex heartbeat assistant lacks a verified matching source turn');
    }
    if (!packet) return suspicious(event) ? hold('Codex heartbeat envelope is incomplete or lacks its original row') : { event, reason: null };
    if (!sourceRaw || sourceRaw.conflict) return hold('Codex heartbeat source turn is unresolved');
    return { event: { ...event, classification: 'automation', context: { ...event.context,
        automation_origin: { schema_version: 1, kind: 'codex_heartbeat', automation_id: packet,
            anchor_event_id: source.event_id, anchor_offset: sourceRaw.offset, turn_id: sourceRaw.turn_id },
    } }, reason: null };
}
