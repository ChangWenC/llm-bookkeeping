import { spawn } from "node:child_process";
import type {
  SourceAdapter,
  ProviderConfig,
  BookkeepingConfig,
  CollectRequest,
  AdapterContext,
  CollectionBatch,
  SourceEvent,
  CoverageGap,
} from "../contracts/types.ts";
import { coverage, event, gap, hash, parseLossless } from "./common.ts";
import {
  initializeHistory,
  recordHistoryWindow,
  historyGaps,
  queueGroupContext,
  chooseHistoryWindow,
  recordLateWindow,
} from "./wechat-history.ts";
import { resolveWechatSender, selfMention, verifiedAliases } from "./wechat-identity.ts";
import { wechatConversationScope, wechatScopeError } from "./wechat-policy.ts";
const nonemptyShard = (value: unknown) =>
  Array.isArray(value)
    ? value.length > 0
    : typeof value === "number"
      ? value > 0
      : value != null && value !== false && value !== "";
export type ReadonlyRunner = (
  binary: string,
  args: string[],
  options: { timeout_ms: number; max_bytes: number },
) => Promise<string>;
export const runReadonly: ReadonlyRunner = (binary, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      env: { ...process.env, WECHAT_USE_NO_UPDATE_CHECK: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: Error | null = null;
    const timer = setTimeout(() => {
      failure = new Error("wechat_timeout");
      child.kill("SIGKILL");
    }, options.timeout_ms);
    child.stdout.on("data", (b: Buffer) => {
      bytes += b.length;
      if (bytes > options.max_bytes) {
        failure = new Error("wechat_output_budget");
        child.kill("SIGKILL");
      } else chunks.push(b);
    });
    child.stderr.resume();
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`wechat_exit_${code}`));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
function routeArgs(source: ProviderConfig): string[] {
  const bundle = source.options.bundle_id;
  if (typeof bundle !== "string" || !bundle)
    throw new Error("wechat_bundle_id_required");
  if (source.options.routing === "managed_bundle") {
    if (
      source.options.account_binding_verified !== true ||
      source.options.bound_account_id !== source.account_id
    )
      throw new Error("wechat_managed_account_binding_unverified");
    return ["--bundle-id", bundle];
  }
  return ["--account", source.account_id, "--bundle-id", bundle];
}
function historyWindow(chat: string, request: CollectRequest, isGroup = chat.endsWith("@chatroom")) {
  const group = isGroup && request.lane !== "history";
  return {
    from: Math.floor(
      (Date.parse(request.range.from) - (group ? 20 * 60000 : 0)) / 1000,
    ),
    to: Math.ceil(
      Math.min(
        Date.parse(request.cutoff),
        Date.parse(request.range.to) + (group ? 20 * 60000 : 0),
      ) / 1000,
    ),
  };
}
export function historyArgs(
  source: ProviderConfig,
  chat: string,
  request: CollectRequest,
  conversationType?: string | boolean,
): string[] {
  const window = historyWindow(chat, request, wechatConversationScope(source.options, chat, conversationType).is_group);
  return [
    ...routeArgs(source),
    "history",
    "--chat",
    chat,
    "--since",
    String(window.from),
    "--until",
    String(window.to),
    "--limit",
    String(Math.min(10000, Number(source.options.limit ?? 2000))),
    "--order",
    "asc",
    "--json",
    "--no-transcribe",
  ];
}
export function parseWechatSessions(
  text: string,
  limit: number,
): { chats: string[]; chat_types: Record<string, string>; gaps: CoverageGap[] } {
  const parsed = parseLossless(text);
  if (!parsed?.meta || !Array.isArray(parsed.rows))
    throw new Error("wechat_expected_sessions_meta_rows");
  const gaps: CoverageGap[] = [];
  if (
    !["ok", "windowed"].includes(parsed.meta.status) ||
    nonemptyShard(parsed.meta.unknown_shards) ||
    nonemptyShard(parsed.meta.unreadable_shards)
  )
    gaps.push(gap("wechat_sessions_shards_or_status_partial"));
  if (parsed.rows.length >= limit) gaps.push(gap("wechat_sessions_limit_hit"));
  const chats: string[] = [];
  const chat_types: Record<string, string> = {};
  for (const row of parsed.rows) {
    const id = row.username;
    if (typeof id !== "string" || !id) {
      gaps.push(gap("wechat_session_identity_missing"));
      continue;
    }
    if (
      id === "filehelper" ||
      (["private", "group"].includes(row.chat_type) && wechatConversationScope({}, id, row.chat_type).admitted)
    )
      { chats.push(id); chat_types[id] = row.chat_type; }
  }
  return { chats: [...new Set(chats)], chat_types, gaps };
}

