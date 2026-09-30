import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, resolve, relative, dirname, basename, join, sep } from 'node:path';
import { homedir } from 'node:os';
import { MIGRATION_HARD_LIMITS } from './contracts/migration-limits.ts';
import { InputError, record, string, version, array, zone, utc, parseJsonPreservingIntegers } from './contracts/validation.ts';
import type { BookkeepingConfig, CollectionBudget, IndexCommands } from './contracts/types.ts';

export const DEFAULT_LIMITS = Object.freeze({
  chunk_events: 80,
  chunk_body_bytes: 32 * 1024,
  bundle_bytes: 128 * 1024,
  bundles_per_round: 4,
});
export const DEFAULT_COLLECTION_BUDGETS: Readonly<Record<'live' | 'history', CollectionBudget>> = Object.freeze({
  live: { max_duration_ms: 90_000, max_bytes: 64 * 1024 * 1024, max_directory_entries: 2000 },
  history: { max_duration_ms: 30_000, max_bytes: 32 * 1024 * 1024, max_directory_entries: 2000 },
});

export const DEFAULT_INDEX_COMMANDS: IndexCommands = {
  schema_version: 1,
  lint: { schema_version: 1, executable: process.execPath, args: ['scripts/lint.mjs'], timeout_ms: 120_000 },
  build_index: { schema_version: 1, executable: process.execPath, args: ['scripts/build_index.mjs'], timeout_ms: 120_000 },
  qmd: { schema_version: 1, executable: 'qmd', args: ['update'], timeout_ms: 120_000 },
};

export function absolutePath(value: unknown, name: string): string {
  const path = string(value, name);
  if (!isAbsolute(path)) throw new InputError(`${name}: absolute path required`);
  return resolve(path);
}

function contains(parent: string, child: string): boolean {
  const remainder = relative(parent, child);
  return remainder === '' || (remainder !== '..' && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder));
}

export function validateDataLocation(dataDir: string, wikiRoot: string, sourceRoots: string[] = []): void {
  const data = absolutePath(dataDir, 'data_dir');
  const wiki = absolutePath(wikiRoot, 'wiki_root');
  if (contains(data, wiki) || contains(wiki, data)) throw new InputError('data_dir must not overlap Wiki/raw');
  if (data.split('/').includes('com~apple~CloudDocs') || data.includes('/Library/Mobile Documents/')) {
    throw new InputError('data_dir must be local and outside iCloud');
  }
  for (const root of sourceRoots) {
    if (contains(root, data) || contains(data, root)) throw new InputError('data_dir must not overlap raw source roots');
  }
}

function positiveBudget(value: unknown, path: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new InputError(`${path}: expected positive finite safe integer`);
  }
}

function validateProviders(value: unknown): string[] {
  const roots: string[] = [];
  const names = new Set<string>();
  for (const provider of array(value, 'providers')) {
    version(provider, 'provider');
    string(provider.provider, 'provider');
    string(provider.account_id, 'account_id');
    const identity = `${provider.provider}:${provider.account_id}`;
    if (names.has(identity)) throw new InputError('duplicate provider/account');
    names.add(identity);
    if (typeof provider.enabled !== 'boolean') throw new InputError('provider.enabled: expected boolean');
    for (const root of array(provider.roots, 'roots')) roots.push(absolutePath(root, 'provider.root'));
    record(provider.options, 'options');
  }
  return roots;
}

function validateAnalyticsCatalog(value: unknown): void {
  const catalog = version(value, 'analytics_catalog');
  for (const field of ['capabilities', 'directions']) {
    const refs = new Set<string>();
    for (const entry of array(catalog[field], field)) {
      const definition = version(entry, 'definition');
      const ref = version(definition.definition_ref, 'definition_ref');
      string(ref.logical_id, 'definition_ref.logical_id');
      positiveBudget(ref.revision, 'definition_ref.revision');
      const key = `${ref.logical_id}:${ref.revision}`;
      if (refs.has(key)) throw new InputError('Duplicate catalog definition ref: ' + key);
      refs.add(key);
      string(definition.label, 'definition.label');
      array(definition.keywords, 'definition.keywords').forEach(item => string(item, 'definition.keyword'));
      if (!['candidate', 'formal'].includes(definition.status)) throw new InputError('Definition status must be candidate or formal');
    }
  }
  const mappings = new Set<string>();
  for (const entry of array(catalog.project_mappings, 'project_mappings')) {
    const mapping = version(entry, 'project mapping');
    string(mapping.id, 'mapping.id');
    if (mappings.has(mapping.id)) throw new InputError('Duplicate project mapping ID');
    mappings.add(mapping.id);
    string(mapping.wiki_prefix, 'mapping.wiki_prefix');
    if (mapping.wiki_prefix.startsWith('/') || mapping.wiki_prefix.split('/').includes('..')) throw new InputError('Mapping Wiki prefix must be relative without traversal');
    for (const field of ['repo_hint', 'direction_id']) if (mapping[field] !== null) string(mapping[field], 'mapping.' + field);
    if (mapping.direction_id !== null && !catalog.directions.some((definition: any) => definition.definition_ref.logical_id === mapping.direction_id)) throw new InputError('Mapping references unknown direction definition');
  }
}

