/** Coordinator-only deployment of explicitly reviewed full Wiki bytes. */
import { resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { open } from 'node:fs/promises';
import { loadConfig } from '../src/config.ts';
import { version, array, string, InputError } from '../src/contracts/validation.ts';
import { readJson } from '../src/material-files.ts';
import { createStore } from '../src/store/index.ts';
import { acquireWikiLock, createSafeWikiWriter } from '../src/publish/index.ts';
import { storageFailureCode, storageExecutionError } from '../src/storage-errors.ts';
import type { Store, BookkeepingConfig, FileOutcome } from '../src/contracts/types.ts';

export async function applyWikiFiles(input: unknown, store: Store, config: BookkeepingConfig, now = () => new Date()) {
  const manifest = version(input, 'Wiki file deployment');
  const files = await Promise.all(array(manifest.files, 'files').map(async raw => {
    const file = version(raw, 'file');
    for (const key of ['operation_id', 'path', 'baseline_digest']) string(file[key], key);
    if ([file.desired_bytes_base64,file.desired_file].filter(value=>value!==undefined).length!==1) throw new InputError('Supply exactly one full desired_file or desired_bytes_base64; deletion is not supported');
    let bytes: Buffer;
    if(file.desired_file!==undefined){
      string(file.desired_file,'desired_file');if(!isAbsolute(file.desired_file))throw new InputError('desired_file requires an explicit absolute path');
      const handle=await open(file.desired_file,'r');try{if(!(await handle.stat()).isFile())throw new InputError('Desired draft must be a complete regular file');bytes=await handle.readFile();}finally{await handle.close();}
    }else{
      if (typeof file.desired_bytes_base64 !== 'string') throw new InputError('Full desired bytes must be base64');
      bytes = Buffer.from(file.desired_bytes_base64, 'base64');
      if (bytes.toString('base64') !== file.desired_bytes_base64) throw new InputError('Desired bytes must be canonical complete base64');
    }
    return { operation_id: file.operation_id as string, path: file.path as string, baseline_digest: file.baseline_digest as string, desired_bytes: bytes };
  }));
  if (!files.length || new Set(files.map(file => file.operation_id)).size !== files.length || new Set(files.map(file => file.path)).size !== files.length) throw new InputError('Supply nonempty unique file paths and stable operation IDs');
  const outcomes: FileOutcome[] = [], lock = await acquireWikiLock(config.wiki_root);
  if (!lock) return { schema_version: 1, files: files.map(file => ({ schema_version: 1, operation_id: file.operation_id, path: file.path, status: 'pending', reason: 'Wiki writer is active' })) };
  try {
    const writer = createSafeWikiWriter(store, config, { now });
    for (const file of files) {
      try { outcomes.push(await writer.writeLocked(file, lock)); }
      catch (error) {
        const code = storageFailureCode(error);
        if (code) throw storageExecutionError('Shared storage failure during Wiki file deployment', { schema_version: 1, files: outcomes, failed_operation_id: file.operation_id, failure_code: code });
        outcomes.push({ schema_version: 1, operation_id: file.operation_id, path: file.path, status: 'pending', reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { schema_version: 1, files: outcomes };
  } finally { await lock.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let store: Awaited<ReturnType<typeof createStore>> | undefined;
  try {
    if (process.versions.node !== '25.8.0') throw new Error('Node25.8.0 required');
    const args = process.argv.slice(2), options: Record<string, string> = {};
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index], value = args[index + 1];
      if (!['--config','--input'].includes(key) || key in options || !value || !isAbsolute(value)) throw new InputError('Use --config ABSOLUTE_CONFIG --input ABSOLUTE_PRIVATE_MANIFEST');
      options[key] = value;
    }
    if (!options['--config'] || !options['--input']) throw new InputError('Explicit config and input required');
    const config = await loadConfig(options['--config']);
    const input = await readJson(options['--input']);
    store = await createStore(config);
    process.stdout.write(JSON.stringify(await applyWikiFiles(input, store, config)) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ schema_version: 1, error: { message: error instanceof Error ? error.message : String(error), ...(storageFailureCode(error) ? { scope: 'storage' } : {}) }, ...((error as Error & {receipt?: unknown}).receipt ? {receipt:(error as Error & {receipt?: unknown}).receipt} : {}) }) + '\n');
    process.exitCode = error instanceof InputError ? 2 : 1;
  } finally { await store?.close(); }
}
