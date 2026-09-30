import type { CollectRequest, CoverageGap } from "../contracts/types.ts";
import { gap } from "./common.ts";
const DAY = 86400000;
export interface HistoryWindow {
  from: string;
  to: string;
  depth: number;
  purpose?: "core" | "context";
  anchor_times?: number[];
  retry_after?: string;
}
export interface LateSweep {
  root_from: string;
  root_to: string;
  frontier: string;
  queue: HistoryWindow[];
  blocked: HistoryWindow[];
  window_ms: number;
  next_cycle_at: string | null;
}
export interface HistoryCursor {
  root_from: string;
  root_to: string;
  queue: HistoryWindow[];
  blocked: HistoryWindow[];
  initial_core_complete?: boolean;
  prefer_late_next?: boolean;
  late_sweep?: LateSweep;
}
export function initializeHistory(request: CollectRequest, saved: unknown): HistoryCursor {
  const old = saved as HistoryCursor | undefined;
  if (!old || old.root_from !== request.range.from || !Array.isArray(old.queue))
    return {
      root_from: request.range.from, root_to: request.range.to,
      queue: [{ from: request.range.from, to: request.range.to, depth: 0 }], blocked: [],
      initial_core_complete: false,
    };
  const cursor = structuredClone(old);
  // Old checkpoints acquire the sweep only after their initial core has drained.
  cursor.initial_core_complete ||= !old.queue.some(window => window.purpose !== "context");
  if (Date.parse(request.range.to) > Date.parse(cursor.root_to)) {
    cursor.queue.push({ from: cursor.root_to, to: request.range.to, depth: 0 });
    cursor.root_to = request.range.to;
  }
  return cursor;
}
/** Split windows without interpreting asc as the earliest page. Same-second caps are irreducible. */
export function recordHistoryWindow(
  cursor: Pick<HistoryCursor, "queue" | "blocked">,
  window: HistoryWindow,
  capped: boolean,
): void {
  if (!capped) return;
  const from = Date.parse(window.from), to = Date.parse(window.to);
  const middle = Math.floor((from + to) / 2000) * 1000;
  if (to - from <= 1000 || middle <= from || middle >= to || window.depth >= 32) {
    cursor.blocked.push(window);
    return;
  }
  cursor.queue.push(
    { ...window, from: window.from, to: new Date(middle).toISOString(), depth: window.depth + 1 },
    { ...window, from: new Date(middle).toISOString(), to: window.to, depth: window.depth + 1 },
  );
}
function finiteOption(options: Record<string, unknown>, key: string, fallback: number, maximum: number): number {
  const value = Number(options[key] ?? fallback);
  return Number.isFinite(value) && value > 0 ? Math.min(maximum, value) : fallback;
}
function sweepInterval(options: Record<string, unknown>): number {
  return Math.max(3600000, finiteOption(options, "late_sweep_interval_ms", DAY, 30 * DAY));
}
function sweepBase(options: Record<string, unknown>): number {
  return Math.max(1000, finiteOption(options, "late_sweep_window_days", 7, 3650) * DAY);
}
export function prepareLateSweep(cursor: HistoryCursor, request: CollectRequest, options: Record<string, unknown>): void {
  if (!cursor.initial_core_complete) return;
  const end = Math.min(Date.parse(request.range.to), Date.parse(request.cutoff) - 2 * DAY);
  if (end <= Date.parse(cursor.root_from)) return;
  const prior = cursor.late_sweep;
  if (prior && (!prior.next_cycle_at || Date.parse(prior.next_cycle_at) > Date.parse(request.cutoff))) return;
  cursor.late_sweep = {
    root_from: cursor.root_from, root_to: new Date(end).toISOString(), frontier: new Date(end).toISOString(),
    queue: [], blocked: prior?.blocked ?? [], window_ms: sweepBase(options), next_cycle_at: null,
  };
}
/** Exclude irreducible seconds already retained as import gaps; ordinary failures remain retries. */
function excludeBlocked(from: number, to: number, blocks: HistoryWindow[]): HistoryWindow[] {
  let pieces = [{ from, to }];
  for (const block of blocks.filter(window => window.purpose !== "context")) {
    const left = Date.parse(block.from), right = Date.parse(block.to);
    pieces = pieces.flatMap(piece => {
      if (right <= piece.from || left >= piece.to) return [piece];
      return [
        ...(left > piece.from ? [{ from: piece.from, to: left }] : []),
        ...(right < piece.to ? [{ from: right, to: piece.to }] : []),
      ];
    });
  }
  return pieces.sort((a, b) => b.to - a.to).map(piece => ({
    from: new Date(piece.from).toISOString(), to: new Date(piece.to).toISOString(), depth: 0,
  }));
}
function takeLateWindow(cursor: HistoryCursor, request: CollectRequest, options: Record<string, unknown>): HistoryWindow | undefined {
  const sweep = cursor.late_sweep;
  if (!sweep || sweep.next_cycle_at) return;
  let index = sweep.queue.findIndex(window => !window.retry_after);
  // Fresh older windows proceed ahead of failed windows, so a bad shard cannot block the sweep.
  while (index < 0 && Date.parse(sweep.frontier) > Date.parse(sweep.root_from)) {
    const to = Date.parse(sweep.frontier);
    const from = Math.max(Date.parse(sweep.root_from), to - sweep.window_ms);
    sweep.frontier = new Date(from).toISOString();
    sweep.queue.unshift(...excludeBlocked(from, to, [...cursor.blocked, ...sweep.blocked]));
    index = sweep.queue.findIndex(window => !window.retry_after);
  }
  if (index < 0) index = sweep.queue.findIndex(window => Date.parse(window.retry_after!) <= Date.parse(request.cutoff));
  if (index >= 0) {
    const window = sweep.queue.splice(index, 1)[0];
    delete window.retry_after;
    return window;
  }
  if (!sweep.queue.length) sweep.next_cycle_at = new Date(Date.parse(request.cutoff) + sweepInterval(options)).toISOString();
}
export function chooseHistoryWindow(
  cursor: HistoryCursor, request: CollectRequest, options: Record<string, unknown>, lateAlreadyRead: boolean,
): { window: HistoryWindow; late: boolean } | undefined {
  prepareLateSweep(cursor, request, options);
  const sweep = cursor.late_sweep;
  const canTryLate = !lateAlreadyRead && sweep && !sweep.next_cycle_at;
  if (canTryLate && (!cursor.queue.length || cursor.prefer_late_next)) {
    const window = takeLateWindow(cursor, request, options);
    if (window) { cursor.prefer_late_next = false; return { window, late: true }; }
  }
  const primary = takeHistoryWindow(cursor);
  if (primary) { cursor.prefer_late_next = true; return { window: primary, late: false }; }
  if (canTryLate) {
    const window = takeLateWindow(cursor, request, options);
    if (window) { cursor.prefer_late_next = false; return { window, late: true }; }
  }
}
export function recordLateWindow(
  cursor: HistoryCursor, window: HistoryWindow, capped: boolean, rows: number,
  request: CollectRequest, options: Record<string, unknown>, failure = false,
): void {
  const sweep = cursor.late_sweep!;
  if (failure) {
    sweep.queue.push({ ...window, retry_after: new Date(Date.parse(request.cutoff) + sweepInterval(options)).toISOString() });
    return;
  }
  recordHistoryWindow(sweep, window, capped);
  const maximum = Math.max(sweepBase(options), finiteOption(options, "late_sweep_max_window_days", 3650, 3650) * DAY);
  sweep.window_ms = rows === 0 && !capped ? Math.min(maximum, sweep.window_ms * 4) : sweepBase(options);
  if (!sweep.queue.length && Date.parse(sweep.frontier) <= Date.parse(sweep.root_from))
    sweep.next_cycle_at = new Date(Date.parse(request.cutoff) + sweepInterval(options)).toISOString();
}
export function historyGaps(cursor: HistoryCursor, chat: string): CoverageGap[] {
  const gaps: CoverageGap[] = [...cursor.blocked, ...(cursor.late_sweep?.blocked ?? [])].map(window => ({
    schema_version: 1, range: { schema_version: 1, from: window.from, to: window.to },
    reason: window.purpose === "context" ? "wechat_group_context_dense_requires_import" : "wechat_dense_second_or_split_limit_requires_import",
    locator: chat, resumable: true,
  }));
  if (cursor.queue.length) gaps.push(gap(`wechat_history_windows_pending:${cursor.queue.length}`, chat));
  if (!cursor.initial_core_complete && Date.parse(cursor.root_to) - Date.parse(cursor.root_from) > 2 * DAY)
    gaps.push(gap("wechat_late_arrivals_waiting_for_initial_history", chat));
  const sweep = cursor.late_sweep;
  if (sweep && !sweep.next_cycle_at && (sweep.queue.length || Date.parse(sweep.frontier) > Date.parse(sweep.root_from)))
    gaps.push(gap(`wechat_late_arrivals_pending:windows:${sweep.queue.length}:frontier:${sweep.frontier}:snapshot:${sweep.root_to}`, chat));
  return gaps;
}
/** Context is a separate exact window, never an expansion of a core paging query. */
export function queueGroupContext(cursor: Pick<HistoryCursor, "queue">, anchors: number[], cutoff: string): void {
  for (const anchor of anchors) {
    const from = new Date(anchor - 20 * 60_000).toISOString();
    const to = new Date(Math.min(Date.parse(cutoff), anchor + 20 * 60_000 + 1)).toISOString();
    const existing = cursor.queue.find(window => window.purpose === "context" && window.from === from && window.to === to);
    if (existing) existing.anchor_times = [...new Set([...(existing.anchor_times ?? []), anchor])];
    else cursor.queue.push({ from, to, depth: 0, purpose: "context", anchor_times: [anchor] });
  }
}
export function takeHistoryWindow(cursor: Pick<HistoryCursor, "queue">): HistoryWindow | undefined {
  const firstCore = cursor.queue.findIndex(window => window.purpose !== "context");
  return cursor.queue.splice(firstCore < 0 ? 0 : firstCore, 1)[0];
}
