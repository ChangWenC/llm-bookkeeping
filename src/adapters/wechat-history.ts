import type { CollectRequest, CoverageGap } from "../contracts/types.ts";
import { gap } from "./common.ts";
export interface HistoryWindow {
  from: string;
  to: string;
  depth: number;
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
      from: window.from,
      to: new Date(middle).toISOString(),
      depth: window.depth + 1,
    },
    {
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
  const gaps = cursor.blocked.map((window) => ({
    schema_version: 1 as const,
    range: { schema_version: 1 as const, from: window.from, to: window.to },
    reason: "wechat_dense_second_or_split_limit_requires_import",
    locator: chat,
    resumable: true,
  }));
  if (cursor.queue.length)
    gaps.push(
      gap(`wechat_history_windows_pending:${cursor.queue.length}`, chat),
    );
  return gaps;
}
