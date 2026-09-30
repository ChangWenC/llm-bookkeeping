import { createHash } from "node:crypto";
import type {
  BookkeepingConfig,
  SourceEvent,
  SourceCoverage,
  CollectRequest,
  CoverageGap,
} from "../contracts/types.ts";
export const hash = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");
export const unknown = <T>(
  value: T | null,
  reason: string | null = value === null ? "unknown" : null,
) => ({ schema_version: 1 as const, value, reason });
/** Parse integer tokens before JSON.parse can round 64-bit source IDs. */
export function parseLossless(text: string): any {
  let out = "",
    i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      const start = i++;
      while (i < text.length) {
        if (text[i] === "\\") i += 2;
        else if (text[i++] === '"') break;
      }
      out += text.slice(start, i);
    } else if (text[i] === "-" || /[0-9]/.test(text[i])) {
      const m = text.slice(i).match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (!m) {
        out += text[i++];
        continue;
      }
      const n = m[0];
      out +=
        /^-?\d+$/.test(n) && !Number.isSafeInteger(Number(n))
          ? JSON.stringify(n)
          : n;
      i += n.length;
    } else out += text[i++];
  }
  return JSON.parse(out);
}
export function parseTime(
  raw: unknown,
  zone?: string,
): {
  utc: string | null;
  wire: string | null;
  precision: SourceEvent["time_precision"];
  reason: string | null;
} {
  if (
    typeof raw === "number" ||
    (typeof raw === "string" && /^\d{10}(?:\.\d+)?$/.test(raw))
  ) {
    const ms = Number(raw) * 1000;
    return Number.isFinite(ms)
      ? {
          utc: new Date(ms).toISOString(),
          wire: "UTC",
          precision: Number.isInteger(Number(raw)) ? "second" : "millisecond",
          reason: null,
        }
      : { utc: null, wire: null, precision: "unknown", reason: "invalid_time" };
  }
  if (typeof raw !== "string")
    return {
      utc: null,
      wire: null,
      precision: "unknown",
      reason: "missing_time",
    };
  const minutePrecision =
    /^\d{4}-\d{2}-\d{2}[ T]\d\d:\d\d(?:Z|[+-]\d\d:?\d\d)?$/.test(raw);
  const hasOffset = /(Z|[+-]\d\d:?\d\d)$/.test(raw);
  if (hasOffset) {
    const n = Date.parse(raw);
    return {
      utc: Number.isFinite(n) ? new Date(n).toISOString() : null,
      wire: raw.match(/(Z|[+-]\d\d:?\d\d)$/)?.[1] ?? null,
      precision: minutePrecision
        ? ("minute" as SourceEvent["time_precision"])
        : /\.\d{4,}/.test(raw)
          ? "microsecond"
          : raw.includes(".")
            ? "millisecond"
            : "second",
      reason: Number.isFinite(n) ? null : "invalid_time",
    };
  }
  if (!zone)
    return {
      utc: null,
      wire: null,
      precision: minutePrecision
        ? ("minute" as SourceEvent["time_precision"])
        : "unknown",
      reason: "missing_wire_timezone",
    };
  const match = raw.match(
    /^(\d{4}-\d{2}-\d{2})[ T](\d\d:\d\d)(?::(\d\d)(?:\.(\d+))?)?$/,
  );
  if (!match)
    return {
      utc: null,
      wire: zone,
      precision: "unknown",
      reason: "invalid_local_time",
    };
  const target = `${match[1]}T${match[2]}:${match[3] ?? "00"}`;
  const base = Date.parse(target + "Z");
  // Search possible offsets and reject DST ambiguous/nonexistent wall clocks.
  const found: number[] = [];
  for (let offset = -14 * 60; offset <= 14 * 60; offset += 15) {
    const t = base - offset * 60000;
    if (localClock(new Date(t), zone) === target) found.push(t);
  }
  return {
    utc:
      found.length === 1
        ? new Date(
            found[0] + Number("0." + (match[4] ?? "0")) * 1000,
          ).toISOString()
        : null,
    wire: zone,
    precision: !match[3]
      ? ("minute" as SourceEvent["time_precision"])
      : match[4]
        ? "millisecond"
        : "second",
    reason:
      found.length === 1
        ? null
        : found.length
          ? "ambiguous_local_time"
          : "nonexistent_local_time",
  };
}
function localClock(d: Date, zone: string): string {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (s: string) => p.find((x) => x.type === s)?.value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
}
export function event(
  input: {
    provider: string;
    account: string;
    conversation: string;
    message?: string | null;
    block?: string | null;
    role: string;
    body: string;
    time: unknown;
    offset: number;
    locator: string;
    generation: string;
    channel?: string | null;
    kind?: string;
    classification?: SourceEvent["classification"];
    context?: Record<string, unknown>;
    wireZone?: string;
  },
  config: BookkeepingConfig,
): SourceEvent {
  const t = parseTime(input.time, input.wireZone);
  const timeline = [...config.journal_timezone_timeline].sort((a, b) =>
    a.effective_from.localeCompare(b.effective_from),
  );
  const entry = t.utc
    ? timeline.filter((e) => e.effective_from <= t.utc!).at(-1)
    : null;
  const zone =
    entry?.timezone ?? (timeline.length ? null : config.journal_timezone);
  const reason = t.utc
    ? zone
      ? null
      : "timezone_timeline_not_covering_event"
    : t.reason;
  const block = input.block ?? "0";
  const native = input.message
    ? `native:${input.generation}:${input.message}:${block}`
    : `physical:${input.generation}:${input.offset}:${block}:${hash(input.body)}`;
  return {
    schema_version: 1,
    event_id: hash(
      `${input.provider}:${input.account}:${input.conversation}:${native}`,
    ),
    source: {
      schema_version: 1,
      provider: input.provider,
      account_id: input.account,
      conversation_id: input.conversation,
      message_id: input.message ?? null,
      block_id: block,
    },
    role: input.role,
    kind: input.kind ?? "message",
    channel: input.channel ?? null,
    body: input.body,
    fragment_ref: null,
    physical_order: String(input.offset).padStart(20, "0") + ":" + block,
    original_time: unknown(input.time == null ? null : String(input.time)),
    time_precision: t.precision,
    utc_time: unknown(t.utc, t.reason),
    wire_timezone: unknown(t.wire, t.reason),
    journal_timezone: unknown(zone, reason),
    journal_timezone_basis: entry?.basis ?? (zone ? "config_default" : null),
    journal_date: unknown(
      t.utc && zone ? localClock(new Date(t.utc), zone).slice(0, 10) : null,
      reason,
    ),
    classification: input.classification ?? "main",
    context: input.context ?? {},
    locator: input.locator,
    generation: input.generation,
  };
}
export const gap = (
  reason: string,
  locator: string | null = null,
): CoverageGap => ({
  schema_version: 1,
  range: null,
  reason,
  locator,
  resumable: true,
});
export function coverage(
  provider: string,
  account: string,
  request: CollectRequest,
  gaps: CoverageGap[],
  conversation: string | null = null,
  status?: SourceCoverage["capture_status"],
): SourceCoverage {
  return {
    schema_version: 1,
    coverage_id: hash(
      `${provider}:${account}:${request.lane}:${conversation}:${request.range.from}:${request.range.to}:${request.cutoff}`,
    ),
    provider,
    account_id: account,
    conversation_id: conversation,
    lane: request.lane,
    query_range: request.range,
    cutoff: request.cutoff,
    read_ranges: gaps.length ? [] : [request.range],
    gaps,
    capture_status: status ?? (gaps.length ? "partial" : "complete"),
    review_status: "pending",
  };
}
