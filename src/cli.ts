#!/usr/bin/env node
import { readFile, mkdir, open, rename, chmod, lstat, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadConfig, absolutePath, DEFAULT_COLLECTION_BUDGETS, canonicalLocation, validateDataLocation } from './config.ts';
import { InputError, utc, date, parseJsonPreservingIntegers, validateManifest, validateReviewResult, version, array, string } from './contracts/validation.ts';
import { createRuntime, restoreRuntime, UnavailableError } from './runtime.ts';
import type { BookkeepingConfig, RuntimeServices, TimeRange, Lane, ReviewKind, SourceAdapter, SourceCoverage } from './contracts/types.ts';

export const COMMANDS = ['collect','prepare','publish','consume','archive','import','migrate','replay','facts','analytics-review','status','backup','restore','validate'] as const;
export interface ParsedCommand { command: typeof COMMANDS[number]; options: Record<string,string|boolean> }
const allowed: Record<string, string[]> = {
  collect: ['lane'], prepare: ['kind', 'lane', 'period', 'output', 'pages', 'cutoff', 'fact-offset', 'fact-snapshot'], publish: ['input', 'resume'],
  consume: ['target'], archive: ['month', 'report', 'apply'], import: ['manifest'], migrate: ['manifest'],
  replay: ['source', 'from', 'to'], facts: ['from', 'to'], 'analytics-review': ['input'],
  status: [], backup: ['output'], restore: ['input', 'data-dir'], validate: ['scope'],
};
const booleans = new Set(['resume', 'report', 'apply']);

function required(options: ParsedCommand['options'], key: string): string {
  const value = options[key];
  if (typeof value !== 'string' || !value) throw new InputError(`--${key} is required`);
  return value;
}

function oneOf(options: ParsedCommand['options'], key: string, values: string[]): string {
  const value = required(options, key);
  if (!values.includes(value)) throw new InputError(`--${key}: expected ${values.join('|')}`);
  return value;
}

function month(value: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new InputError('month: expected YYYY-MM');
  return value;
}

export function parseArgs(args: string[]): ParsedCommand {
  const [command, ...rest] = args;
  if (!COMMANDS.includes(command as ParsedCommand['command'])) throw new InputError(`Expected command: ${COMMANDS.join(', ')}`);
  const options: ParsedCommand['options'] = {};
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index];
    if (!token.startsWith('--')) throw new InputError(`Unexpected positional argument: ${token}`);
    const equals = token.indexOf('=');
    const key = token.slice(2, equals < 0 ? undefined : equals);
    if (![...allowed[command], 'config'].includes(key)) throw new InputError(`Unknown option --${key} for ${command}`);
    if (key in options) throw new InputError(`Duplicate option --${key}`);
    if (booleans.has(key)) {
      if (equals >= 0) throw new InputError(`--${key} does not take a value`);
      options[key] = true;
    } else {
      const value = equals >= 0 ? token.slice(equals + 1) : rest[++index];
      if (!value || value.startsWith('--')) throw new InputError(`--${key} requires a value`);
      options[key] = value;
    }
  }
  if (options.config) absolutePath(options.config, 'config');
  switch (command) {
    case 'collect': oneOf(options, 'lane', ['live', 'history']); break;
    case 'prepare': {
      const kind = oneOf(options, 'kind', ['daily', 'weekly', 'monthly']);
      oneOf(options, 'lane', ['live', 'history']);
      required(options, 'output');
      if (options.cutoff) utc(required(options, 'cutoff'), 'cutoff');
      if (options['fact-offset'] !== undefined) {
        const value = required(options, 'fact-offset');
        if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new InputError('--fact-offset: nonnegative safe integer required');
      }
      if ((options['fact-offset'] !== undefined || options['fact-snapshot']) && kind === 'daily') throw new InputError('Fact pagination requires weekly or monthly preparation');
      if ((Number(options['fact-offset'] ?? 0) > 0 || options['fact-snapshot']) && (!options['fact-snapshot'] || !options.cutoff)) throw new InputError('Follow-up fact pages require --fact-snapshot and original --cutoff');
      if (options.period) {
        const period = required(options, 'period');
        if (kind === 'monthly') month(period); else date(period, 'period');
      }
      break;
    }
    case 'publish':
      if (Boolean(options.input) === Boolean(options.resume)) throw new InputError('publish requires exactly one of --input or --resume');
      break;
    case 'consume': oneOf(options, 'target', ['analytics', 'monthly', 'index', 'all']); break;
    case 'archive':
      month(required(options, 'month'));
      if (Boolean(options.report) === Boolean(options.apply)) throw new InputError('archive requires exactly one of --report or --apply');
      break;
    case 'import': case 'migrate': required(options, 'manifest'); break;
    case 'replay': case 'facts': {
      const from = utc(required(options, 'from'), 'from');
      const to = utc(required(options, 'to'), 'to');
      if (Date.parse(from) >= Date.parse(to)) throw new InputError('--from must precede --to');
      if (command === 'replay') required(options, 'source');
      break;
    }
    case 'analytics-review': required(options, 'input'); break;
    case 'backup': required(options, 'output'); break;
    case 'restore': required(options, 'input'); absolutePath(required(options, 'data-dir'), 'data-dir'); break;
    case 'validate': oneOf(options, 'scope', ['changed', 'all']); break;
  }
  return { command: command as ParsedCommand['command'], options };
}

