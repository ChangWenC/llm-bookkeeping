import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type {
  BookkeepingConfig,
  SourceEvent,
  CollectionBatch,
  CoverageGap,
} from "../contracts/types.ts";
import { gap, hash, parseLossless } from "./common.ts";
import {
  sessionIdentity,
  parseSessionRow,
  type SessionIdentity,
  type ParseState,
} from "./parsers.ts";
export async function openApprovedSource(locator: string, roots: string[]) {
  const resolved = await realpath(locator);
  const approved = await Promise.all(
    roots.map(async (root) => {
      try {
        return await realpath(root);
      } catch {
        return path.resolve(root);
      }
    }),
  );
  if (
    !approved.some(
      (root) => resolved === root || resolved.startsWith(root + path.sep),
    )
  )
    throw Object.assign(new Error("outside_root"), {
      code: "SOURCE_OUTSIDE_ROOT",
    });
  return open(locator, constants.O_RDONLY | constants.O_NOFOLLOW);
}
export function parseHeader(provider: string, head: Buffer) {
  const rows: any[] = [];
  const end = head.lastIndexOf(10);
  for (const line of head
    .subarray(0, end + 1)
    .toString("utf8")
    .split("\n"))
    if (line.trim())
      try {
        rows.push(parseLossless(line));
      } catch {}
  return {
    identity: sessionIdentity(provider, rows),
    header_hash: hash(head.subarray(0, Math.max(0, head.indexOf(10) + 1))),
  };
}
export async function readTail(
  start: number,
  end: number,
  deadline: number,
  remaining: () => number,
  read: (start: number, length: number) => Promise<Buffer>,
) {
  let at = end;
  const parts: Buffer[] = [];
  while (at > start && Date.now() < deadline && remaining() > 0) {
    const length = Math.min(1024 * 1024, at - start, remaining());
    if (length <= 0) break;
    at -= length;
    parts.unshift(await read(at, length));
  }
  return { buffer: Buffer.concat(parts), start: at, exhausted: at > start };
}
export function parseCapturedLines(input: {
  provider: string;
  account: string;
  identity: SessionIdentity;
  locator: string;
  generation: string;
  buffer: Buffer;
  read_start: number;
  slice_start: number;
  consumed: number;
  state: ParseState;
  known_events: Set<string>;
  config: BookkeepingConfig;
}) {
  const events: SourceEvent[] = [],
    fragments: CollectionBatch["fragments"] = [],
    gaps: CoverageGap[] = [];
  let pos = input.slice_start;
  while (pos < input.consumed) {
    const next = input.buffer.indexOf(10, pos);
    const raw = input.buffer.subarray(pos, next);
    if (raw.length)
      try {
        const row = parseLossless(raw.toString("utf8"));
        const parsed = parseSessionRow(
          input.provider,
          row,
          input.identity,
          input.locator,
          input.generation,
          input.read_start + pos,
          input.config,
          input.state,
          input.account,
        );
        const canonicalLocator = `source:${input.provider}:${input.account}:${input.identity.id}:${input.generation}:${input.read_start + pos}:${input.read_start + next}`;
        const fragmentId = hash(`${canonicalLocator}:${hash(raw)}`);
        if (parsed.length)
          fragments.push({
            schema_version: 1,
            fragment_id: fragmentId,
            locator: canonicalLocator,
            bytes_base64: raw.toString("base64"),
            sha256: hash(raw),
          });
        for (const e of parsed) {
          e.fragment_ref = fragmentId;
          if (e.source.message_id && input.known_events.has(e.event_id) &&
              e.classification !== "automation")
            continue;
          input.known_events.add(e.event_id);
          events.push(e);
          if (e.utc_time.value === null)
            gaps.push(gap(e.utc_time.reason ?? "time_unknown", input.locator));
          if (e.classification === "unknown")
            gaps.push(gap("source_turn_origin_unknown", input.locator));
        }
      } catch {
        input.state.lastTime = undefined;
        input.state.mirror = undefined;
        input.state.cwd = undefined;
        input.state.codex_turn_origin = undefined;
        gaps.push(
          gap(`malformed_line_at:${input.read_start + pos}`, input.locator),
        );
      }
    pos = next + 1;
  }
  return { events, fragments, gaps };
}
