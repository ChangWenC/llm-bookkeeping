import type {
  BookkeepingConfig,
  SourceEvent,
  CoverageGap,
} from "../contracts/types.ts";
import { event, gap, hash, parseLossless } from "./common.ts";
import { wechatImportScope } from "./wechat-policy.ts";
import { resolveWechatSender, selfMention, verifiedAliases } from "./wechat-identity.ts";
export interface ImportMetadata {
  account_id: string;
  conversation_id: string;
  owner_id?: string;
  conversation_type?: 'private'|'group'|'unknown';
  self_ids?: string[];
  self_aliases?: string[];
  mention_aliases?: string[];
  aliases_verified?: boolean;
  self_ids_by_chat?: Record<string, string[]>;
  sender_is_self_verified?: boolean;
  source_timezone?: string;
  locator: string;
  provider?: string;
  known_range?: { from: string; to: string };
  coverage_verified?: boolean;
  identity_verified?: boolean;
}
export interface ParsedImport {
  events: SourceEvent[];
  gaps: CoverageGap[];
  members: Record<string, unknown>[];
  metadata: Record<string, unknown>;
}
/** Original export bytes must be persisted by the importing coordinator. No filenames infer identity. */
export function parseChatExport(
  bytes: Buffer | string,
  format: "chatlab-json" | "chatlab-jsonl" | "legacy-jsonl" | "legacy-json",
  manifest: ImportMetadata,
  config: BookkeepingConfig,
): ParsedImport {
  if (!manifest.account_id || !manifest.conversation_id || !manifest.locator)
    throw new Error("import_requires_account_conversation_locator");
  const provider = manifest.provider ?? "wechat";
  const admission = provider === "wechat" ? wechatImportScope(config.providers, manifest.account_id, manifest.conversation_id, manifest.conversation_type) : null;
  if (admission && !admission.admitted)
    return { events: [], gaps: [gap(admission.reason!, manifest.locator)], members: [], metadata: {} };
  const text = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : bytes;
  const gaps: CoverageGap[] = [];
  const members: any[] = [];
  let meta: any = {};
  const rows: { row: any; offset: number }[] = [];
  if (format.endsWith("jsonl")) {
    let offset = 0;
    let header = false;
    for (const line of text.split("\n")) {
      const length = Buffer.byteLength(line) + 1;
      if (line.trim() && !line.startsWith("#"))
        try {
          const r = parseLossless(line);
          if (format === "chatlab-jsonl") {
            if (!header) {
              if (r._type !== "header")
                throw new Error("chatlab_header_required");
              meta = r;
              header = true;
            } else if (r._type === "member") members.push(r);
            else if (r._type === "message") rows.push({ row: r, offset });
            else gaps.push(gap("chatlab_unknown_row", manifest.locator));
          } else rows.push({ row: r, offset });
        } catch {
          gaps.push(gap(`malformed_import_line:${offset}`, manifest.locator));
        }
      offset += length;
    }
    if (format === "chatlab-jsonl" && !header)
      gaps.push(gap("chatlab_header_missing", manifest.locator));
  } else
    try {
      const parsed = parseLossless(text);
      if (format === "chatlab-json") {
        meta = parsed;
        members.push(...(parsed.members ?? []));
        if (!Array.isArray(parsed.messages))
          throw new Error("chatlab_messages_missing");
        parsed.messages.forEach((row: any, i: number) =>
          rows.push({ row, offset: i }),
        );
      } else {
        const items = Array.isArray(parsed)
          ? parsed
          : (parsed.messages ?? parsed.rows);
        if (!Array.isArray(items)) throw new Error("legacy_messages_missing");
        items.forEach((row: any, i: number) => rows.push({ row, offset: i }));
      }
    } catch {
      gaps.push(gap("invalid_or_truncated_import_json", manifest.locator));
    }
  if (format.startsWith("chatlab") && meta.chatlab?.version !== "0.0.2")
    gaps.push(gap("unsupported_chatlab_version", manifest.locator));
  const self = new Set(
    manifest.self_ids ?? (manifest.owner_id ? [manifest.owner_id] : []),
  );
  const aliasOptions = { ...manifest, self_ids: [...self] };
  if (!manifest.identity_verified || (!self.size && !verifiedAliases(aliasOptions, "self_aliases").length))
    gaps.push(gap("import_self_identity_unverified", manifest.locator));
  if (!manifest.coverage_verified || !manifest.known_range)
    gaps.push(
      gap("export_complete_claim_not_coverage_proof", manifest.locator),
    );
  const events: SourceEvent[] = [];
  const occurrences = new Map<string, number>();
  for (const { row: r, offset } of rows) {
    const chatlab = format.startsWith("chatlab");
    const resolved = resolveWechatSender(r, aliasOptions, manifest.conversation_id, chatlab);
    const sender = resolved.sender_id;
    if (resolved.role === "unknown") gaps.push(gap("import_sender_unknown", manifest.locator));
    const server = r.server_id != null && String(r.server_id) !== "0" ? r.server_id : null;
    const native = r.platformMessageId ?? server ?? r.message_id ?? (r.local_id == null ? r.id : `local:${r.local_id}`);
    const body = r.content ?? r.message_content ?? r.display_text ?? r.text;
    const timestamp = r.timestamp ?? r.create_time ?? r.epoch;
    const kind = chatlab
      ? Number(r.type) === 0
        ? "text"
        : `media:${r.type}`
      : (r.message_kind ?? r.message_type ?? "text");
    if (typeof body !== "string") {
      gaps.push(gap("import_media_or_content_missing", manifest.locator));
      continue;
    }
    if (!["text", "Text", "message", 1, "1"].includes(kind))
      gaps.push(gap("media_not_transcribed", manifest.locator));
    const key = hash(
      JSON.stringify([
        r.source ?? manifest.locator,
        r.source_offset ?? offset,
        timestamp,
        sender,
        body,
      ]),
    );
    const count = occurrences.get(key) ?? 0;
    occurrences.set(key, count + 1);
    const e = event(
      {
        provider: manifest.provider ?? "wechat",
        account: manifest.account_id,
        conversation: manifest.conversation_id,
        message: native == null ? null : String(native),
        block: "0",
        body,
        role: resolved.role,
        time: timestamp,
        wireZone: manifest.source_timezone,
        offset,
        locator: manifest.locator,
        generation: native == null ? hash(manifest.locator) : "0",
        kind: String(kind),
        context: {
          sender_id: sender,
          sender_wxid: resolved.sender_wxid,
          identity_verified: manifest.identity_verified === true,
          is_mentioned: selfMention(r, body, aliasOptions),
          media_transcribed: false,
          source_format: format,
          source_offset: r.source_offset ?? offset,
          owner_id: manifest.owner_id ?? null,
          suspected_overlap: true,
        },
      },
      config,
    );
    if (r.create_time != null || r.epoch != null) {
      const epoch = r.create_time ?? r.epoch;
      if (typeof epoch === "number" || (typeof epoch === "string" && /^\d{10}(?:\.\d+)?$/.test(epoch)))
        e.physical_order = String(Math.round(Number(epoch) * 1000)).padStart(20, "0") + ":" + String(r.local_id ?? r.server_id ?? hash(JSON.stringify([epoch, sender || null, body]))).padStart(20, "0");
    }
    if (native == null)
      e.event_id = hash(
        `${manifest.provider ?? "wechat"}:${manifest.account_id}:${manifest.conversation_id}:import:${key}:${count}`,
      );
    if (e.utc_time.value === null)
      gaps.push(
        gap(e.utc_time.reason ?? "import_time_unknown", manifest.locator),
      );
    const isGroup = manifest.conversation_type === "group" || manifest.conversation_type === "unknown" || manifest.conversation_id.endsWith("@chatroom");
    e.context.is_group = isGroup;
    const anchor = manifest.identity_verified === true && (e.role === "user" || e.context.is_mentioned === true);
    const inRange = e.utc_time.value !== null && !!manifest.known_range && Date.parse(e.utc_time.value) >= Date.parse(manifest.known_range.from) && Date.parse(e.utc_time.value) < Date.parse(manifest.known_range.to);
    e.context.context_only = !inRange || manifest.identity_verified !== true || resolved.role === "unknown" || (isGroup && !anchor);
    if (isGroup && !anchor) {
      e.context.participation_window_status = "unknown";
      gaps.push(gap("import_group_participation_window_pending", manifest.locator));
    }
    events.push(e);
  }
  const anchors = events.filter(e => e.context.context_only === false && e.utc_time.value !== null).map(e => Date.parse(e.utc_time.value!));
  if (manifest.conversation_type === "group" || manifest.conversation_type === "unknown" || manifest.conversation_id.endsWith("@chatroom")) for (const e of events) {
    if (e.context.context_only !== false && e.utc_time.value !== null && anchors.some(t => Math.abs(Date.parse(e.utc_time.value!) - t) <= 20 * 60000)) e.context.participation_window_status = "within_anchor_window";
  }
  return { events, gaps, members, metadata: meta };
}