async function readJson(path: string): Promise<unknown> {
  let text: string;
  try { text = await readFile(resolve(path), 'utf8'); }
  catch (error) { throw new Error(`Cannot read input ${path}: ${(error as Error).message}`); }
  return parseJsonPreservingIntegers(text);
}

function unavailable(capability: string): never { throw new UnavailableError(`Not implemented: ${capability}`); }

async function adapterCheckpoints(services: RuntimeServices, provider: string) {
  const [live, history] = await Promise.all([
    services.store.getCheckpoints(provider, 'live'),
    services.store.getCheckpoints(provider, 'history'),
  ]);
  return [...live, ...history];
}

function commandRange(options: ParsedCommand['options']): TimeRange {
  return { schema_version: 1, from: required(options, 'from'), to: required(options, 'to') };
}

async function recordCollectionFailure(
  services: RuntimeServices, config: BookkeepingConfig, adapter: SourceAdapter,
  lane: Lane, query: TimeRange, cutoff: string, reason: string, partial: boolean,
): Promise<void> {
  const accounts = config.providers.filter(provider => provider.provider === adapter.provider);
  const accountIds = adapter.account_id ? [adapter.account_id] : accounts.map(provider => provider.account_id);
  if (!accountIds.length) accountIds.push('unknown');
  const coverage: SourceCoverage[] = accountIds.map(account => ({
    schema_version: 1,
    coverage_id: services.store.allocateId('coverage'), provider: adapter.provider,
    account_id: account, conversation_id: null, lane, query_range: query, cutoff,
    read_ranges: [],
    gaps: [{ schema_version: 1, range: query, reason, locator: null, resumable: true }],
    capture_status: partial ? 'partial' : 'unavailable', review_status: 'pending',
  }));
  await services.store.saveCollection({
    schema_version: 1, batch_id: services.store.allocateId('collection_failure'),
    events: [], fragments: [], coverage, checkpoints: [],
  });
  for (const account of accountIds) {
    const identity = createHash('sha256').update(JSON.stringify([adapter.provider, account, lane, query])).digest('hex');
    await services.store.enqueueWork({
      schema_version: 1, work_id: `collection-retry:${identity}`, kind: 'collection_retry', lane,
      state: 'pending', payload: { provider: adapter.provider, account_id: account, range: query, cutoff },
      reason, migration_key: null, updated_at: cutoff,
    });
  }
}

async function collectCommand(parsed: ParsedCommand, config: BookkeepingConfig, services: RuntimeServices, cutoff: string) {
  const lane = required(parsed.options, 'lane') as Lane;
  const query: TimeRange = {
    schema_version: 1,
    from: lane === 'live'
      ? new Date(Math.max(Date.parse(config.live_start), Date.parse(cutoff) - 48 * 3_600_000)).toISOString()
      : config.journal_timezone_timeline[0].effective_from,
    to: cutoff,
  };
  if (Date.parse(query.from) >= Date.parse(query.to)) throw new InputError('Collection cutoff must follow configured live/history start');
  if (!services.adapters.length) unavailable('enabled source adapters');
  const budget = config.collection_budgets?.[lane] ?? DEFAULT_COLLECTION_BUDGETS[lane];
  const providers = [];
  for (const adapter of services.adapters) {
    let batches = 0;
    let events = 0;
    try {
      const context = { checkpoints: await adapterCheckpoints(services, adapter.provider), config };
      for await (const batch of adapter.collect({ lane, cutoff, range: query, budget }, context)) {
        await services.store.saveCollection(batch);
        batches++;
        events += batch.events.length;
      }
      providers.push({ provider: adapter.provider, execution_status: 'complete', batches, events });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // If durable failure state cannot be saved, command execution fails instead of hiding the outage.
      await recordCollectionFailure(services, config, adapter, lane, query, cutoff, reason, batches > 0);
      providers.push({ provider: adapter.provider, execution_status: 'partial', batches, events, reason });
    }
  }
  return { schema_version: 1, lane, cutoff, providers, coverage: await services.store.listCoverage(query) };
}

