import { mkdir, realpath, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

export interface WikiLock { readonly root: string; readonly token: string; release(): Promise<void> }
export function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
/** This path is per canonical Wiki root, independent of the caller's data directory. */
export async function wikiLockLocation(wikiRoot: string): Promise<string> {
  if (!isAbsolute(wikiRoot)) throw new Error('wiki_root must be absolute');
  const root = await realpath(wikiRoot);
  const key = createHash('sha256').update(root).digest('hex');
  return join(tmpdir(), `llm-bookkeeping-writer-${process.getuid?.() ?? 'local'}`, key);
}
/** Nonblocking acquisition. PID liveness, never age/TTL, determines reclamation. */
export async function acquireWikiLock(wikiRoot: string): Promise<WikiLock | null> {
  const root = await realpath(resolve(wikiRoot));
  const location = await wikiLockLocation(wikiRoot);
  await mkdir(location, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const candidate = join(location, `candidate-${token}`);
  const active = join(location, 'active');
  await mkdir(candidate, { mode: 0o700 });
  // Fully populate a NONEMPTY candidate before it can become visible as active.
  await writeFile(join(candidate, 'owner.json'), JSON.stringify({ schema_version: 1, token, pid: process.pid, root }), { flag: 'wx', mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await rename(candidate, active);
        let released = false;
        return { root, token, async release() {
          if (released) return;
          const owner = JSON.parse(await readFile(join(active, 'owner.json'), 'utf8'));
          if (owner.token !== token || owner.pid !== process.pid) throw new Error('Wiki lock ownership changed');
          await rm(active, { recursive: true });
          released = true;
        } };
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
      let owner: { pid: number; token: string; root: string };
      try { owner = JSON.parse(await readFile(join(active, 'owner.json'), 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; return null; }
      if (owner.root !== root || !/^[\da-f-]{36}$/.test(owner.token) || processIsAlive(owner.pid)) return null;
      // Keep the nonempty tombstone permanently. Two reclaimers of the same dead
      // owner cannot rename a later live active directory into this destination:
      // POSIX rename rejects an already nonempty destination directory.
      try { await rename(active, join(location, `dead-${owner.token}`)); }
      catch (error) { if (!['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    }
    return null;
  } finally { await rm(candidate, { recursive: true, force: true }); }
}
export async function withWikiLock<T>(wikiRoot: string, operation: (lock: WikiLock) => Promise<T>): Promise<T | null> {
  const lock = await acquireWikiLock(wikiRoot);
  if (!lock) return null;
  try { return await operation(lock); } finally { await lock.release(); }
}
export async function assertWikiLockHeld(lock: WikiLock): Promise<void> {
  const owner = JSON.parse(await readFile(join(await wikiLockLocation(lock.root), 'active', 'owner.json'), 'utf8'));
  if (owner.pid !== process.pid || owner.token !== lock.token || owner.root !== lock.root) throw new Error('Wiki lock is not held by this writer');
}
