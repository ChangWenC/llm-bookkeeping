import { stat } from "node:fs/promises";
import path from "node:path";
import type {
  SourceAdapter,
  ProviderConfig,
  BookkeepingConfig,
  CollectRequest,
  AdapterContext,
  CollectionBatch,
  SourceCheckpoint,
  CoverageGap,
  SourceEvent,
} from "../contracts/types.ts";
import { coverage, gap, hash } from "./common.ts";
import type { ParseState } from "./parsers.ts";
import { buildManifest, consumeManifest, manifestDirectory, type DirectoryManifest, type ManifestBudget } from "./discovery-manifest.ts";
import {
  openApprovedSource,
  parseHeader,
  readTail,
  parseCapturedLines,
} from "./file-reader.ts";
function uniqueEvents(events: SourceEvent[]): SourceEvent[] {
  const byId = new Map<string, SourceEvent>();
  for (const e of events) if (!byId.has(e.event_id)) byId.set(e.event_id, e);
  return [...byId.values()];
}
const HEAD = 64 * 1024,
  STEP = 1024 * 1024,
  TAIL = 8 * STEP;
interface DirectoryCursor {
  path: string;
  skip: number;
  manifest?: DirectoryManifest;
}
interface Discovery {
  directories: DirectoryCursor[];
  files: string[];
  root_index: number;
  cycle: number;
  known_skip?: number;
  incomplete_directories?: DirectoryCursor[];
}
interface FileCursor {
  identity: string;
  offset: number;
  history_end: number;
  size: number;
  header_hash: string;
  anchor: string | null;
  anchor_length?: number;
  anchor_uncertainty?: {
    from: number;
    to: number;
    generation: string;
    reason: string;
  };
  inode: string;
  excluded: boolean;
  account_id?: string;
  source_scope?: string;
  pending_line_base64?: string;
  pending_line_start?: number;
  parse_state?: ParseState;
  recent_event_ids?: string[];
}
export class FileAdapter implements SourceAdapter {
  readonly provider: string;
  private source: ProviderConfig;
  private config: BookkeepingConfig;
  constructor(source: ProviderConfig, config: BookkeepingConfig) {
    this.source = source;
    this.config = config;
    this.provider = source.provider;
  }
  private async scanDirectories(
    d: Discovery,
    candidates: string[],
    limit: number,
    deadline: number,
    duration: number,
    scope: string,
  ): Promise<CoverageGap[]> {
    let visited = 0;
    const discoveryGaps: CoverageGap[] = [];
    const options = this.source.options.discovery_manifest_budget as any;
    const finite = (value: unknown, fallback: number, maximum: number) =>
      typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(maximum, Math.floor(value)) : fallback;
    const budget: ManifestBudget = {
      deadline: Math.min(deadline, Date.now() + Math.min(duration / 4, finite(options?.max_duration_ms, 5000, 30000))),
      remaining: finite(options?.max_bytes, 4 * STEP, 64 * STEP),
    };
    let storage: string;
    try { storage = await manifestDirectory(this.config, this.source, scope); }
    catch (error: any) { return [gap(`discovery_manifest_unavailable:${error.message}`, this.config.data_dir)]; }
    while (d.directories.length && visited < limit && Date.now() < budget.deadline && budget.remaining > 0) {
      const current = d.directories[0];
      let completed = false;
      try {
        if (!current.manifest) {
          current.manifest = await buildManifest(current.path, storage, this.source, budget);
          // A legacy skip is an index into an unstable native enumeration, not a
          // seek cookie. Restart the immutable list once; stable event IDs dedup.
          current.skip = 0;
        }
        const consumed = await consumeManifest(storage, current.manifest, limit - visited, budget);
        for (const entry of consumed.entries) {
          visited++;
          current.skip++;
          const loc = path.join(current.path, entry.name);
          if (entry.kind === "directory")
            d.directories.push({ path: loc, skip: 0 });
          else if (entry.kind === "file" && /\.jsonl$/i.test(entry.name))
            candidates.push(loc);
        }
        if (!current.manifest.complete) {
          discoveryGaps.push(
            gap(`directory_manifest_partial:${current.manifest.reason}:entries:${current.manifest.entries}:bytes:${current.manifest.bytes}:raise_discovery_manifest_budget_or_narrow_root`, current.path),
          );
          if (consumed.done) {
            d.incomplete_directories ??= [];
            d.incomplete_directories = d.incomplete_directories.filter(item => item.path !== current.path);
            d.incomplete_directories.push(current);
          }
        } else if (consumed.done) {
          d.incomplete_directories = d.incomplete_directories?.filter(item => item.path !== current.path);
        }
        completed = consumed.done;
      } catch (error: any) {
        completed = true;
        if (current.manifest) {
          // Missing/corrupt derived metadata is rebuildable. Do not certify the
          // source directory as complete because its local cache failed.
          current.manifest = undefined;
          current.skip = 0;
          d.incomplete_directories ??= [];
          if (!d.incomplete_directories.some(item => item.path === current.path)) d.incomplete_directories.push(current);
        }
        if (error.code !== "ENOENT" || this.source.roots.includes(current.path))
          discoveryGaps.push(
            gap(`directory_unavailable:${error.code ?? "error"}`, current.path),
          );
      }
      if (completed) d.directories.shift();
      else break;
    }
    for (const current of d.incomplete_directories ?? [])
      discoveryGaps.push(gap(`directory_manifest_pending:${current.manifest?.reason ?? "metadata_unavailable"}:raise_discovery_manifest_budget_or_narrow_root`, current.path));
    return discoveryGaps;
  }
  async *collect(
    req: CollectRequest,
    context: AdapterContext,
  ): AsyncIterable<CollectionBatch> {
    const request = {
      ...req,
      budget: {
        max_duration_ms: Math.min(
          req.budget.max_duration_ms,
          req.lane === "live" ? 90000 : 30000,
        ),
        max_bytes: Math.min(
          req.budget.max_bytes,
          req.lane === "live" ? 64 * STEP : 32 * STEP,
        ),
        max_directory_entries: Math.min(
          65536,
          Number(
            this.source.options.max_directory_entries ??
              req.budget.max_directory_entries,
          ),
        ),
      },
    };
    const deadline = Date.now() + request.budget.max_duration_ms;
    let bytes = 0;
    const scope = hash(
      JSON.stringify([
        this.source.roots,
        this.source.options.allowed_project_roots ?? null,
        this.source.options.excluded_session_ids ?? null,
      ]),
    );
    const matches = (c: SourceCheckpoint) =>
      c.provider === this.provider &&
      c.cursor.account_id === this.source.account_id &&
      c.cursor.source_scope === scope;
    const cp = (locator: string, lane = request.lane) =>
      context.checkpoints.find(
        (c) => matches(c) && c.locator === locator && c.lane === lane,
      );
    const checkpoint = (
      locator: string,
      generation: string,
      cursor: Record<string, unknown>,
    ): SourceCheckpoint => ({
      schema_version: 1,
      checkpoint_id: hash(
        `${this.provider}:${this.source.account_id}:${request.lane}:${locator}`,
      ),
      provider: this.provider,
      lane: request.lane,
      locator,
      generation,
      cursor: {
        ...cursor,
        account_id: this.source.account_id,
        source_scope: scope,
      },
      updated_at: request.cutoff,
    });
    const make = (
      events: SourceEvent[],
      gaps: CoverageGap[],
      checkpoints: SourceCheckpoint[],
      fragments: CollectionBatch["fragments"] = [],
      conversation: string | null = null,
      status?: any,
    ): CollectionBatch => {
      const batch: CollectionBatch = {
        schema_version: 1,
        batch_id: "",
        events: uniqueEvents(events),
        fragments,
        coverage: [
          coverage(
            this.provider,
            this.source.account_id,
            request,
            gaps,
            conversation,
            status,
          ),
        ],
        checkpoints,
      };
      // Collection identity includes every immutable field. At EOF, unchanged
      // event/checkpoint IDs can accompany different fragments or coverage gaps.
      batch.batch_id = hash(JSON.stringify({ ...batch, batch_id: null }));
      return batch;
    };
    if (!this.source.enabled) {
      yield make([], [], [], [], null, "disabled");
      return;
    }
    const dc = cp("@discovery");
    const d: Discovery = dc
      ? structuredClone(dc.cursor as unknown as Discovery)
      : { directories: [], files: [], root_index: 0, cycle: 0 };
    // Recent Codex day directories are visited before an otherwise persistent traversal.
    if (!dc && this.provider === "codex")
      for (const root of this.source.roots)
        for (let age = 0; age < 3; age++) {
          const day = new Date(Date.parse(request.cutoff) - age * 86400000)
            .toISOString()
            .slice(0, 10)
            .split("-");
          d.directories.push({ path: path.join(root, ...day), skip: 0 });
        }
    if (!dc)
      d.directories.push(
        ...this.source.roots.map((p) => ({ path: p, skip: 0 })),
      );
    const pendingPaths = new Set(
      context.checkpoints
        .filter(
          (c) =>
            matches(c) &&
            c.locator !== "@discovery" &&
            (request.lane === "live"
              ? c.lane === "live"
              : Number(c.cursor.history_end) > Number(c.cursor.offset) ||
                (c.lane === "live" && Number(c.cursor.history_end) > 0)),
        )
        .map((c) => c.locator),
    );
    const known = [...pendingPaths];
    const knownStart = d.known_skip ?? 0;
    const knownBatch = known.slice(
      knownStart,
      knownStart + request.budget.max_directory_entries,
    );
    d.known_skip =
      knownStart + knownBatch.length >= known.length
        ? 0
        : knownStart + knownBatch.length;
    const candidates = [
      ...new Set([
        ...d.files.splice(0, request.budget.max_directory_entries),
        ...knownBatch,
      ]),
    ];
    const discoveryGaps = await this.scanDirectories(
      d,
      candidates,
      request.budget.max_directory_entries,
      deadline,
      request.budget.max_duration_ms,
      scope,
    );
    const fileGaps: CoverageGap[] = [];
    const discoveryComplete =
      d.directories.length === 0 && d.files.length === 0 && !d.incomplete_directories?.length;
    // Sort bounded discovered files only; mtime is scheduling evidence, never time coverage.
    const ranked: { p: string; mtime: number }[] = [];
    for (const p of [...new Set(candidates)]) {
      if (Date.now() >= deadline) {
        d.files.push(p);
        continue;
      }
      try {
        const s = await stat(p);
        ranked.push({ p, mtime: s.mtimeMs });
      } catch (error: any) {
        yield make(
          [],
          [gap(`source_unavailable:${error.code ?? "error"}`, p)],
          [],
          [],
          null,
          "unavailable",
        );
      }
    }
    ranked.sort((a, b) => b.mtime - a.mtime || a.p.localeCompare(b.p));
    let processed = 0;
    for (const { p } of ranked) {
      if (Date.now() >= deadline || bytes >= request.budget.max_bytes) {
        d.files.push(...ranked.slice(processed).map((x) => x.p));
        break;
      }
      processed++;
      let handle;
      try {
        handle = await openApprovedSource(p, this.source.roots);
        const s = await handle.stat();
        const eof = s.size;
        const read = async (start: number, n: number): Promise<Buffer> => {
          const length = Math.min(
            n,
            Math.max(0, request.budget.max_bytes - bytes),
          );
          const b = Buffer.alloc(length);
          const r = await handle!.read(b, 0, length, start);
          bytes += r.bytesRead;
          return b.subarray(0, r.bytesRead);
        };
        if (request.budget.max_bytes - bytes < Math.min(eof, HEAD)) {
          d.files.push(p);
          continue;
        }
        const head = await read(0, Math.min(eof, HEAD));
        const { identity, header_hash: headerHash } = parseHeader(
          this.provider,
          head,
        );
        const inode = `${s.dev}:${s.ino}`;
        const existing =
          cp(p) ??
          context.checkpoints.find(
            (c) =>
              matches(c) &&
              c.lane === request.lane &&
              c.cursor.identity === identity.id &&
              identity.id !== null,
          );
        const live =
          cp(p, "live") ??
          context.checkpoints.find(
            (c) =>
              matches(c) &&
              c.lane === "live" &&
              c.cursor.identity === identity.id &&
              identity.id !== null,
          );
        let old = existing?.cursor as unknown as FileCursor | undefined;
        // Normal checkpoints supplied as witnesses never enter discovery or read
        // progress. Only scoped checkpoints may supply offsets, history boundaries,
        // pending lines, parse state or already-seen event IDs.
        const progressBase = old ?? (live?.cursor as unknown as FileCursor | undefined);
        const witness = !progressBase ? context.generation_checkpoints
          ?.filter(c => matches(c) && c.locator !== "@discovery" &&
            (c.locator === p || (identity.id !== null && c.cursor.identity === identity.id)))
          .sort((a, b) => Number(b.locator === p) - Number(a.locator === p) ||
            b.updated_at.localeCompare(a.updated_at) ||
            Number(b.lane === "live") - Number(a.lane === "live"))[0] : undefined;
        const base = progressBase ?? (witness?.cursor as unknown as FileCursor | undefined);
        let generation = existing?.generation ?? live?.generation ?? witness?.generation ?? "0";
        let anchorUncertainty = base?.anchor_uncertainty;
        let rewritten = false;
        let verifiedAnchor: string | null = null;
        const gaps: CoverageGap[] = [];
        if (witness && base && (!Number.isSafeInteger(base.offset) || base.offset < 0 ||
            typeof witness.generation !== "string" || !witness.generation ||
            typeof base.header_hash !== "string" || !/^[a-f0-9]{64}$/.test(base.header_hash) ||
            (base.anchor != null && base.anchor !== "" && (typeof base.anchor !== "string" || !/^[a-f0-9]{64}$/.test(base.anchor))))) {
          // Malformed metadata cannot identify a generation or certify an empty
          // scope. Leave this source for a later valid witness rather than reset.
          const uncertain = gap("generation_witness_metadata_invalid", p);
          fileGaps.push(uncertain);
          d.files.push(p);
          yield make([], [uncertain], [], [], identity.id, "partial");
          continue;
        }
        if (base && (eof < base.offset || base.header_hash !== headerHash)) {
          rewritten = true;
          generation = hash(
            `${generation}:${headerHash}:${eof}:${inode}`,
          ).slice(0, 20);
          old = undefined;
        } else if (base?.anchor && base.offset > 0 && base.offset <= eof) {
          const expectedLength = Math.min(128, base.offset);
          const anchor = await read(
            Math.max(0, base.offset - 128),
            expectedLength,
          );
          if (anchor.length !== expectedLength) {
            gaps.push(gap("anchor_verification_budget_pending", p));
            if (witness) anchorUncertainty ??= { from: base.offset - expectedLength, to: base.offset, generation, reason: "generation_witness_anchor_budget_pending" };
          } else if (base.anchor === hash(Buffer.alloc(0))) {
            // Older code saved hash(empty) when its read budget was exhausted.
            // This is missing evidence, never evidence of a rewritten source.
            gaps.push(gap("legacy_anchor_unproven", p));
            anchorUncertainty ??= { from: base.offset - expectedLength, to: base.offset, generation, reason: "legacy_anchor_unproven" };
          } else if (hash(anchor) === base.anchor) {
            verifiedAnchor = base.anchor;
          } else if (base.anchor_length !== expectedLength) {
            // An old checkpoint did not record whether its hash covered the full
            // requested range. A mismatch may be an old short read.
            gaps.push(gap("legacy_anchor_length_unproven", p));
            anchorUncertainty ??= { from: base.offset - expectedLength, to: base.offset, generation, reason: "legacy_anchor_length_unproven" };
          } else {
            rewritten = true;
            generation = hash(
              `${generation}:${headerHash}:${eof}:${inode}:${hash(anchor)}`,
            ).slice(0, 20);
            old = undefined;
          }
        }
        if (witness && base?.offset && !rewritten && !base.anchor) {
          gaps.push(gap("generation_witness_anchor_unproven", p));
          anchorUncertainty ??= { from: Math.max(0, base.offset - 128), to: base.offset, generation, reason: "generation_witness_anchor_unproven" };
        }
        const excluded =
          identity.classification === "subagent" ||
          identity.classification === "automation" ||
          this.excluded(identity.cwd, identity.metadata);
        if (!identity.id) gaps.push(gap("session_identity_unknown", p));
        if (rewritten)
          gaps.push(gap("source_truncated_or_rewritten_new_generation", p));
        if (anchorUncertainty)
          gaps.push(gap(`anchor_uncertainty:${anchorUncertainty.reason}:${anchorUncertainty.generation}:${anchorUncertainty.from}:${anchorUncertainty.to}:verify_saved_fragment_or_recollect_range`, p));
        if (excluded) {
          yield make(
            [],
            [],
            [
              checkpoint(p, generation, {
                identity: identity.id,
                offset: eof,
                history_end: 0,
                size: eof,
                header_hash: headerHash,
                anchor: "",
                inode,
                excluded: true,
              }),
            ],
            [],
            identity.id,
          );
          continue;
        }
        let start = 0,
          end = eof,
          historyEnd =
            old?.history_end ?? (rewritten ? 0 : (progressBase?.history_end ?? 0));
        if (request.lane === "history") {
          end =
            old?.history_end ?? (rewritten ? eof : (progressBase?.history_end ?? eof));
          start = old?.offset ?? 0;
          historyEnd = end;
        } else if (old) {
          start = old.offset;
        } else {
          start = Math.max(
            0,
            eof -
              Math.min(TAIL, Number(this.source.options.tail_bytes ?? TAIL)),
          );
          historyEnd = start;
        }
        if (request.lane === "live" && historyEnd > 0) {
          const historical =
            cp(p, "history") ??
            context.checkpoints.find(
              (c) =>
                matches(c) &&
                c.lane === "history" &&
                c.cursor.identity === identity.id,
            );
          if (
            historical?.generation === generation &&
            Number(historical.cursor.offset) >= historyEnd
          )
            historyEnd = 0;
        }
        if (start > end) start = 0;
        let buffer: Buffer = Buffer.alloc(0),
          readStart = start;
        if (request.lane === "live" && !old) {
          const tail = await readTail(
            start,
            end,
            deadline,
            () => request.budget.max_bytes - bytes,
            read,
          );
          readStart = tail.start;
          buffer = tail.buffer;
          // Reverse reading may stop before its planned start. The entire actual
          // unread prefix remains history's responsibility, including a newline
          // boundary where no partial-line adjustment will run below.
          historyEnd = Math.max(historyEnd, readStart);
          if (tail.exhausted) gaps.push(gap("tail_budget_exhausted", p));
        } else buffer = await read(start, Math.min(STEP, end - start));
        // Persist the complete unparsed suffix in the atomic checkpoint. The next range
        // starts after those captured bytes and reconstructs the line before parsing.
        let pending = old?.pending_line_base64
          ? Buffer.from(old.pending_line_base64, "base64")
          : Buffer.alloc(0);
        if (pending.length) {
          buffer = Buffer.concat([pending, buffer]);
          readStart = old!.pending_line_start!;
        }
        let sliceStart = 0;
        if (
          readStart > 0 &&
          ((request.lane === "live" && !old) ||
            (request.lane === "history" && !old && readStart > 0))
        ) {
          const preceding = await read(readStart - 1, 1);
          if (preceding[0] !== 10) {
            const n = buffer.indexOf(10);
            sliceStart = n < 0 ? buffer.length : n + 1;
            historyEnd = Math.max(historyEnd, readStart + sliceStart);
            gaps.push(gap("tail_boundary_partial_line", p));
          }
        }
        const lastNewline = buffer.lastIndexOf(10);
        let consumed = lastNewline >= sliceStart ? lastNewline + 1 : sliceStart;
        const knownEvents = new Set(old?.recent_event_ids ?? []);
        const state: ParseState = old?.parse_state
          ? structuredClone(old.parse_state)
          : {};
        const parsed = parseCapturedLines({
          provider: this.provider,
          account: this.source.account_id,
          identity,
          locator: p,
          generation,
          buffer,
          read_start: readStart,
          slice_start: sliceStart,
          consumed,
          state,
          known_events: knownEvents,
          config: this.config,
        });
        const { events, fragments: rowFragments } = parsed;
        gaps.push(...parsed.gaps);
        const parsedOffset = readStart + consumed;
        let suffix = buffer.subarray(consumed);
        let offset = readStart + buffer.length;
        if (suffix.length > 0) gaps.push(gap("incomplete_line_pending", p));
        // A configurable line cap bounds persistent continuation memory. Do not advance beyond an
        // unparsed record if it cannot fit; leave its original source range pending.
        if (
          suffix.length >
          Math.min(
            256 * STEP,
            Number(this.source.options.max_line_bytes ?? 64 * STEP),
          )
        ) {
          offset = parsedOffset;
          suffix = Buffer.alloc(0);
          gaps.push(gap("oversized_line_requires_import", p));
        }
        if (request.lane === "live" && historyEnd > 0)
          gaps.push(gap(`unread_history_prefix:0:${historyEnd}`, p));
        if (offset < end)
          gaps.push(
            gap(
              request.lane === "history"
                ? "history_remaining"
                : "append_remaining",
              p,
            ),
          );
        if (d.directories.length || d.files.length)
          gaps.push(gap("discovery_remaining"));
        const anchorLength = Math.min(128, offset);
        let anchor: string | null = null;
        if (anchorLength) {
          const anchorStart = offset - anchorLength;
          if (anchorStart >= readStart && offset <= readStart + buffer.length)
            anchor = hash(buffer.subarray(anchorStart - readStart, offset - readStart));
          else if (offset <= head.length)
            anchor = hash(head.subarray(anchorStart, offset));
          else if (offset === base?.offset && verifiedAnchor)
            anchor = verifiedAnchor;
          else if (offset === base?.offset && base.anchor_length === anchorLength &&
              base.anchor && base.anchor !== hash(Buffer.alloc(0)))
            // No bytes advanced when validation ran out of budget. Retain the
            // previous complete witness so a later full comparison remains useful.
            anchor = base.anchor;
          else {
            const bytes = await read(anchorStart, anchorLength);
            if (bytes.length === anchorLength) anchor = hash(bytes);
          }
          if (!anchor) gaps.push(gap("checkpoint_anchor_unknown", p));
        }
        const fragmentId = hash(
          `${this.provider}:${this.source.account_id}:${identity.id}:${generation}:${readStart}:${hash(buffer)}`,
        );
        const fragment = {
          schema_version: 1 as const,
          fragment_id: fragmentId,
          locator: `source:${this.provider}:${this.source.account_id}:${identity.id}:${generation}:${readStart}:${readStart + buffer.length}`,
          bytes_base64: buffer.toString("base64"),
          sha256: hash(buffer),
        };
        fileGaps.push(...gaps);
        yield make(
          events,
          gaps,
          [
            checkpoint(p, generation, {
              identity: identity.id,
              offset,
              history_end: historyEnd,
              size: eof,
              header_hash: headerHash,
              anchor,
              anchor_length: anchor ? anchorLength : 0,
              ...(anchorUncertainty ? { anchor_uncertainty: anchorUncertainty } : {}),
              inode,
              excluded: false,
              pending_line_base64: suffix.toString("base64"),
              pending_line_start: parsedOffset,
              parse_state: state,
              recent_event_ids: [...knownEvents].slice(-10000),
            }),
          ],
          buffer.length ? [fragment, ...rowFragments] : rowFragments,
          identity.id,
        );
      } catch (error: any) {
        yield make(
          [],
          [gap(`source_unavailable:${error.code ?? "error"}`, p)],
          [],
          [],
          null,
          "unavailable",
        );
      } finally {
        await handle?.close();
      }
    }
    if (!d.directories.length && !d.files.length) {
      d.cycle++;
      d.directories = this.source.roots.map((p) => ({ path: p, skip: 0 }));
    }
    const unresolved = [...discoveryGaps, ...fileGaps];
    if (!discoveryComplete || d.files.length)
      unresolved.push(gap("discovery_remaining"));
    if (!discoveryComplete)
      unresolved.push(gap("source_discovery_snapshot_partial"));
    yield make(
      [],
      unresolved,
      [checkpoint("@discovery", "0", d as unknown as Record<string, unknown>)],
      [],
      null,
      ranked.length === 0 && discoveryGaps.some(item => item.reason.startsWith("directory_unavailable") || item.reason.startsWith("discovery_manifest_unavailable")) ? "unavailable" : undefined,
    );
  }
  async close(): Promise<void> {
    // Source and manifest handles close in each bounded operation; no process-
    // local directory handle is required for resumption.
  }
  private excluded(cwd: string | null, meta: Record<string, unknown>): boolean {
    const options = this.source.options;
    const ids = Array.isArray(options.excluded_session_ids)
      ? options.excluded_session_ids.map(String)
      : [];
    if (ids.includes(String(meta.id ?? meta.sessionId))) return true;
    const roots = Array.isArray(options.allowed_project_roots)
      ? options.allowed_project_roots.map(String)
      : [];
    return (
      roots.length > 0 &&
      (!cwd ||
        !roots.some((root) => cwd === root || cwd.startsWith(root + path.sep)))
    );
  }
  replay(range: any, context: AdapterContext) {
    return this.collect(
      {
        lane: "history",
        range,
        cutoff: range.to,
        budget: {
          max_duration_ms: 30000,
          max_bytes: 32 * STEP,
          max_directory_entries: 2000,
        },
      },
      {
        ...context,
        checkpoints: context.checkpoints.filter(
          (c) => c.locator === "@discovery",
        ),
      },
    );
  }
}
