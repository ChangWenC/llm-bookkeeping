import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { BookkeepingConfig, SourceCheckpoint, RawFragment } from "../contracts/types.ts";
import { createStore } from "../store/index.ts";
import { openApprovedSource, parseHeader } from "./file-reader.ts";

const EMPTY = digest(Buffer.alloc(0));
const MAX_EVIDENCE_BYTES = 64 * 1024 * 1024;
function canonical(value: any): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  return JSON.stringify(value);
}
function digest(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
interface Witness {
  from: number; to: number; fragment_id: string; fragment_sha256: string;
  saved_sha256: string; current_sha256: string;
}
interface PlannedAnchor {
  checkpoint_id: string; checkpoint_sha256: string | null;
  status: "verified" | "pending"; reason: string | null; witnesses: Witness[];
}
export interface AnchorPlan {
  schema_version: 1; kind: "single-writer-anchor-reconciliation";
  config_sha256: string; witness_fragment_ids: string[]; entries: PlannedAnchor[];
}
export const anchorPlanSha256 = (plan: AnchorPlan): string => digest(canonical(plan));

function scope(config: BookkeepingConfig, checkpoint: SourceCheckpoint) {
  const provider = config.providers.find(source => source.enabled && source.provider === checkpoint.provider &&
    source.account_id === checkpoint.cursor.account_id);
  if (!provider || !["codex", "claude"].includes(provider.provider)) throw new Error("source_scope_not_enabled");
  const expected = digest(JSON.stringify([provider.roots, provider.options.allowed_project_roots ?? null,
    provider.options.excluded_session_ids ?? null]));
  if (checkpoint.cursor.source_scope !== expected) throw new Error("source_scope_changed");
  return provider;
}

// Select a complete single witness using only canonical source locator ranges.
// This read-only query never joins by physical file path or by message text.
function* witnessRows(db: DatabaseSync, prefix: string, witnessIds: string[]): Generator<RawFragment> {
  const query = db.prepare(`SELECT json FROM fragments WHERE id=? AND length(json)<=12582912
    AND substr(json_extract(json,'$.locator'),1,?)=?`);
  for (const id of witnessIds) {
    const row: any = query.get(id, prefix.length, prefix);
    if (row) {
      const fragment = JSON.parse(row.json) as RawFragment;
      if (fragment.schema_version === 1 && fragment.fragment_id === id &&
          typeof fragment.locator === "string" && typeof fragment.bytes_base64 === "string" &&
          typeof fragment.sha256 === "string") yield fragment;
    }
  }
}

async function inspectCheckpoint(db: DatabaseSync, config: BookkeepingConfig, checkpoint: SourceCheckpoint,
  witnessIds: string[], remaining: { bytes: number }): Promise<{ entry: PlannedAnchor; updated?: SourceCheckpoint }> {
  const entry: PlannedAnchor = { checkpoint_id: checkpoint.checkpoint_id,
    checkpoint_sha256: digest(canonical(checkpoint)), status: "pending", reason: null, witnesses: [] };
  let handle: Awaited<ReturnType<typeof openApprovedSource>> | undefined;
  try {
    const cursor = checkpoint.cursor;
    if (cursor.excluded || !(cursor.anchor === EMPTY || cursor.anchor_uncertainty)) throw new Error("not_legacy_empty_or_uncertain");
    const provider = scope(config, checkpoint);
    const offset = cursor.offset as number;
    if (!Number.isSafeInteger(offset) || offset <= 0 || typeof cursor.identity !== "string") throw new Error("invalid_file_cursor");
    const uncertainty = cursor.anchor_uncertainty as any;
    if (uncertainty && (uncertainty.generation !== checkpoint.generation ||
        !Number.isSafeInteger(uncertainty.from) || !Number.isSafeInteger(uncertainty.to) ||
        uncertainty.from < 0 || uncertainty.to > offset || uncertainty.to - uncertainty.from < 1 ||
        uncertainty.to - uncertainty.from > 128)) throw new Error("uncertainty_range_not_proven");
    handle = await openApprovedSource(checkpoint.locator, provider.roots);
    const before = await handle.stat();
    if (!before.isFile() || `${before.dev}:${before.ino}` !== cursor.inode || before.size < offset)
      throw new Error("source_inode_or_extent_changed");
    const head = Buffer.alloc(Math.min(65536, before.size));
    const headerRead = await handle.read(head, 0, head.length, 0);
    if (headerRead.bytesRead !== head.length) throw new Error("source_header_short_read");
    const header = parseHeader(provider.provider, head);
    if (header.identity.id !== cursor.identity || header.header_hash !== cursor.header_hash)
      throw new Error("source_identity_or_header_changed");
    const ranges = [{ from: Math.max(0, offset - 128), to: offset }];
    if (uncertainty && !ranges.some(range => range.from === uncertainty.from && range.to === uncertainty.to))
      ranges.push({ from: uncertainty.from, to: uncertainty.to });
    const prefix = `source:${provider.provider}:${provider.account_id}:${cursor.identity}:${checkpoint.generation}:`;
    for (const range of ranges) {
      let witness: Witness | undefined;
      for (const fragment of witnessRows(db, prefix, witnessIds)) {
        const suffix = fragment.locator.slice(prefix.length).match(/^(\d+):(\d+)$/);
        if (!fragment.locator.startsWith(prefix) || !suffix) continue;
        const first = Number(suffix[1]), last = Number(suffix[2]);
        if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first > range.from || last < range.to) continue;
        const bytes = Buffer.from(fragment.bytes_base64, "base64");
        if (bytes.length > remaining.bytes) throw new Error("saved_evidence_byte_budget_pending");
        remaining.bytes -= bytes.length;
        if (bytes.toString("base64") !== fragment.bytes_base64 || bytes.length !== last - first || digest(bytes) !== fragment.sha256) continue;
        const saved = bytes.subarray(range.from - first, range.to - first);
        const current = Buffer.alloc(range.to - range.from);
        const read = await handle.read(current, 0, current.length, range.from);
        if (read.bytesRead !== current.length || !saved.equals(current)) throw new Error("saved_current_anchor_mismatch");
        witness = { ...range, fragment_id: fragment.fragment_id, fragment_sha256: fragment.sha256,
          saved_sha256: digest(saved), current_sha256: digest(current) };
        break;
      }
      if (!witness) throw new Error("complete_saved_fragment_witness_missing");
      entry.witnesses.push(witness);
    }
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("source_changed_during_verification");
    const updated: SourceCheckpoint = structuredClone(checkpoint);
    updated.cursor.anchor = entry.witnesses[0].current_sha256;
    updated.cursor.anchor_length = ranges[0].to - ranges[0].from;
    delete updated.cursor.anchor_uncertainty;
    entry.status = "verified";
    return { entry, updated };
  } catch (error) {
    // Reason codes intentionally omit source body and arbitrary filesystem errors.
    const reason = (error as Error).message;
    entry.reason = /^[a-z_]+$/.test(reason) ? reason : "source_or_saved_evidence_unavailable";
    return { entry };
  } finally { await handle?.close(); }
}