function verifiedRangeGaps(
  source: ProviderConfig,
  chat: string,
  request: CollectRequest,
): CoverageGap[] {
  const perChat = source.options.verified_ranges_by_chat as
    Record<string, unknown> | undefined;
  const ranges = Array.isArray(perChat?.[chat])
    ? [...(perChat![chat] as any[])]
    : [];
  const sinceMap = source.options.verified_since_by_chat as
    Record<string, unknown> | undefined;
  const since = sinceMap?.[chat] ?? source.options.copy_verified_since;
  if (typeof since === "string")
    ranges.push({ from: since, to: request.cutoff });
  const valid = ranges
    .map((r) => ({ from: Date.parse(r.from), to: Date.parse(r.to) }))
    .filter(
      (r) => Number.isFinite(r.from) && Number.isFinite(r.to) && r.from < r.to,
    )
    .sort((a, b) => a.from - b.from);
  let through = Date.parse(request.range.from);
  const end = Date.parse(request.range.to);
  const gaps: CoverageGap[] = [];
  for (const range of valid) {
    if (range.to <= through) continue;
    if (range.from > through) {
      const stop = Math.min(range.from, end);
      if (through < stop)
        gaps.push({
          schema_version: 1,
          range: {
            schema_version: 1,
            from: new Date(through).toISOString(),
            to: new Date(stop).toISOString(),
          },
          reason: "wechat_copy_history_range_unverified",
          locator: chat,
          resumable: true,
        });
      through = stop;
    }
    if (range.from <= through)
      through = Math.max(through, Math.min(end, range.to));
    if (through >= end) break;
  }
  if (through < end)
    gaps.push({
      schema_version: 1,
      range: {
        schema_version: 1,
        from: new Date(through).toISOString(),
        to: new Date(end).toISOString(),
      },
      reason: "wechat_copy_history_range_unverified",
      locator: chat,
      resumable: true,
    });
  return gaps;
}
export function parseWechatHistory(
  text: string,
  source: ProviderConfig,
  chat: string,
  request: CollectRequest,
  config: BookkeepingConfig,
  contextAnchors?: number[],
  conversationType?: string | boolean,
): { events: SourceEvent[]; gaps: CoverageGap[] } {
  const admission = wechatConversationScope(source.options, chat, conversationType);
  if (!admission.admitted) return { events: [], gaps: [gap(admission.reason!, chat)] };
  const parsed = parseLossless(text);
  if (!parsed || !parsed.meta || !Array.isArray(parsed.rows))
    throw new Error("wechat_expected_meta_rows");
  const gaps: CoverageGap[] = [];
  const meta = parsed.meta;
  const self = new Set(
    Array.isArray(source.options.self_ids)
      ? source.options.self_ids.map(String)
      : [],
  );
  const verified = source.options.identity_verified === true;
  if (!verified || (!self.size && !verifiedAliases(source.options, "self_aliases").length))
    gaps.push(gap("wechat_self_identity_unverified", chat));
  gaps.push(...verifiedRangeGaps(source, chat, request));
  if (source.options.cursor_readonly_verified !== true)
    gaps.push(gap("wechat_history_cursor_behavior_unverified", chat));
  if (
    nonemptyShard(meta.unknown_shards) ||
    nonemptyShard(meta.unreadable_shards)
  )
    gaps.push(gap("wechat_unknown_or_unreadable_shards", chat));
  if (!["ok", "windowed"].includes(meta.status))
    gaps.push(gap(`wechat_status:${meta.status ?? "unknown"}`, chat));
  if (meta.account_id && String(meta.account_id) !== source.account_id)
    gaps.push(gap("wechat_account_mismatch", chat));
  const expectedWindow = historyWindow(chat, request, admission.is_group);
  if (
    Number(meta.since_resolved) !== expectedWindow.from ||
    Number(meta.until_resolved) !== expectedWindow.to
  )
    gaps.push(gap("wechat_window_not_proven", chat));
  if (
    parsed.rows.length >= Math.min(10000, Number(source.options.limit ?? 2000))
  )
    gaps.push(gap("wechat_limit_hit_requires_import", chat));
  if (
    meta.shards_scanned == null ||
    meta.shards_hit == null ||
    meta.truncated === true
  )
    gaps.push(gap("wechat_shards_or_truncation_unknown", chat));
  const isGroup = admission.is_group;
  const candidates: SourceEvent[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < parsed.rows.length; i++) {
    const r = parsed.rows[i];
    const sender = resolveWechatSender(r, source.options, chat);
    const senderId = sender.sender_id;
    const native =
      r.server_id && String(r.server_id) !== "0"
        ? String(r.server_id)
        : r.local_id == null
          ? null
          : `local:${r.local_id}`;
    const body = r.message_content ?? r.display_text;
    const kind = r.message_kind ?? "unknown";
    if (r.chat_id && String(r.chat_id) !== chat) {
      gaps.push(gap("wechat_chat_mismatch", chat));
      continue;
    }
    if (native === null)
      gaps.push(gap("wechat_message_identity_unknown", chat));
    if (typeof body !== "string") {
      gaps.push(gap("wechat_media_unread", chat));
      continue;
    }
    if (!["text", "Text", 1, "1"].includes(kind))
      gaps.push(gap("wechat_media_not_transcribed", chat));
    if (sender.role === "unknown")
      gaps.push(gap("wechat_sender_unknown", chat));
    const e = event(
      {
        provider: "wechat",
        account: source.account_id,
        conversation: chat,
        message: native,
        body,
        role: sender.role,
        kind: String(kind),
        time: r.create_time,
        offset: i,
        locator: `wechat:${source.account_id}:${chat}`,
        generation: "0",
        context: {
          sender_id: senderId,
          sender_wxid: r.sender_wxid == null ? (sender.role === "user" && senderId && self.has(senderId) ? senderId : null) : String(r.sender_wxid),
          is_group: isGroup,
          is_mentioned: selfMention(r, body, source.options),
          identity_verified: verified,
          media_transcribed: false,
        },
      },
      config,
    );
    if (e.utc_time.value) {
      const t = Date.parse(e.utc_time.value);
      if (!(t >= expectedWindow.from * 1000 && t < expectedWindow.to * 1000))
        continue;
      e.context.context_only = t < Date.parse(request.range.from) || t >= Date.parse(request.range.to);
    }
    e.physical_order =
      String(Math.round(Number(r.create_time) * 1000)).padStart(20, "0") +
      ":" +
      String(
        r.local_id ??
          r.server_id ??
          hash(JSON.stringify([r.create_time, senderId, body])),
      ).padStart(20, "0");
    if (!e.utc_time.value) gaps.push(gap("wechat_time_unknown", chat));
    if (native && seen.has(e.event_id)) continue;
    seen.add(e.event_id);
    candidates.push(e);
  }
  if (!isGroup) return { events: candidates, gaps };
  const anchors = contextAnchors ?? candidates
    .filter(
      (e) =>
        !e.context.context_only &&
        (e.role === "user" || e.context.is_mentioned),
    )
    .flatMap((e) => (e.utc_time.value ? [Date.parse(e.utc_time.value)] : []));
  if (contextAnchors) for (const event of candidates) event.context.context_only = true;
  if (!verified) gaps.push(gap("wechat_group_participation_unknown", chat));
  return {
    events: candidates.filter(
      (e) =>
        e.utc_time.value &&
        anchors.some(
          (t) => Math.abs(Date.parse(e.utc_time.value!) - t) <= 20 * 60000,
        ),
    ).map(event => {
      if (event.role !== "user" && event.context.is_mentioned !== true) event.context.context_only = true;
      return event;
    }),
    gaps,
  };
}
function attachEventFragments(batch: CollectionBatch): void {
  for (const e of batch.events) {
    const canonical = JSON.stringify({
      source: e.source,
      body: e.body,
      original_time: e.original_time,
      kind: e.kind,
      context: e.context,
    });
    const fid = hash(canonical);
    e.fragment_ref = fid;
    batch.fragments.push({
      schema_version: 1,
      fragment_id: fid,
      locator: e.locator,
      bytes_base64: Buffer.from(canonical).toString("base64"),
      sha256: hash(canonical),
    });
  }
}

