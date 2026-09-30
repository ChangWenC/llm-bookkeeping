import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BookkeepingConfig, ProviderConfig } from "../contracts/types.ts";
import { hash } from "./common.ts";

export interface DirectoryManifest {
  id: string;
  offset: number;
  bytes: number;
  entries: number;
  complete: boolean;
  reason: string | null;
}
export interface ManifestBudget {
  deadline: number;
  remaining: number;
}
interface ManifestEntry { name: string; kind: "directory" | "file" | "other" }

async function canonicalMissing(target: string): Promise<string> {
  try { return await realpath(target); }
  catch (error: any) {
    if (error.code !== "ENOENT") throw error;
    const parent = path.dirname(target);
    if (parent === target) throw error;
    return path.join(await canonicalMissing(parent), path.basename(target));
  }
}
const within = (target: string, root: string) => target === root || target.startsWith(root + path.sep);

/** Derived metadata stays in the local state tree, never in a source or Wiki root. */
export async function manifestDirectory(config: BookkeepingConfig, source: ProviderConfig, scope: string): Promise<string> {
  if (!path.isAbsolute(config.data_dir)) throw new Error("manifest_data_dir_not_absolute");
  const data = await canonicalMissing(config.data_dir);
  const wiki = await canonicalMissing(config.wiki_root);
  const sourceRoots = await Promise.all(source.roots.map(root => canonicalMissing(root).catch(() => path.resolve(root))));
  if (/\/(?:Mobile Documents|CloudStorage)(?:\/|$)/.test(data) ||
      [wiki, ...sourceRoots].some(root => within(data, root) || within(root, data)))
    throw new Error("manifest_data_dir_overlaps_wiki_source_or_cloud");
  await mkdir(data, { recursive: true, mode: 0o700 });
  let current = data;
  for (const part of ["adapters", "discovery", hash(`${source.provider}:${source.account_id}:${scope}`)]) {
    current = path.join(current, part);
    await mkdir(current, { mode: 0o700 }).catch((error: any) => { if (error.code !== "EEXIST") throw error; });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe_manifest_directory");
  }
  return current;
}

async function approvedDirectory(directory: string, source: ProviderConfig): Promise<void> {
  const actual = await realpath(directory);
  const resolved = await Promise.allSettled(source.roots.map(root => realpath(root)));
  const roots = resolved.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
  if (!roots.some(root => within(actual, root))) throw new Error("discovery_directory_outside_source_roots");
}

export async function buildManifest(
  directory: string, storage: string, source: ProviderConfig, budget: ManifestBudget,
): Promise<DirectoryManifest> {
  await approvedDirectory(directory, source);
  const before = await stat(directory);
  const dir = await opendir(directory, { bufferSize: 1 });
  const records: Buffer[] = [];
  let bytes = 0;
  let entries = 0;
  let complete = false;
  let reason: string | null = null;
  try {
    while (Date.now() < budget.deadline) {
      const entry = await dir.read();
      if (!entry) { complete = true; break; }
      const kind = entry.isDirectory() && !entry.isSymbolicLink() ? "directory" : entry.isFile() ? "file" : "other";
      const record = Buffer.from(JSON.stringify({ name: entry.name, kind }) + "\n");
      if (record.length > budget.remaining) { reason = "metadata_byte_budget"; break; }
      budget.remaining -= record.length;
      records.push(record);
      bytes += record.length;
      entries++;
    }
    if (!complete && !reason) reason = "metadata_time_budget";
  } finally { await dir.close(); }
  const after = await stat(directory);
  if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs) {
    complete = false;
    reason = "directory_changed_during_snapshot";
  }
  const content = Buffer.concat(records, bytes);
  const id = hash(Buffer.concat([Buffer.from(`${complete}:${reason}:`), content]));
  if (!bytes) return { id, offset: 0, bytes, entries, complete, reason };
  const target = path.join(storage, id + ".jsonl");
  const temporary = path.join(storage, `${id}.${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(content); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, target); }
  finally { await unlink(temporary).catch((error: any) => { if (error.code !== "ENOENT") throw error; }); }
  return { id, offset: 0, bytes, entries, complete, reason };
}

/** A byte offset in a regular immutable file survives process restart. */
export async function consumeManifest(
  storage: string, manifest: DirectoryManifest, limit: number, budget: ManifestBudget,
): Promise<{ entries: ManifestEntry[]; done: boolean }> {
  if (!/^[0-9a-f]{64}$/.test(manifest.id) || !Number.isSafeInteger(manifest.offset) ||
      manifest.offset < 0 || manifest.offset > manifest.bytes)
    throw new Error("invalid_manifest_cursor");
  if (!manifest.bytes) return { entries: [], done: true };
  const filename = path.join(storage, manifest.id + ".jsonl");
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  const result: ManifestEntry[] = [];
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== manifest.bytes) throw new Error("manifest_size_changed");
    while (result.length < limit && manifest.offset < manifest.bytes && Date.now() < budget.deadline) {
      // Native filenames cannot exceed this bounded record size. No full-manifest
      // reread is needed when resuming at an already committed byte offset.
      const length = Math.min(64 * 1024, manifest.bytes - manifest.offset, budget.remaining);
      if (!length) break;
      const buffer = Buffer.alloc(length);
      const read = await handle.read(buffer, 0, length, manifest.offset);
      budget.remaining -= read.bytesRead;
      let position = 0;
      while (result.length < limit && Date.now() < budget.deadline) {
        const newline = buffer.subarray(0, read.bytesRead).indexOf(10, position);
        if (newline < 0) break;
        if (newline - position > 4096) throw new Error("manifest_record_oversized");
        const entry = JSON.parse(buffer.subarray(position, newline).toString("utf8"));
        if (typeof entry.name !== "string" || !entry.name || [".", ".."].includes(entry.name) ||
            entry.name.includes("/") || entry.name.includes("\0") || !["file", "directory", "other"].includes(entry.kind))
          throw new Error("invalid_manifest_entry");
        manifest.offset += newline + 1 - position;
        position = newline + 1;
        result.push(entry);
      }
      if (!position) break;
    }
  } finally { await handle.close(); }
  return { entries: result, done: manifest.offset === manifest.bytes };
}