async function inspect(config: BookkeepingConfig, checkpointIds: string[], witnessIds: string[]) {
  if (!checkpointIds.length || checkpointIds.length > 16 || new Set(checkpointIds).size !== checkpointIds.length)
    throw new Error("Specify one to sixteen unique checkpoint IDs");
  if (witnessIds.length > 32 || new Set(witnessIds).size !== witnessIds.length ||
      witnessIds.some(id => typeof id !== "string" || !id)) throw new Error("Specify at most thirty-two unique witness fragment IDs");
  const databasePath = join(config.data_dir, "bookkeeping.sqlite");
  const file = await lstat(databasePath);
  if (!file.isFile() || file.isSymbolicLink()) throw new Error("Maintenance requires a regular local Store database");
  const db = new DatabaseSync(databasePath, { readOnly: true });
  const entries: PlannedAnchor[] = [], updates: SourceCheckpoint[] = [];
  const remaining = { bytes: MAX_EVIDENCE_BYTES };
  try {
    for (const id of [...checkpointIds].sort()) {
      const row: any = db.prepare("SELECT json FROM checkpoints WHERE id=?").get(id);
      if (!row) { entries.push({ checkpoint_id: id, checkpoint_sha256: null, status: "pending", reason: "checkpoint_missing", witnesses: [] }); continue; }
      const result = await inspectCheckpoint(db, config, JSON.parse(row.json), [...witnessIds].sort(), remaining);
      entries.push(result.entry);
      if (result.updated) updates.push(result.updated);
    }
  } finally { db.close(); }
  const plan: AnchorPlan = { schema_version: 1, kind: "single-writer-anchor-reconciliation",
    config_sha256: digest(canonical(config)), witness_fragment_ids: [...witnessIds].sort(), entries };
  return { plan, updates };
}

/** Report performs only read-only SQLite/source reads; it does not construct a Store. */
export async function reportAnchors(config: BookkeepingConfig, checkpointIds: string[], witnessIds: string[]): Promise<AnchorPlan> {
  return (await inspect(config, checkpointIds, witnessIds)).plan;
}

/** Requires an externally enforced single writer. A plan hash is NOT a concurrent-writer CAS. */
export async function applyAnchors(config: BookkeepingConfig, plan: AnchorPlan, expectedPlanSha256: string,
  singleWriterConfirmed: boolean): Promise<{ updated: number; pending: number }> {
  if (!singleWriterConfirmed) throw new Error("Single writer must be confirmed with schedules paused and no in-flight runs");
  if (plan.schema_version !== 1 || plan.kind !== "single-writer-anchor-reconciliation" ||
      anchorPlanSha256(plan) !== expectedPlanSha256) throw new Error("Preview plan SHA mismatch");
  const fresh = await inspect(config, plan.entries.map(entry => entry.checkpoint_id), plan.witness_fragment_ids);
  if (anchorPlanSha256(fresh.plan) !== expectedPlanSha256) throw new Error("Fresh verification differs from preview; no checkpoint was written");
  if (fresh.updates.length) {
    const store = await createStore(config);
    try {
      await store.saveCollection({ schema_version: 1, batch_id: `anchor-maintenance:${expectedPlanSha256}`,
        events: [], fragments: [], coverage: [], checkpoints: fresh.updates });
    } finally { store.close(); }
  }
  return { updated: fresh.updates.length, pending: fresh.plan.entries.length - fresh.updates.length };
}
