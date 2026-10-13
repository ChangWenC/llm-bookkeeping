import type { SourceEvent, CoverageGap } from "../contracts/types.ts";
import { gap } from "./common.ts";

/** Completion is metadata for the same native record, not another occurrence. */
export function isClaudeCompletion(event: SourceEvent): boolean {
  return event.source.provider === "claude" && event.source.message_id !== null &&
    event.role === "assistant" && event.context.turn_complete === true;
}

function comparable(event: SourceEvent): string {
  const context = { ...event.context };
  delete context.turn_complete;
  delete context.stop_reason;
  const ordered = (value: any): any => Array.isArray(value) ? value.map(ordered) :
    value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
  return JSON.stringify(ordered({ ...event, locator: null, fragment_ref: null, physical_order: null, context }));
}

/** A single batch cannot contain duplicate IDs. Preserve both immutable raw rows. */
export function coalesceNativeUpdates(events: SourceEvent[]): { events: SourceEvent[]; gaps: CoverageGap[] } {
  const byId = new Map<string, SourceEvent>();
  const gaps: CoverageGap[] = [];
  for (const incoming of events) {
    const previous = byId.get(incoming.event_id);
    if (!previous) { byId.set(incoming.event_id, incoming); continue; }
    if (!isClaudeCompletion(incoming)) continue;
    if (comparable(previous) !== comparable(incoming)) {
      gaps.push(gap(`native_event_update_conflict:${incoming.event_id}`, incoming.locator));
      continue;
    }
    // Retain the original physical locator and its matching row reference. Both
    // raw rows remain in the batch; completion enriches metadata only, just as
    // Store does for an identical native record in a subsequent atomic batch.
    byId.set(incoming.event_id, { ...previous,
      context: { ...previous.context, ...incoming.context, turn_complete: true,
        ...(previous.context.incomplete_turn === true ? { incomplete_turn: true } : {}) } });
  }
  return { events: [...byId.values()], gaps };
}