export class WechatAdapter implements SourceAdapter {
  readonly provider = "wechat";
  private source: ProviderConfig;
  private config: BookkeepingConfig;
  private runner: ReadonlyRunner;
  constructor(
    source: ProviderConfig,
    config: BookkeepingConfig,
    runner: ReadonlyRunner = runReadonly,
  ) {
    this.source = source;
    this.config = config;
    this.runner = runner;
  }
  async *collect(
    request: CollectRequest,
    context: AdapterContext,
  ): AsyncIterable<CollectionBatch> {
    const make = (
      events: SourceEvent[],
      gaps: CoverageGap[],
      chat: string | null,
      status?: any,
      raw?: string,
      capturedRequest: CollectRequest = request,
    ): CollectionBatch => {
      const id = hash(
        `${this.source.account_id}:${chat}:${request.lane}:${request.cutoff}:${capturedRequest.range.from}:${capturedRequest.range.to}:${raw ?? status}`,
      );
      const batch: CollectionBatch = {
        schema_version: 1,
        batch_id: id,
        events,
        fragments: raw
          ? [
              {
                schema_version: 1,
                fragment_id: id,
                locator: `wechat:${chat}`,
                bytes_base64: Buffer.from(raw).toString("base64"),
                sha256: hash(raw),
              },
            ]
          : [],
        coverage: [
          coverage(
            "wechat",
            this.source.account_id,
            capturedRequest,
            gaps,
            chat,
            status,
          ),
        ],
        checkpoints:
          chat && raw
            ? [
                {
                  schema_version: 1,
                  checkpoint_id: hash(
                    `wechat:${this.source.account_id}:${request.lane}:${chat}`,
                  ),
                  provider: "wechat",
                  lane: request.lane,
                  locator: `wechat:${chat}`,
                  generation: "0",
                  cursor: {
                    account_id: this.source.account_id,
                    bundle_id: this.source.options.bundle_id,
                    captured_from: capturedRequest.range.from,
                    captured_to: capturedRequest.range.to,
                    enumeration_complete: gaps.length === 0,
                  },
                  updated_at: request.cutoff,
                },
              ]
            : [],
      };
      batch.batch_id = hash(JSON.stringify({ ...batch, batch_id: null }));
      return batch;
    };
    const deadline =
      Date.now() +
      Math.min(
        request.budget.max_duration_ms,
        request.lane === "history" ? 30000 : 90000,
      );
    let remaining = Math.min(
      request.budget.max_bytes,
      (request.lane === "history" ? 32 : 64) * 1024 * 1024,
    );
    if (!this.source.enabled) {
      yield make([], [], null, "disabled");
      return;
    }
    const scopeError = wechatScopeError(this.source.options);
    if (scopeError) { yield make([], [gap(scopeError)], null, "unavailable"); return; }
    let routedSource = this.source;
    if (this.source.options.routing === "managed_bundle") {
      try {
        const raw = await this.runner(
          String(this.source.options.binary ?? "wechat-use"),
          ["accounts", "--json"],
          {
            timeout_ms: Math.min(10000, deadline - Date.now()),
            max_bytes: Math.min(1024 * 1024, remaining),
          },
        );
        remaining -= Buffer.byteLength(raw);
        const accounts = parseLossless(raw).accounts;
        if (!Array.isArray(accounts))
          throw new Error("wechat_accounts_shape_unknown");
        const bindings = accounts.filter(
          (a) => a.bundle_id === this.source.options.bundle_id,
        );
        if (
          bindings.length !== 1 ||
          bindings[0].wxid !== this.source.account_id
        )
          throw new Error(
            "wechat_account_binding_missing_ambiguous_or_mismatched",
          );
        routedSource = {
          ...this.source,
          options: {
            ...this.source.options,
            account_binding_verified: true,
            bound_account_id: this.source.account_id,
          },
        };
      } catch (error: any) {
        yield make(
          [],
          [gap(`wechat_account_preflight_unavailable:${error.message}`)],
          null,
          "unavailable",
        );
        return;
      }
    }
    let chats = Array.isArray(this.source.options.chats)
      ? this.source.options.chats.map(String)
      : [];
    const chatTypes: Record<string, string> = {};
    const discoveryLocator = "wechat:@discovery";
    const previous = context.checkpoints.find(
      (c) =>
        c.provider === "wechat" &&
        c.lane === request.lane &&
        c.locator === discoveryLocator &&
        c.cursor.account_id === this.source.account_id &&
        c.cursor.bundle_id === this.source.options.bundle_id,
    );
    let discoveryGaps: CoverageGap[] = [];
    if (this.source.options.discover_sessions === true) {
      try {
        const limit = Math.min(
          request.budget.max_directory_entries,
          10000,
          Number(this.source.options.sessions_limit ?? 200),
        );
        const raw = await this.runner(
          String(this.source.options.binary ?? "wechat-use"),
          [
            ...routeArgs(routedSource),
            "sessions",
            "--limit",
            String(limit),
            "--json",
          ],
          {
            timeout_ms: Math.min(30000, deadline - Date.now()),
            max_bytes: remaining,
          },
        );
        remaining -= Buffer.byteLength(raw);
        const discovered = parseWechatSessions(raw, limit);
        chats = [
          ...new Set([
            ...chats,
            ...discovered.chats,
            ...(Array.isArray(this.source.options.pinned_chats)
              ? this.source.options.pinned_chats.map(String)
              : []),
          ]),
        ];
        Object.assign(chatTypes, discovered.chat_types);
        discoveryGaps = discovered.gaps;
      } catch (error: any) {
        discoveryGaps.push(gap(`wechat_sessions_unavailable:${error.message}`));
      }
    }
    chats = [...new Set([...chats, ...(Array.isArray(this.source.options.pinned_chats) ? this.source.options.pinned_chats.map(String) : [])])];
    chats = chats.filter(chat => {
      const admission = wechatConversationScope(this.source.options, chat, chatTypes[chat]);
      if (!admission.admitted && admission.reason === 'wechat_conversation_type_unknown')
        discoveryGaps.push(gap(admission.reason, chat));
      return admission.admitted;
    });
    if (!chats.length) {
      yield make(
        [],
        discoveryGaps.length
          ? discoveryGaps
          : [gap("wechat_explicit_chat_scope_required")],
        null,
        discoveryGaps.length ? "unavailable" : "unknown",
      );
      return;
    }
    const initialIndex =
      Number(previous?.cursor.next_chat_index ?? 0) % chats.length;
    const ordered = [
      ...chats.slice(initialIndex),
      ...chats.slice(0, initialIndex),
    ];
    let processed = 0;
    let historyQueries = 0;
    const historyQueryLimit = Math.min(
      16,
      Number(this.source.options.history_queries_per_round ?? 8),
    );
    for (const chat of ordered) {
      if (
        Date.now() >= deadline ||
        remaining <= 0 ||
        processed >= request.budget.max_directory_entries ||
        (request.lane === "history" && historyQueries >= historyQueryLimit)
      ) {
        discoveryGaps.push(gap("wechat_provider_budget_exhausted", chat));
        break;
      }
      processed++;

      const previousChat = context.checkpoints.find(
        (c) =>
          c.provider === "wechat" &&
          c.lane === request.lane &&
          c.locator === `wechat:${chat}` &&
          c.cursor.account_id === this.source.account_id &&
          c.cursor.bundle_id === this.source.options.bundle_id,
      );
      const history =
        request.lane === "history"
          ? initializeHistory(request, previousChat?.cursor.history)
          : null;
      const maxQueries = historyQueryLimit;
      let chatQueries = 0;
      const attachHistory = (batch: CollectionBatch) => {
        if (!history) return;
        let checkpoint = batch.checkpoints[0];
        if (!checkpoint) {
          checkpoint = {
            schema_version: 1,
            checkpoint_id: hash(
              `wechat:${this.source.account_id}:${request.lane}:${chat}`,
            ),
            provider: "wechat",
            lane: request.lane,
            locator: `wechat:${chat}`,
            generation: "0",
            cursor: {},
            updated_at: request.cutoff,
          };
          batch.checkpoints.push(checkpoint);
        }
        checkpoint.cursor = {
          ...checkpoint.cursor,
          account_id: this.source.account_id,
          bundle_id: this.source.options.bundle_id,
          history: structuredClone(history),
        };
        batch.batch_id = hash(`${batch.batch_id}:${JSON.stringify(history)}`);
      };
      let lateAlreadyRead = false;
      let deferredAlreadyRead = false;
      while (true) {
        if (history && (historyQueries >= maxQueries || chatQueries >= 4 || Date.now() >= deadline || remaining <= 0)) break;
        const selected = history ? chooseHistoryWindow(history, request, this.source.options, lateAlreadyRead, deferredAlreadyRead, historyQueries + 1 >= maxQueries || chatQueries + 1 >= 4) : undefined;
        if (history && !selected) break;
        const window = selected?.window;
        const late = selected?.late === true;
        if (late && selected?.deferred) deferredAlreadyRead = true;
        else if (late) lateAlreadyRead = true;
        const query = window
          ? {
              ...request,
              range: {
                schema_version: 1 as const,
                from: window.from,
                to: window.to,
              },
            }
          : request;
        try {
          if (history) {
            historyQueries++;
            chatQueries++;
          }
          const args = historyArgs(routedSource, chat, query, chatTypes[chat]);
          const raw = await this.runner(
            String(this.source.options.binary ?? "wechat-use"),
            args,
            {
              timeout_ms: Math.min(30000, deadline - Date.now()),
              max_bytes: remaining,
            },
          );
          remaining -= Buffer.byteLength(raw);
          const parsed = parseWechatHistory(
            raw,
            this.source,
            chat,
            query,
            this.config,
            window?.purpose === "context" ? window.anchor_times : undefined,
            chatTypes[chat],
          );
          if (history && window) {
            const rows = parseLossless(raw).rows;
            const unreliable = parsed.gaps.some(
              (g) =>
                g.reason.startsWith("wechat_status:") ||
                g.reason === "wechat_unknown_or_unreadable_shards" ||
                g.reason === "wechat_window_not_proven" ||
                g.reason === "wechat_shards_or_truncation_unknown",
            );
            if (unreliable) {
              if (late) recordLateWindow(history, window, false, rows.length, request, this.source.options, true, selected?.deferred);
              else history.queue.push(window);
            }
            else {
              const capped = rows.length >= Math.min(10000, Number(this.source.options.limit ?? 2000));
              if (late) recordLateWindow(history, window, capped, rows.length, request, this.source.options, false, selected?.deferred);
              else recordHistoryWindow(history, window, capped);
              if (!capped && window.purpose !== "context" && wechatConversationScope(this.source.options, chat, chatTypes[chat]).is_group) {
                const anchors = parsed.events.filter(event => !event.context.context_only && (event.role === "user" || event.context.is_mentioned === true))
                  .flatMap(event => event.utc_time.value ? [Date.parse(event.utc_time.value)] : []);
                queueGroupContext(late ? history.late_sweep! : history, anchors, request.cutoff);
                if (late && history.late_sweep!.queue.length) history.late_sweep!.next_cycle_at = null;
              }
            }
          }
          discoveryGaps.push(
            ...parsed.gaps.filter(
              (g) =>
                !history || g.reason !== "wechat_limit_hit_requires_import",
            ),
          );
          const batch = make(
            parsed.events,
            parsed.gaps,
            chat,
            undefined,
            raw,
            query,
          );
          attachEventFragments(batch);
          attachHistory(batch);
          yield batch;
        } catch (error: any) {
          const failure = gap(`wechat_unavailable:${error.message}`, chat);
          discoveryGaps.push(failure);
          if (history && window) {
            if (late) recordLateWindow(history, window, false, 0, request, this.source.options, true, selected?.deferred);
            else history.queue.push(window);
          }
          const failed = make([], [failure], chat, "unavailable");
          attachHistory(failed);
          yield failed;
          if (!late) break;
        }
        if (!history) break;
      }
      if (history) {
        const gaps = [
          ...verifiedRangeGaps(this.source, chat, request),
          ...historyGaps(history, chat),
        ];
        discoveryGaps.push(...gaps);
        const progress = make([], gaps, chat);
        attachHistory(progress);
        yield progress;
      }
    }
    const discoveryBatch = make([], discoveryGaps, null);
    discoveryBatch.checkpoints.push({
      schema_version: 1,
      checkpoint_id: hash(
        `wechat:${this.source.account_id}:${request.lane}:discovery`,
      ),
      provider: "wechat",
      lane: request.lane,
      locator: discoveryLocator,
      generation: "0",
      cursor: {
        account_id: this.source.account_id,
        bundle_id: this.source.options.bundle_id,
        next_chat_index: (initialIndex + processed) % chats.length,
      },
      updated_at: request.cutoff,
    });
    discoveryBatch.batch_id = hash(JSON.stringify({ ...discoveryBatch, batch_id: null }));
    yield discoveryBatch;
  }
  replay(range: any, context: AdapterContext) {
    return this.collect(
      {
        lane: "history",
        range,
        cutoff: range.to,
        budget: {
          max_duration_ms: 30000,
          max_bytes: 32 * 1024 * 1024,
          max_directory_entries: 2000,
        },
      },
      {
        ...context,
        checkpoints: context.checkpoints.filter(
          (c) => c.locator === "wechat:@discovery",
        ),
      },
    );
  }
}