export function validateConfig(value: unknown): BookkeepingConfig {
  const config = version(value, 'config');
  const sourceRoots = validateProviders(config.providers);
  validateDataLocation(config.data_dir, config.wiki_root, sourceRoots);
  zone(config.journal_timezone, 'journal_timezone');
  if (config.analysis_timezone !== 'Europe/Amsterdam') throw new InputError('analysis_timezone: expected Europe/Amsterdam');
  utc(config.cutover_at, 'cutover_at');
  utc(config.live_start, 'live_start');
  if (Date.parse(config.live_start) > Date.parse(config.cutover_at)) throw new InputError('live_start must not follow cutover_at');

  const timeline = array(config.journal_timezone_timeline, 'journal_timezone_timeline');
  if (!timeline.length) throw new InputError('journal_timezone_timeline: at least one explicit entry required');
  let previous = -Infinity;
  for (const entry of timeline) {
    version(entry, 'timezone entry');
    utc(entry.effective_from, 'effective_from');
    zone(entry.timezone, 'timezone');
    string(entry.basis, 'basis');
    const instant = Date.parse(entry.effective_from);
    if (instant <= previous) throw new InputError('journal_timezone_timeline must be strictly increasing');
    previous = instant;
  }

  const limits = record(config.limits, 'limits');
  for (const key of Object.keys(DEFAULT_LIMITS)) positiveBudget(limits[key], `limits.${key}`);
  if (limits.chunk_body_bytes > limits.bundle_bytes) throw new InputError('chunk_body_bytes must not exceed bundle_bytes');
  if (config.collection_budgets !== undefined) {
    const budgets = record(config.collection_budgets, 'collection_budgets');
    for (const lane of ['live', 'history']) {
      const budget = record(budgets[lane], `collection_budgets.${lane}`);
      for (const key of ['max_duration_ms', 'max_bytes', 'max_directory_entries']) positiveBudget(budget[key], `${lane}.${key}`);
    }
  }
  if (config.analytics_catalog !== undefined) validateAnalyticsCatalog(config.analytics_catalog);
  if (config.migration_limits !== undefined) {
    const limits = record(config.migration_limits, 'migration_limits');
    for (const [key, value] of Object.entries(limits)) {
      if (!(key in MIGRATION_HARD_LIMITS)) throw new InputError('Unknown migration limit: ' + key);
      positiveBudget(value, 'migration_limits.' + key);
      if (value > MIGRATION_HARD_LIMITS[key as keyof typeof MIGRATION_HARD_LIMITS]) throw new InputError('Migration limit exceeds hard limit: ' + key);
    }
  }
  if (config.index_commands !== undefined) {
    const commands = version(config.index_commands, 'index_commands');
    for (const stage of ['lint', 'build_index', 'qmd']) {
      const command = version(commands[stage], `index_commands.${stage}`);
      string(command.executable, 'executable');
      if (command.executable.includes('\0')) throw new InputError('Command executable contains NUL');
      for (const argument of array(command.args, 'command.args')) if (typeof argument !== 'string' || argument.includes('\0')) throw new InputError('Command args must be strings without NUL');
      if (command.timeout_ms !== undefined) positiveBudget(command.timeout_ms, 'command.timeout_ms');
    }
  }
  for (const key of ['project_whitelist', 'goal_whitelist']) {
    array(config[key], key).forEach(item => string(item, key));
  }
  return config as BookkeepingConfig;
}

/** Resolve even nonexistent leaf directories through their nearest existing ancestor. */
export async function canonicalLocation(path: string): Promise<string> {
  const tail: string[] = [];
  let ancestor = path;
  while (true) {
    try { return join(await realpath(ancestor), ...tail.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      tail.push(basename(ancestor));
      ancestor = parent;
    }
  }
}

export async function validateConfigLocations(config: BookkeepingConfig): Promise<void> {
  const sources = config.providers.flatMap(provider => provider.roots);
  const [data, wiki, ...roots] = await Promise.all([config.data_dir, config.wiki_root, ...sources].map(canonicalLocation));
  validateDataLocation(data, wiki, roots);
}

export async function loadConfig(path?: string): Promise<BookkeepingConfig> {
  const target = absolutePath(path ?? process.env.BOOKKEEPING_CONFIG ?? resolve(homedir(), '.config/llm-bookkeeping/config.json'), 'config');
  let text: string;
  try { text = await readFile(target, 'utf8'); }
  catch (error) { throw new Error(`Cannot read config ${target}: ${(error as Error).message}`); }
  const config = validateConfig(parseJsonPreservingIntegers(text));
  await validateConfigLocations(config);
  return config;
}
