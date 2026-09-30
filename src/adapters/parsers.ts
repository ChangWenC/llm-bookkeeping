import type { BookkeepingConfig, SourceEvent } from "../contracts/types.ts";
import { event, hash } from "./common.ts";
export interface SessionIdentity {
  id: string | null;
  classification: SourceEvent["classification"];
  cwd: string | null;
  metadata: Record<string, unknown>;
}
export function sessionIdentity(
  provider: string,
  rows: any[],
): SessionIdentity {
  const meta =
    provider === "codex"
      ? rows.find((r) => r.type === "session_meta")?.payload
      : rows.find((r) => r.sessionId || r.session_id);
  const id =
    meta?.id ??
    meta?.session_id ??
    meta?.sessionId ??
    meta?.thread_id ??
    rows.find((r) => r.sessionId)?.sessionId ??
    null;
  const source = meta?.thread_source ?? meta?.source;
  const nested = typeof source === "object" && source !== null ? source : {};
  const sub =
    meta?.isSidechain === true ||
    meta?.parent_session_id ||
    meta?.parent_thread_id ||
    meta?.creator_agent_id ||
    meta?.subagent_id ||
    nested.subagent ||
    nested.sub_agent ||
    nested.parent_thread_id ||
    (typeof source === "string" && ["subagent", "sub_agent"].includes(source));
  const auto =
    meta?.automation_id ||
    meta?.scheduled_task_id ||
    meta?.is_automation === true ||
    nested.automation ||
    (typeof source === "string" &&
      ["automation", "scheduled"].includes(source));
  return {
    id: id == null ? null : String(id),
    classification: sub
      ? "subagent"
      : auto
        ? "automation"
        : meta
          ? "main"
          : "unknown",
    cwd: meta?.cwd ?? meta?.runtime_workspace_roots?.[0] ?? null,
    metadata: meta ?? {},
  };
}
export interface ParseState {
  lastTime?: unknown;
  cwd?: string;
  mirror?: {
    role: string;
    body_hash: string;
    time: string;
    type: string;
    message_id: string | null;
  };
}
export function parseSessionRow(
  provider: string,
  row: any,
  identity: SessionIdentity,
  locator: string,
  generation: string,
  offset: number,
  config: BookkeepingConfig,
  state: ParseState,
  account?: string,
): SourceEvent[] {
  if (
    identity.classification === "subagent" ||
    identity.classification === "automation" ||
    row.isSidechain === true ||
    row.automation_id ||
    row.parent_session_id
  )
    return [];
  if (!identity.id) return [];
  const result: SourceEvent[] = [];
  const envelope = row.payload ?? row;
  const p =
    row.type === "realtime_item" && envelope.item?.type === "transcript_segment"
      ? { ...envelope, ...envelope.item }
      : envelope;
  if (row.type === "turn_context") {
    state.cwd = p.cwd ?? state.cwd;
    return [];
  }
  const time = row.timestamp ?? p.timestamp ?? row.create_time;
  const add = (
    role: string,
    body: unknown,
    message: unknown,
    block: string,
    channel: string | null,
    kind = "message",
    context: Record<string, unknown> = {},
  ) => {
    if (typeof body !== "string" || !body.trim() || channel === "analysis")
      return;
    const e = event(
      {
        provider,
        account:
          account ??
          config.providers.find((x) => x.provider === provider)?.account_id ??
          "local",
        conversation: identity.id!,
        message: message == null ? null : String(message),
        block: message != null ? `${block}:${hash(body).slice(0, 16)}` : block,
        role,
        body,
        time,
        offset,
        locator,
        generation,
        channel,
        kind,
        classification: identity.classification,
        context: { cwd: state.cwd ?? identity.cwd, ...context },
      },
      config,
    );
    result.push(e);
  };
  if (provider === "codex") {
    if (row.type === "event_msg" && p.type === "user_message")
      add("user", p.message, p.id ?? p.message_id, "0", null);
    else if (row.type === "event_msg" && p.type === "agent_message")
      add(
        "assistant",
        p.message,
        p.id ?? p.message_id,
        "0",
        p.phase ?? "final",
      );
    else if (
      row.type === "response_item" &&
      p.type === "message" &&
      ["user", "assistant"].includes(p.role)
    ) {
      const content = Array.isArray(p.content) ? p.content : [];
      for (let i = 0; i < content.length; i++) {
        const b = content[i];
        if (["input_text", "output_text", "text"].includes(b.type))
          add(
            p.role,
            b.text,
            p.id ?? p.message_id,
            String(i),
            p.phase ?? p.channel ?? (p.role === "assistant" ? "final" : null),
          );
      }
    } else if (
      ["transcript_segment", "realtime_transcript"].includes(row.type) ||
      ["transcript_segment", "realtime_transcript"].includes(p.type) ||
      (row.type === "realtime_item" && p.type === "transcript_segment")
    ) {
      const sid =
        p.session_id ?? p.sessionId ?? row.session_id ?? row.sessionId;
      const mid = p.id ?? p.message_id ?? p.segment_id ?? row.id;
      if (p.role === "user" && mid && sid && String(sid) === identity.id)
        add(
          "user",
          p.text ?? p.transcript,
          mid,
          String(p.block_id ?? "0"),
          "voice",
          "voice_transcript",
        );
    } else if (row.type === "event_msg" && p.type === "final_answer")
      add("assistant", p.text ?? p.message, p.id ?? p.message_id, "0", "final");
    // Native event/response mirror is proven only by adjacent physical representations,
    // same wire timestamp, role, and complete body. Same-form repeated text survives.
    if (result.length === 1) {
      const e = result[0];
      const kind = row.type;
      const prev = state.mirror;
      if (
        prev &&
        prev.type !== kind &&
        ["event_msg", "response_item"].includes(prev.type) &&
        ["event_msg", "response_item"].includes(kind) &&
        prev.role === e.role &&
        prev.body_hash === hash(e.body!) &&
        prev.time === String(time) &&
        time != null &&
        (!prev.message_id ||
          !e.source.message_id ||
          prev.message_id === e.source.message_id)
      ) {
        result.length = 0;
        state.mirror = undefined;
      } else
        state.mirror = {
          role: e.role,
          body_hash: hash(e.body!),
          time: String(time),
          type: kind,
          message_id: e.source.message_id,
        };
    } else state.mirror = undefined;
  } else {
    const m = row.message ?? p.message;
    const role = m?.role ?? row.type;
    if (!["user", "assistant"].includes(role) || row.isMeta === true) return [];
    const mid = m?.id ?? row.uuid ?? row.id;
    const content = m?.content ?? row.content;
    const blocks =
      typeof content === "string"
        ? [{ type: "text", text: content }]
        : Array.isArray(content)
          ? content
          : [];
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.type === "text")
        add(
          role,
          b.text,
          mid,
          `${i}:${hash(b.text ?? "").slice(0, 16)}`,
          role === "assistant" ? "final" : null,
          "message",
          {
            // A parsed user record is complete independently of assistant generation.
            turn_complete: role === "user" || m?.stop_reason != null,
            stop_reason: m?.stop_reason ?? null,
          },
        );
    }
  }
  return result;
}