async function privateDirectory(path: string, config: BookkeepingConfig): Promise<void> {
  const canonical = await canonicalLocation(path);
  validateDataLocation(canonical, await canonicalLocation(config.wiki_root),
    await Promise.all(config.providers.flatMap(provider => provider.roots).map(canonicalLocation)));
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new InputError('Private review output must be a real directory');
  await chmod(path, 0o700);
}

async function privateAtomicJson(directory: string, name: string, value: unknown, immutable = false): Promise<void> {
  const bytes = JSON.stringify(value) + '\n';
  const destination = join(directory, name);
  if (immutable) {
    try {
      const stat = await lstat(destination);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new InputError(`Unsafe existing review material ${name}`);
      if (await readFile(destination, 'utf8') !== bytes) throw new Error(`Existing bundle differs: ${name}`);
      await chmod(destination, 0o600);
      return;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const temporary = join(directory, `.prepare-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    await rename(temporary, destination);
    const parent = await open(directory, 'r');
    try { await parent.sync(); } finally { await parent.close(); }
  } finally {
    await handle.close();
    await rm(temporary, { force: true });
  }
}

async function prepareCommand(parsed: ParsedCommand, config: BookkeepingConfig, services: RuntimeServices, cutoff: string) {
  const options = parsed.options;
  cutoff = typeof options.cutoff === 'string' ? options.cutoff : cutoff;
  const outputDir = resolve(required(options, 'output'));
  await privateDirectory(outputDir, config);
  let pagePaths: string[] | undefined;
  if (options.pages) {
    const manifest = version(await readJson(required(options, 'pages')), 'page manifest');
    pagePaths = array(manifest.paths, 'page manifest.paths').map((path: unknown) => string(path, 'page path'));
    if (new Set(pagePaths).size !== pagePaths.length) throw new InputError('Duplicate page target');
    const { resolveWikiPath } = await import('./publish/index.ts');
    for (const path of pagePaths) await resolveWikiPath(config.wiki_root, path);
  }
  const bundles = await services.reviewer.prepare({
    kind: required(options, 'kind') as ReviewKind, lane: required(options, 'lane') as Lane,
    period: options.period as string | undefined, cutoff, output_dir: outputDir, page_paths: pagePaths,
    fact_offset: options['fact-offset'] === undefined ? undefined : Number(options['fact-offset']),
    fact_snapshot: options['fact-snapshot'] as string | undefined,
  });
  if ((options['fact-offset'] !== undefined || options['fact-snapshot']) && bundles.some(bundle => !bundle.analysis_context?.facts_page && !bundle.monthly_context?.facts_page)) unavailable('Frozen fact pagination is not delivered by Reviewer');
  const files = [];
  for (const bundle of bundles) {
    const name = `bundle-${encodeURIComponent(bundle.bundle_id)}.json`;
    if (Buffer.byteLength(JSON.stringify(bundle) + '\n') > config.limits.bundle_bytes) {
      throw new Error(`Prepared bundle exceeds final serialized byte budget: ${bundle.bundle_id}`);
    }
    await privateAtomicJson(outputDir, name, bundle, true);
    files.push(name);
  }
  const manifest = {
    schema_version: 1, kind: required(options, 'kind'), lane: required(options, 'lane'), cutoff, bundles: files,
  };
  await privateAtomicJson(outputDir, 'manifest.json', manifest);
  return { output_dir: outputDir, ...manifest };
}

async function consumeCommand(parsed: ParsedCommand, services: RuntimeServices) {
  const target = required(parsed.options, 'target');
  const expected = target === 'all' ? ['analytics', 'monthly', 'index'] : [target];
  const outcomes = [];
  for (const name of expected) {
    const consumer = services.consumers.find(item => item.target === name);
    if (!consumer) unavailable(`consumer ${name}`);
    outcomes.push(await consumer.consume());
  }
  return { schema_version: 1, consumers: outcomes };
}

async function manifestCommand(parsed: ParsedCommand, services: RuntimeServices) {
  const manifest = validateManifest(await readJson(required(parsed.options, 'manifest')));
  const expected = parsed.command === 'import' ? 'import' : 'migration';
  if (manifest.kind !== expected) throw new InputError(`${parsed.command} manifest.kind must be ${expected}`);
  const handler = parsed.command === 'import' ? services.importManifest : services.migrateManifest;
  return handler ? handler(manifest) : unavailable(parsed.command);
}

async function replayCommand(parsed: ParsedCommand, config: BookkeepingConfig, services: RuntimeServices) {
  const source = required(parsed.options, 'source');
  const adapter = services.adapters.find(item => item.provider === source);
  if (!adapter) throw new InputError(`Unknown source ${source}`);
  if (!adapter.replay) unavailable(`replay ${source}`);
  let batches = 0;
  const context = { checkpoints: await adapterCheckpoints(services, adapter.provider), config };
  for await (const batch of adapter.replay(commandRange(parsed.options), context)) {
    await services.store.saveCollection(batch);
    batches++;
  }
  return { schema_version: 1, source, batches, range: commandRange(parsed.options) };
}

export async function executeCommand(parsed: ParsedCommand, config: BookkeepingConfig, services: RuntimeServices, cutoff: string): Promise<unknown> {
  const options = parsed.options;
  switch (parsed.command) {
    case 'collect': return collectCommand(parsed, config, services, cutoff);
    case 'prepare': return prepareCommand(parsed, config, services, cutoff);
    case 'publish': {
      if (options.resume) return services.publisher.resume();
      const result = validateReviewResult(await readJson(required(options, 'input')));
      return services.publisher.publish(result);
    }
    case 'consume': return consumeCommand(parsed, services);
    case 'archive': return services.archive
      ? services.archive({ month: required(options, 'month'), mode: options.apply ? 'apply' : 'report' })
      : unavailable('archive');
    case 'import': case 'migrate': return manifestCommand(parsed, services);
    case 'replay': return replayCommand(parsed, config, services);
    case 'facts': return { schema_version: 1, facts: await services.store.readEffectiveFacts({ range: commandRange(options) }) };
    case 'analytics-review': return services.analyticsReview
      ? services.analyticsReview(await readJson(required(options, 'input'))) : unavailable('analytics review');
    case 'status': return { schema_version: 1, ...await services.store.status() };
    case 'backup': {
      const output = resolve(required(options, 'output'));
      await privateDirectory(output, config);
      return { schema_version: 1, ...await services.store.backup(output) };
    }
    case 'restore': return services.restore
      ? services.restore(resolve(required(options, 'input')), required(options, 'data-dir')) : unavailable('restore');
    case 'validate': return services.validate
      ? services.validate(required(options, 'scope') as 'changed' | 'all') : unavailable('validate');
  }
}

export interface CliDependencies {
  loadConfig?: (path?: string) => Promise<BookkeepingConfig>;
  createRuntime?: (config: BookkeepingConfig, command?: string, options?: Record<string, string | boolean>) => Promise<RuntimeServices>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  now?: () => string;
}

export async function runCli(args: string[], dependencies: CliDependencies = {}): Promise<number> {
  const stdout = dependencies.stdout ?? (text => process.stdout.write(text));
  const stderr = dependencies.stderr ?? (text => process.stderr.write(text));
  let services: RuntimeServices | undefined;
  try {
    if (args.length === 1 && ['--help', 'help'].includes(args[0])) {
      stdout(JSON.stringify({ schema_version: 1, commands: COMMANDS, config: '--config ABSOLUTE_PATH', node: '25.8.0' }) + '\n');
      return 0;
    }
    const parsed = parseArgs(args);
    const config = await (dependencies.loadConfig ?? loadConfig)(parsed.options.config as string | undefined);
    let result: unknown;
    if (parsed.command === 'restore' && !dependencies.createRuntime) {
      result = await restoreRuntime(resolve(required(parsed.options, 'input')), required(parsed.options, 'data-dir'), config);
    } else {
      services = await (dependencies.createRuntime ?? createRuntime)(config, parsed.command, parsed.options);
      result = await executeCommand(parsed, config, services, (dependencies.now ?? (() => new Date().toISOString()))());
    }
    if (services) {
      await (services.close ? services.close() : services.store.close());
      services = undefined;
    }
    stdout(JSON.stringify(result) + '\n');
    return 0;
  } catch (error) {
    const code = error instanceof InputError ? 2 : 1;
    const message = error instanceof Error ? error.message : String(error);
    stderr(message + '\n');
    stdout(JSON.stringify({ schema_version: 1, error: { kind: code === 2 ? 'invalid_input' : 'execution_failed', message } }) + '\n');
    return code;
  } finally {
    if (services) {
      try { await (services.close ? services.close() : services.store.close()); }
      catch (error) { stderr(`Resource cleanup failed: ${(error as Error).message}\n`); }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
