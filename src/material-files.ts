import { readFile, mkdir, open, rename, chmod, lstat, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { absolutePath, canonicalLocation, validateDataLocation } from './config.ts';
import { InputError, parseJsonPreservingIntegers } from './contracts/validation.ts';
import { markStorageFailure, storageFailureCode } from './storage-errors.ts';
import type { BookkeepingConfig } from './contracts/types.ts';

export const MAX_PRIVATE_JSON_BYTES = 16 * 1024 * 1024;
export async function readJson(path: string, maxBytes = Infinity): Promise<unknown> {
  const handle = await open(resolve(path), 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new InputError('JSON input exceeds its explicit purpose-specific byte bound or is not a regular file');
    if (!Number.isFinite(maxBytes)) return parseJsonPreservingIntegers(await handle.readFile('utf8'));
    const bytes = Buffer.alloc(maxBytes + 1);
    let count = 0;
    while (count < bytes.length) {
      const page = await handle.read(bytes, count, bytes.length - count, count);
      if (!page.bytesRead) break;
      count += page.bytesRead;
    }
    if (count > maxBytes) throw new InputError('JSON input exceeds its explicit purpose-specific byte bound');
    return parseJsonPreservingIntegers(bytes.subarray(0, count).toString('utf8'));
  } finally { await handle.close(); }
}

export async function privateDirectory(path: string, config: BookkeepingConfig): Promise<void> {
  const canonical = await canonicalLocation(path);
  validateDataLocation(canonical, await canonicalLocation(config.wiki_root), await Promise.all(config.providers.flatMap(provider => provider.roots).map(canonicalLocation)));
  try {await mkdir(path, { recursive: true, mode: 0o700 });}catch(error){throw markStorageFailure(error,'local_write');}
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new InputError('Private review output must be a real directory');
  try {await chmod(path, 0o700);}catch(error){throw markStorageFailure(error,'local_write');}
}

/** A manifest must never change permissions on a shared existing parent. */
export async function privateFileParent(path: string, config: BookkeepingConfig): Promise<string> {
  absolutePath(path, 'manifest');
  const parent = dirname(path);
  try {
    const stat = await lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new InputError('Manifest parent must already be private (0700); use a dedicated directory');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await privateDirectory(parent, config);
  }
  const canonical = await canonicalLocation(path);
  validateDataLocation(canonical, await canonicalLocation(config.wiki_root), await Promise.all(config.providers.flatMap(provider => provider.roots).map(canonicalLocation)));
  try { const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink()) throw new InputError('Manifest must be a regular private file'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return parent;
}

export async function privateAtomicJson(directory: string, name: string, value: unknown, immutable = false, maxBytes = Infinity, trailingNewline = true): Promise<void> {
  const bytes = JSON.stringify(value) + (trailingNewline ? '\n' : '');
  if (Buffer.byteLength(bytes) > maxBytes) throw new InputError('Private JSON exceeds its explicit purpose-specific byte bound; select a smaller page');
  const destination = join(directory, name);
  try {
    const stat = await lstat(destination);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new InputError(`Unsafe existing material ${name}`);
    if (immutable) {
      if (await readFile(destination, 'utf8') !== bytes) throw new Error(`Existing material differs: ${name}`);
      try {await chmod(destination, 0o600);}catch(error){throw markStorageFailure(error,'local_write');}
      return;
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = join(directory, `.material-${randomUUID()}.tmp`);
  let handle;try {handle=await open(temporary, 'wx', 0o600);}catch(error){throw markStorageFailure(error,'local_write');}
  let failure:unknown;
  try {
    await handle.writeFile(bytes); await handle.sync(); await handle.close();
    await rename(temporary, destination);
    const parent = await open(directory, 'r');
    try { await parent.sync(); } finally { await parent.close(); }
  } catch(error) {failure=markStorageFailure(error,'local_write');throw failure;}
  finally {
    try {await handle.close();}catch(error){if(!failure)throw markStorageFailure(error,'local_write');}
    // Preserve the temporary witness rather than issue another write on failed shared storage.
    if(!storageFailureCode(failure))try {await rm(temporary,{force:true});}catch(error){if(!failure)throw markStorageFailure(error,'local_write');}
  }
}
