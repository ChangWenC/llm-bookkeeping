import type { CollectRequest, CoverageGap } from "../contracts/types.ts";
import { gap } from "./common.ts";
export interface HistoryWindow {
  from: string;
  to: string;
  depth: number;
  purpose?: "core" | "context";
  anchor_times?: number[];
}
export interface HistoryCursor {
  root_from: string;
  root_to: string;
  queue: HistoryWindow[];
  blocked: HistoryWindow[];
}
export function initializeHistory(
  request: CollectRequest,
  saved: unknown,
): HistoryCursor {
  const old = saved as HistoryCursor | undefined;
  if (!old || old.root_from !== request.range.from || !Array.isArray(old.queue))
    return {
      root_from: request.range.from,
      root_to: request.range.to,
      queue: [{ from: request.range.from, to: request.range.to, depth: 0 }],
      blocked: [],
    };
  const cursor = structuredClone(old);
  if (Date.parse(request.range.to) > Date.parse(cursor.root_to)) {
    cursor.queue.push({ from: cursor.root_to, to: request.range.to, depth: 0 });
    cursor.root_to = request.range.to;
  }
  return cursor;
}
/** Split windows without interpreting asc as the earliest page. Same-second caps are irreducible. */
export function recordHistoryWindow(
  cursor: HistoryCursor,
  window: HistoryWindow,
  capped: boolean,
): void {
  if (!capped) return;
  const from = Date.parse(window.from),
    to = Date.parse(window.to);
  const middle = Math.floor((from + to) / 2000) * 1000;
  if (
    to - from <= 1000 ||
    middle <= from ||
    middle >= to ||
    window.depth >= 32
  ) {
    cursor.blocked.push(window);
    return;
  }
  cursor.queue.push(
    {
      ...window,
      from: window.from,
      to: new Date(middle).toISOString(),
      depth: window.depth + 1,
    },
    {
      ...window,
      from: new Date(middle).toISOString(),
      to: window.to,
      depth: window.depth + 1,
    },
  );
}
export function historyGaps(
  cursor: HistoryCursor,
  chat: string,
): CoverageGap[] {
  const gaps: CoverageGap[] = cursor.blocked.map((window) => ({
    schema_version: 1 as const,
    range: { schema_version: 1 as const, from: window.from, to: window.to },
    reason: window.purpose === "context" ? "wechat_group_context_dense_requires_import" : "wechat_dense_second_or_split_limit_requires_import",
    locator: chat,
    resumable: true,
  }));
  if (cursor.queue.length)
    gaps.push(
      gap(`wechat_history_windows_pending:${cursor.queue.length}`, chat),
    );
  return gaps;
}

/** Context is a separate exact window, never an expansion of a core paging query. */
export function queueGroupContext(cursor: HistoryCursor, anchors: number[], cutoff: string): void {
  for (const anchor of anchors) {
    const from = new Date(anchor - 20 * 60_000).toISOString();
    const to = new Date(Math.min(Date.parse(cutoff), anchor + 20 * 60_000 + 1)).toISOString();
    const existing = cursor.queue.find(window => window.purpose === "context" && window.from === from && window.to === to);
    if (existing) existing.anchor_times = [...new Set([...(existing.anchor_times ?? []), anchor])];
    else cursor.queue.push({ from, to, depth: 0, purpose: "context", anchor_times: [anchor] });
  }
}

export function takeHistoryWindow(cursor: HistoryCursor): HistoryWindow | undefined {
  const firstCore = cursor.queue.findIndex(window => window.purpose !== "context");
  return cursor.queue.splice(firstCore < 0 ? 0 : firstCore, 1)[0];
}
