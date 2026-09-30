import { parseTime } from "./common.ts";

export interface HeartbeatPacket {
  automation_id: string;
  current_time_iso: string;
}

/** The complete app envelope is a source marker; a mention or quoted fragment is not. */
export function parseHeartbeatPacket(body: string): HeartbeatPacket | null {
  const match = body.trim().match(
    /^<heartbeat>\s*<automation_id>([^<>\r\n]+)<\/automation_id>\s*<current_time_iso>([^<>\r\n]+)<\/current_time_iso>\s*<instructions>([\s\S]*)<\/instructions>\s*<\/heartbeat>$/,
  );
  if (!match) return null;
  const automation_id = match[1].trim();
  const current_time_iso = match[2].trim();
  if (!automation_id || /<\/?(?:heartbeat|instructions)>/.test(match[3]) ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(current_time_iso) ||
      !parseTime(current_time_iso).utc) return null;
  return { automation_id, current_time_iso };
}

export interface AutomationOrigin {
  schema_version: 1;
  kind: "codex_heartbeat";
  automation_id: string;
  anchor_event_id: string;
  anchor_offset: number;
  turn_id: string | null;
}

export interface CodexTurnOrigin {
  schema_version: 1;
  classification: "main" | "automation" | "unknown";
  turn_id: string | null;
  automation_origin?: AutomationOrigin;
}

export function codexTurnId(row: any): { id: string | null; conflict: boolean } {
  const payload = row.payload ?? row;
  const ids = [
    payload.internal_chat_message_metadata_passthrough?.turn_id,
    row.metadata?.retained_source?.id?.turn_id,
    payload.turn_id,
    row.turn_id,
  ].filter(value => value != null);
  if (ids.some(value => typeof value !== "string" || !value.trim()))
    return { id: null, conflict: true };
  const distinct = new Set<string>(ids);
  return { id: distinct.size === 1 ? ids[0] : null, conflict: distinct.size > 1 };
}

export function codexUserBodies(row: any, payload: any, session: string): unknown[] | null {
  if (row.type === "event_msg" && payload.type === "user_message")
    return [payload.message];
  if (row.type === "response_item" && payload.type === "message" && payload.role === "user")
    return (Array.isArray(payload.content) ? payload.content : [])
      .filter((block: any) => ["input_text", "text"].includes(block.type))
      .map((block: any) => block.text);
  const transcript = ["transcript_segment", "realtime_transcript"].includes(payload.type ?? row.type);
  const message = payload.id ?? payload.message_id ?? payload.segment_id ?? row.id;
  const sourceSession = payload.session_id ?? payload.sessionId ?? row.session_id ?? row.sessionId;
  return transcript && payload.role === "user" && message && String(sourceSession) === session
    ? [payload.text ?? payload.transcript] : null;
}
