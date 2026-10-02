#!/usr/bin/env node
import { open } from 'node:fs/promises';
import { continueDailyPlan } from '../src/daily-continuation.ts';
import { absolutePath } from '../src/config.ts';
import { InputError, parseJsonPreservingIntegers } from '../src/contracts/validation.ts';

try {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--config' || args[2] !== '--manifest') throw new InputError('Usage: node tools/daily-continuation.ts --config ABSOLUTE --manifest ABSOLUTE');
  const config = absolutePath(args[1], 'config');
  const manifest = absolutePath(args[3], 'manifest');
  const handle = await open(manifest, 'r');
  const buffer = Buffer.alloc(256 * 1024 + 1);
  let bytes: Buffer;
  try {
    if (!(await handle.stat()).isFile()) throw new InputError('Daily plan must be a file');
    let count = 0;
    while (count < buffer.length) {
      const page = await handle.read(buffer, count, buffer.length - count, count);
      if (!page.bytesRead) break;
      count += page.bytesRead;
    }
    if (count > 256 * 1024) throw new InputError('Daily plan exceeds 256 KiB');
    bytes = buffer.subarray(0, count);
  } finally { await handle.close(); }
  const receipt = await continueDailyPlan(parseJsonPreservingIntegers(bytes.toString('utf8')), config);
  process.stdout.write(JSON.stringify(receipt) + '\n');
  process.exitCode = receipt.storage === 'unavailable' ? 1 : 0;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(message + '\n');
  process.stdout.write(JSON.stringify({ schema_version: 1, error: { message } }) + '\n');
  process.exitCode = error instanceof InputError ? 2 : 1;
}
