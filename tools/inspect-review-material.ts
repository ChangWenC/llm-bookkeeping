#!/usr/bin/env node
import { inspectReviewMaterial, readReviewMaterial } from '../src/review-material-inspection.ts';
import type { MaterialSection } from '../src/review-material-inspection.ts';
import { InputError } from '../src/contracts/validation.ts';

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(JSON.stringify({ schema_version: 1, inspection_only: true, usage: 'node tools/inspect-review-material.ts --input ABSOLUTE_BUNDLE [--section events|facts|baselines|summary] [--offset N] [--limit 1-80]', ordering: 'Each chunk: primary events, then context events. Text is never truncated; slice metadata and baseline excerpts are disclosed.' }) + '\n');
  } else {
    const options: Record<string, string> = {};
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index];
      if (!['--input', '--section', '--offset', '--limit'].includes(key) || key in options) throw new InputError('Unknown or duplicate inspection option');
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new InputError(`${key} requires a value`);
      options[key] = value;
    }
    if (!options['--input']) throw new InputError('--input is required');
    for (const key of ['--offset', '--limit']) if (options[key] !== undefined && (!/^(0|[1-9][0-9]*)$/.test(options[key]) || !Number.isSafeInteger(Number(options[key])))) throw new InputError(`${key} must be a safe integer`);
    const section = (options['--section'] ?? 'events') as MaterialSection;
    if (!['events', 'facts', 'baselines', 'summary'].includes(section)) throw new InputError('section must be events|facts|baselines|summary');
    const offset = Number(options['--offset'] ?? 0), limit = Number(options['--limit'] ?? 20);
    if (limit < 1 || limit > 80) throw new InputError('--limit must be 1–80');
    const bundle = await readReviewMaterial(options['--input']);
    process.stdout.write(JSON.stringify(inspectReviewMaterial(bundle, section, offset, limit), null, 2) + '\n');
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(message + '\n');
  process.stdout.write(JSON.stringify({ schema_version: 1, inspection_only: true, error: { message } }) + '\n');
  process.exitCode = error instanceof InputError ? 2 : 1;
}
