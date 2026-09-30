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
  let epochTimeKey = false;
  while (i < text.length) {
    if (text[i] === '"') {
      const start = i++;
      while (i < text.length) {
        if (text[i] === "\\") i += 2;
        else if (text[i++] === '"') break;
      }
      const token = text.slice(start, i);
      out += token;
      let next = i;
      while (/\s/.test(text[next] ?? "") && next < text.length) next++;
      epochTimeKey = text[next] === ":" && ["timestamp", "create_time", "epoch"].includes(JSON.parse(token));
    } else if (text[i] === "-" || /[0-9]/.test(text[i])) {
      const m = text.slice(i).match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (!m) {
        out += text[i++];
        continue;
      }
      const n = m[0];
      out +=
        (epochTimeKey && /^\d{10}\.\d{1,9}$/.test(n)) ||
        (/^-?\d+$/.test(n) && !Number.isSafeInteger(Number(n)))
          ? JSON.stringify(n)
          : n;
      epochTimeKey = false;
      i += n.length;
    } else {
      const character = text[i++];
      out += character;
      if (character !== ":" && !/\s/.test(character)) epochTimeKey = false;
    }
  }
  return JSON.parse(out);
}
type ParsedTime = {
  utc: string | null;
  wire: string | null;
  precision: SourceEvent["time_precision"];
  reason: string | null;
};
function fractionPrecision(fraction: string | undefined): ParsedTime["precision"] {
  if (!fraction) return "second";
  if (fraction.length <= 3) return "millisecond";
  if (fraction.length <= 6) return "microsecond";
  return "nanosecond";
}
function exactFractionUtc(seconds: number, fraction?: string): string {
  return new Date(seconds).toISOString().slice(0, 19) +
    "." + (fraction ?? "000") + "Z";
}
function comparableUtc(value: string): string {
  const match = value.match(/^(.*?)(?:\.(\d{1,9}))?Z$/);
  return match ? match[1] + "." + (match[2] ?? "").padEnd(9, "0") + "Z" : value;
}
/** Resolve the whole second with Date/Intl, retaining ISO fractional digits as text. */
export function parseTime(raw: unknown, zone?: string): ParsedTime {
  if (typeof raw === "number" ||
      (typeof raw === "string" && /^\d{10}(?:\.\d+)?$/.test(raw))) {
    const text = typeof raw === "number" && String(raw).includes("e")
      ? raw.toFixed(9).replace(/0+$/, "").replace(/\.$/, "") : String(raw);
    const epoch = text.match(/^(-?\d+)(?:\.(\d{1,9}))?$/);
    if (!epoch)
      return { utc: null, wire: null, precision: "unknown", reason: "invalid_time" };
    if (typeof raw === "number" && (epoch[2]?.length ?? 0) > 3)
      return { utc: null, wire: "UTC", precision: "unknown", reason: "numeric_time_precision_unproven" };
    let whole = BigInt(epoch[1]);
    let fraction = epoch[2];
    if (text.startsWith("-") && fraction && BigInt(fraction) !== 0n) {
      whole--;
      fraction = (10n ** BigInt(fraction.length) - BigInt(fraction)).toString().padStart(fraction.length, "0");
    }
    const seconds = Number(whole) * 1000;
    if (!Number.isFinite(seconds) || !Number.isFinite(new Date(seconds).getTime()))
      return { utc: null, wire: null, precision: "unknown", reason: "invalid_time" };
    return {
      utc: exactFractionUtc(seconds, fraction), wire: "UTC",
      precision: fractionPrecision(fraction), reason: null,
    };
  }
  if (typeof raw !== "string")
    return { utc: null, wire: null, precision: "unknown", reason: "missing_time" };
  const match = raw.match(
    /^(\d{4}-\d{2}-\d{2})[ T](\d\d:\d\d)(?::(\d\d)(?:\.(\d{1,9}))?)?(Z|[+-]\d\d:?\d\d)?$/,
  );
  const hasOffset = /(Z|[+-]\d\d:?\d\d)$/.test(raw);
  if (!match)
    return { utc: null, wire: hasOffset ? raw.match(/(Z|[+-]\d\d:?\d\d)$/)?.[1] ?? null : zone ?? null,
      precision: "unknown", reason: hasOffset ? "invalid_time" : "invalid_local_time" };
  const [, day, clock, second, fraction, offset] = match;
  const precision = second ? fractionPrecision(fraction) : "minute";
  const target = `${day}T${clock}:${second ?? "00"}`;
  const base = Date.parse(target + "Z");
  if (!Number.isFinite(base) || new Date(base).toISOString().slice(0, 19) !== target)
    return { utc: null, wire: offset ?? zone ?? null, precision, reason: offset ? "invalid_time" : "invalid_local_time" };
  if (offset) {
    const seconds = Date.parse(target + offset);
    return Number.isFinite(seconds)
      ? { utc: exactFractionUtc(seconds, fraction), wire: offset, precision, reason: null }
      : { utc: null, wire: offset, precision, reason: "invalid_time" };
  }
  if (!zone)
    return { utc: null, wire: null, precision, reason: "missing_wire_timezone" };
  const found: number[] = [];
  for (let minutes = -14 * 60; minutes <= 14 * 60; minutes += 15) {
    const seconds = base - minutes * 60000;
    if (localClock(new Date(seconds), zone) === target) found.push(seconds);
  }
  return {
    utc: found.length === 1 ? exactFractionUtc(found[0], fraction) : null,
    wire: zone, precision,
    reason: found.length === 1 ? null : found.length ? "ambiguous_local_time" : "nonexistent_local_time",
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
    comparableUtc(a.effective_from).localeCompare(comparableUtc(b.effective_from)),
  );
  const entry = t.utc
    ? timeline.filter((e) => comparableUtc(e.effective_from) <= comparableUtc(t.utc!)).at(-1)
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
