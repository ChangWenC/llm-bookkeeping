#!/usr/bin/env node
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadConfig, absolutePath, DEFAULT_COLLECTION_BUDGETS, canonicalLocation, validateDataLocation } from './config.ts';
import { InputError, utc, utcComparisonKey, date, parseJsonPreservingIntegers, validateManifest, validateReviewResult, validateContextFactRefs, version, array, string } from './contracts/validation.ts';
import { createRuntime, restoreRuntime, UnavailableError } from './runtime.ts';
import { readJson, privateDirectory, privateAtomicJson } from './material-files.ts';
import { prepareJournalCommand, resolveJournalCommand, journalInventoryCommand, journalProposalCommand, journalDecideCommand, journalReassessCommand, reviewRiskInventoryCommand } from './journal-cli.ts';
import { storageFailureCode, assertStorageAvailable } from './storage-errors.ts';
import type { BookkeepingConfig, RuntimeServices, TimeRange, Lane, ReviewKind, SourceAdapter, SourceCoverage, CollectionBatch } from './contracts/types.ts';

export const COMMANDS = ['collect','prepare','publish','consume','archive','import','migrate','replay','facts','analytics-review','status','backup','restore','validate','daily-round','monthly-round','journal-prepare','journal-resolve','journal-inventory','journal-recover','journal-proposal','journal-decide','journal-reassess','review-risk-inventory'] as const;
export interface ParsedCommand { command: typeof COMMANDS[number]; options: Record<string,string|boolean> }
const allowed: Record<string, string[]> = {
  collect: ['lane', 'source', 'from', 'to', 'cutoff'], prepare: ['kind', 'lane', 'period', 'output', 'pages', 'cutoff', 'fact-offset', 'fact-snapshot', 'archive-context-offset', 'replay-id', 'source', 'max-bundles', 'from', 'to', 'selection-basis', 'continuation', 'work-only','context-facts'], publish: ['input', 'resume'],
  consume: ['target'], archive: ['month', 'report', 'apply'], import: ['manifest'], migrate: ['manifest'],
  replay: ['source', 'from', 'to', 'replay-key', 'events','stored-only'], facts: ['from', 'to'], 'analytics-review': ['input'],
  status: [], backup: ['output'], restore: ['input', 'data-dir'], validate: ['scope'],
  'monthly-round': ['manifest','output','input','defer-active','cutoff','finish','reason','archive-month','pages'],
  'daily-round': ['manifest','output','input','journal-input','defer-active','defer-stage','cutoff','finish','reason'],
  'journal-prepare': ['output','work','max-items','cutoff'], 'journal-resolve': ['input'],
  'journal-inventory': ['from','to','after-result','limit','output','exclude-unknown'], 'journal-recover': ['input'], 'journal-proposal':['id','output'], 'journal-decide':['input'], 'journal-reassess':['input'], 'review-risk-inventory':['input'],
};
const booleans = new Set(['resume', 'report', 'apply', 'exclude-unknown', 'finish', 'work-only','stored-only']);

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
    case 'collect': {
      const lane = oneOf(options, 'lane', ['live', 'history']);
      if (options.cutoff) utc(required(options, 'cutoff'), 'cutoff');
      if (options.from !== undefined || options.to !== undefined) {
        const from = utc(required(options, 'from'), 'from');
        const to = utc(required(options, 'to'), 'to');
        if (utcComparisonKey(from) >= utcComparisonKey(to)) throw new InputError('--from must precede --to');
        if (lane !== 'history') throw new InputError('Explicit capture range requires history lane');
        utc(required(options, 'cutoff'), 'cutoff');
        if (utcComparisonKey(to) > utcComparisonKey(required(options, 'cutoff'))) throw new InputError('--to cannot follow collection cutoff');
      }
      break;
    }
    case 'prepare': {
      const kind = oneOf(options, 'kind', ['daily', 'weekly', 'monthly']);
      oneOf(options, 'lane', ['live', 'history']);
      required(options, 'output');
      if(options['work-only']&&(kind!=='monthly'||!options.period||!options['fact-snapshot']||!options.cutoff||options['fact-offset']===undefined||options.pages||options['archive-context-offset']!==undefined||options['replay-id']))throw new InputError('Work-only requires monthly period, exact snapshot/cutoff/offset and no new page/archive/replay material');
      if(options['context-facts']){absolutePath(required(options,'context-facts'),'context-facts');if(kind!=='daily')throw new InputError('Explicit context facts require daily preparation');}
      if (options['selection-basis']) { oneOf(options,'selection-basis',['event_time','capture_lane']); if(kind!=='daily'||options['replay-id'])throw new InputError('Selection basis requires non-replay daily preparation'); }
      if (options.continuation && (kind!=='daily'||!options.source||options['replay-id']))throw new InputError('Candidate continuation requires source-scoped non-replay daily preparation');
      if(options.continuation)absolutePath(required(options,'continuation'),'continuation');
      if (options['replay-id'] && (kind !== 'daily' || options.period)) throw new InputError('--replay-id requires daily preparation without --period');
      if (options.cutoff) utc(required(options, 'cutoff'), 'cutoff');
      if (options.source && kind !== 'daily') throw new InputError('--source requires daily preparation');
      if (options['max-bundles'] !== undefined) {
        const value = required(options, 'max-bundles');
        if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new InputError('--max-bundles: positive safe integer required');
      }
      if (options.from !== undefined || options.to !== undefined) {
        const from = utc(required(options, 'from'), 'from');
        const to = utc(required(options, 'to'), 'to');
        if (utcComparisonKey(from) >= utcComparisonKey(to)) throw new InputError('--from must precede --to');
        if (kind !== 'daily' || options.period || options['replay-id']) throw new InputError('Explicit range requires daily preparation without --period or --replay-id');
      }
      for (const key of ['fact-offset', 'archive-context-offset']) if (options[key] !== undefined) {
        const value = required(options, key);
        if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new InputError(`--${key}: nonnegative safe integer required`);
      }
      if (options['archive-context-offset'] !== undefined && kind !== 'monthly') throw new InputError('Archive context pagination requires monthly preparation');
      if (Number(options['archive-context-offset'] ?? 0) > 0 && !options.cutoff) throw new InputError('Archive context continuation requires original --cutoff');
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
    case 'consume': oneOf(options, 'target', ['analytics', 'monthly', 'index', 'evidence', 'all']); break;
    case 'archive':
      month(required(options, 'month'));
      if (Boolean(options.report) === Boolean(options.apply)) throw new InputError('archive requires exactly one of --report or --apply');
      break;
    case 'import': case 'migrate': required(options, 'manifest'); break;
    case 'replay': case 'facts': {
      const from = utc(required(options, 'from'), 'from');
      const to = utc(required(options, 'to'), 'to');
      if (utcComparisonKey(from) >= utcComparisonKey(to)) throw new InputError('--from must precede --to');
      if (command === 'replay') {
        required(options, 'source');
        if(options['stored-only']){required(options,'events');required(options,'replay-key');}
        if (options.events) absolutePath(required(options, 'events'), 'events');
        if (options['replay-key'] && (!required(options, 'replay-key').trim() || required(options, 'replay-key').length > 512))
          throw new InputError('--replay-key: nonempty key of at most 512 characters required');
      }
      break;
    }
    case 'analytics-review': required(options, 'input'); break;
    case 'backup': required(options, 'output'); break;
    case 'restore': required(options, 'input'); absolutePath(required(options, 'data-dir'), 'data-dir'); break;
    case 'validate': oneOf(options, 'scope', ['changed', 'all']); break;
    case 'monthly-round':
    case 'daily-round':
      absolutePath(required(options, 'manifest'), 'manifest'); absolutePath(required(options, 'output'), 'output');
      if ([options.input, options['journal-input'], options['defer-active'], options.finish].filter(Boolean).length > 1) throw new InputError('Daily round accepts only one input or explicit active deferral per step');
      if (command==='monthly-round'&&options['archive-month'])month(required(options,'archive-month'));
      if (command==='monthly-round'&&options.pages)absolutePath(required(options,'pages'),'pages');
      if (options.finish) required(options,'reason');
      if (options.reason && !options.finish)throw new InputError('--reason requires --finish');
      if (options['defer-stage'] && (!options['defer-active'] || !['review','material','publish','journal'].includes(options['defer-stage'] as string))) throw new InputError('--defer-stage requires explicit deferral and review|material|publish|journal');
      if (options.cutoff) utc(required(options, 'cutoff'), 'cutoff');
      break;
    case 'journal-prepare':
      absolutePath(required(options, 'output'), 'output');
      if (options.cutoff) utc(required(options, 'cutoff'), 'cutoff');
      if (options.work) absolutePath(required(options, 'work'), 'work');
      if (options['max-items'] && (!/^[1-9][0-9]*$/.test(required(options, 'max-items')) || !Number.isSafeInteger(Number(options['max-items'])))) throw new InputError('--max-items must be a positive safe integer');
      break;
    case 'journal-inventory': {
      const range = commandRange(options); utc(range.from, 'from'); utc(range.to, 'to');
      if (utcComparisonKey(range.from) >= utcComparisonKey(range.to)) throw new InputError('--from must precede --to');
      absolutePath(required(options, 'output'), 'output');
      if (options.limit && (!/^[1-9][0-9]*$/.test(required(options, 'limit')) || Number(options.limit) > 100)) throw new InputError('--limit must be1–100');
      break;
    }
    case 'journal-proposal': required(options,'id'); absolutePath(required(options,'output'),'output'); break;
    case 'review-risk-inventory':
    case 'journal-reassess':
    case 'journal-decide':
    case 'journal-resolve': case 'journal-recover': absolutePath(required(options, 'input'), 'input'); break;
  }
  return { command: command as ParsedCommand['command'], options };
}

function unavailable(capability: string): never { throw new UnavailableError(`Not implemented: ${capability}`); }

function storageFailure(error: unknown): Error {
  const wrapped = new Error(`Local Store failure: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  Object.assign(wrapped, { code: 'BOOKKEEPING_STORAGE_FAILURE' });
  return wrapped;
}

async function adapterCheckpoints(services: RuntimeServices, provider: string, captureScope?: string) {
  let live, history;
  try { [live, history] = await Promise.all([
    services.store.getCheckpoints(provider, 'live'),
    services.store.getCheckpoints(provider, 'history'),
  ]); } catch (error) { throw storageFailure(error); }
  return [...live, ...history].filter(checkpoint => captureScope
    ? checkpoint.cursor.manual_capture_scope === captureScope
    : checkpoint.cursor.manual_capture_scope === undefined).map(checkpoint => {
      if (!captureScope) return checkpoint;
      const { manual_capture_scope: _scope, manual_original_checkpoint_id: original, ...cursor } = checkpoint.cursor;
      if (typeof original !== 'string') throw storageFailure(new Error('Scoped capture checkpoint missing original identity'));
      return { ...checkpoint, checkpoint_id: original, cursor };
    });
}

function commandRange(options: ParsedCommand['options']): TimeRange {
  return { schema_version: 1, from: required(options, 'from'), to: required(options, 'to') };
}

async function recordCollectionFailure(
  services: RuntimeServices, config: BookkeepingConfig, adapter: SourceAdapter,
  lane: Lane, query: TimeRange, cutoff: string, reason: string, partial: boolean,
  accountOverride?: string,
): Promise<void> {
  const accounts = config.providers.filter(provider => provider.provider === adapter.provider);
  const accountId = accountOverride ?? adapter.account_id;
  const accountIds = accountId ? [accountId] : accounts.map(provider => provider.account_id);
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
    const retryRange = { schema_version: 1 as const, from: utcComparisonKey(query.from), to: utcComparisonKey(query.to) };
    const retryCutoff = utcComparisonKey(cutoff);
    const identity = createHash('sha256').update(JSON.stringify([adapter.provider, account, lane, retryRange, retryCutoff])).digest('hex');
    await services.store.enqueueWork({
      schema_version: 1, work_id: `collection-retry:${identity}`, kind: 'collection_retry', lane,
      state: 'pending', payload: { provider: adapter.provider, account_id: account, range: retryRange, cutoff: retryCutoff },
      reason, migration_key: null, updated_at: cutoff,
    });
  }
}

/** Range-local progress never advances regular live/history checkpoints. */
function scopedCaptureBatch(batch: CollectionBatch, scope: string, range: TimeRange): CollectionBatch {
  const id = (original: string) => 'capture:' + createHash('sha256').update(JSON.stringify([scope, original])).digest('hex');
  const unknown = batch.events.filter(event => event.utc_time.value === null);
  return {
    ...batch, batch_id: id(batch.batch_id),
    // Complete raw fragments remain available for source parsing/audit. Unknown
    // timestamps remain durable local evidence and explicitly partial coverage.
    events: batch.events.filter(event => event.utc_time.value === null || (event.source.provider === 'wechat' && event.context.context_only === true) || (utcComparisonKey(event.utc_time.value) >= utcComparisonKey(range.from) && utcComparisonKey(event.utc_time.value) < utcComparisonKey(range.to))),
    checkpoints: batch.checkpoints.map(checkpoint => ({ ...checkpoint, checkpoint_id: id(checkpoint.checkpoint_id), cursor: { ...checkpoint.cursor, manual_capture_scope: scope, manual_original_checkpoint_id: checkpoint.checkpoint_id } })),
    coverage: batch.coverage.map(coverage => ({ ...coverage, coverage_id: id(coverage.coverage_id),
      capture_status: unknown.length && coverage.capture_status === 'complete' ? 'partial' : coverage.capture_status,
      gaps: [...coverage.gaps, ...unknown.map(event => ({ schema_version: 1 as const, range: null, reason: 'manual_capture_event_time_unknown', locator: event.locator, resumable: true }))],
    })),
  };
}

async function collectCommand(parsed: ParsedCommand, config: BookkeepingConfig, services: RuntimeServices, cutoff: string, maxDurationMs?: number, now: () => Date = () => new Date()) {
  const options = parsed.options;
  const lane = required(options, 'lane') as Lane;
  cutoff = typeof options.cutoff === 'string' ? options.cutoff : cutoff;
  const source = typeof options.source === 'string' ? options.source : undefined;
  if (source && !config.providers.some(provider => provider.provider === source && provider.enabled)) throw new InputError(`Unknown or disabled source ${source}`);
  const explicitRange = options.from === undefined ? undefined : commandRange(options);
  const query: TimeRange = explicitRange ?? {
    schema_version: 1,
    from: lane === 'live'
      ? new Date(Math.max(Date.parse(config.live_start), Date.parse(cutoff) - 48 * 3_600_000)).toISOString()
      : config.journal_timezone_timeline[0].effective_from,
    to: cutoff,
  };
  if (utcComparisonKey(query.from) >= utcComparisonKey(query.to)) throw new InputError('Collection cutoff must follow configured live/history start');
  const adapters = services.adapters.filter(adapter => !source || adapter.provider === source);
  if (!adapters.length) unavailable('enabled source adapters');
  const captureScope = explicitRange ? createHash('sha256').update(JSON.stringify([source ?? '*', utcComparisonKey(query.from), utcComparisonKey(query.to), utcComparisonKey(cutoff)])).digest('hex') : undefined;
  const configuredBudget = config.collection_budgets?.[lane] ?? DEFAULT_COLLECTION_BUDGETS[lane];
  const startedAt = now().getTime();
  const providers = [];
  for (const adapter of adapters) {
    const remainingMs = maxDurationMs === undefined ? configuredBudget.max_duration_ms : Math.max(0, maxDurationMs - (now().getTime() - startedAt));
    if (remainingMs < 1) { providers.push({ provider: adapter.provider, execution_status: 'partial', reason: 'Round capture/time allowance exhausted', batches: 0, events: 0 }); break; }
    const budget = { ...configuredBudget, max_duration_ms: Math.min(configuredBudget.max_duration_ms, remainingMs) };
    let batches = 0;
    let events = 0;
    const context = { checkpoints: await adapterCheckpoints(services, adapter.provider, captureScope), config,
      ...(captureScope ? { generation_checkpoints: await adapterCheckpoints(services, adapter.provider) } : {}),
    };
    let persisting = false;
    try {
      for await (const captured of adapter.collect({ lane, cutoff, range: query, budget }, context)) {
        const batch = captureScope ? scopedCaptureBatch(captured, captureScope, query) : captured;
        persisting = true;
        await services.store.saveCollection(batch);
        persisting = false;
        batches++;
        events += batch.events.length;
      }
      providers.push({ provider: adapter.provider, execution_status: 'complete', batches, events });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (storageFailureCode(error)) throw storageFailure(error);
      const identityConflict = persisting && error instanceof Error && ['Work identity conflict', 'Collection batch identity conflict'].includes(error.message);
      if (persisting && !identityConflict) throw storageFailure(error);
      // An immutable identity collision is source-local and rolls back the batch;
      // a real failure saving its durable diagnostic is still a Store outage.
      try { await recordCollectionFailure(services, config, adapter, lane, query, cutoff, reason, batches > 0); }
      catch (failure) { throw storageFailure(failure); }
      providers.push({ provider: adapter.provider, execution_status: 'partial', batches, events, reason,
        ...(identityConflict ? { failure_kind: 'collection_identity_conflict' } : {}) });
    }
  }
  return { schema_version: 1, lane, cutoff, ...(source ? { source } : {}), range: query, ...(captureScope ? { capture_scope: captureScope } : {}), providers, coverage: (await services.store.listCoverage(query)).filter(item => !source || item.provider === source) };
}

async function prepareCommand(parsed: ParsedCommand, config: BookkeepingConfig, services: RuntimeServices, cutoff: string) {
  const options = parsed.options;
  cutoff = typeof options.cutoff === 'string' ? options.cutoff : cutoff;
  if (options['replay-id']) {
    const replay = await services.store.getSemanticReplay(required(options, 'replay-id'));
    if (!replay) throw new InputError('Unknown semantic replay ID');
    if (options.cutoff && utcComparisonKey(cutoff) !== utcComparisonKey(replay.payload.cutoff as string)) throw new InputError('Replay requires its original cutoff');
    cutoff = replay.payload.cutoff as string;
  }
  const source = typeof options.source === 'string' ? options.source : undefined;
  if (source && !config.providers.some(provider => provider.provider === source)) throw new InputError(`Unknown source ${source}`);
  const maxBundles = options['max-bundles'] === undefined ? undefined : Number(options['max-bundles']);
  if (maxBundles !== undefined && maxBundles > config.limits.bundles_per_round) throw new InputError('--max-bundles exceeds configured bundles_per_round');
  const range = options.from === undefined ? undefined : commandRange(options);
  if (range && utcComparisonKey(range.to) > utcComparisonKey(cutoff)) throw new InputError('--to cannot follow preparation cutoff');
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
  let contextFactRefs:import('./contracts/types.ts').FactRef[]|undefined;
  if(options['context-facts']){const selection=version(await readJson(required(options,'context-facts')),'context fact manifest');if(Object.keys(selection).some(key=>!['schema_version','fact_refs'].includes(key)))throw new InputError('Unknown context fact manifest field');contextFactRefs=validateContextFactRefs(selection.fact_refs);}
  const request = {
    context_fact_refs:contextFactRefs,
    kind: required(options, 'kind') as ReviewKind, lane: required(options, 'lane') as Lane,
    period: options.period as string | undefined, cutoff, output_dir: outputDir, page_paths: pagePaths,
    fact_offset: options['fact-offset'] === undefined ? undefined : Number(options['fact-offset']),
    fact_snapshot: options['fact-snapshot'] as string | undefined,
    archive_context_offset: options['archive-context-offset'] === undefined ? undefined : Number(options['archive-context-offset']),
    replay_id: options['replay-id'] as string | undefined,
    source, max_bundles: maxBundles, range,
    selection_basis: options['selection-basis'] as 'event_time'|'capture_lane'|undefined,
    work_only: options['work-only']===true,
    candidate_continuation: options.continuation ? version(await readJson(options.continuation as string),'candidate continuation') as import('./contracts/types.ts').PreparationContinuation : undefined,
  };
  const prepared = services.reviewer.prepareWithOutcomes
    ? await services.reviewer.prepareWithOutcomes(request)
    : { schema_version: 1 as const, bundles: await services.reviewer.prepare(request), providers: [] };
  const bundles = prepared.bundles;
  if (bundles.length > (maxBundles ?? config.limits.bundles_per_round)) throw new Error('Reviewer exceeded configured round bundle count');
  if ((options['fact-offset'] !== undefined || options['fact-snapshot']) && bundles.some(bundle => !bundle.analysis_context?.facts_page && !bundle.monthly_context?.facts_page)) unavailable('Frozen fact pagination is not delivered by Reviewer');
  if (options['archive-context-offset'] !== undefined && bundles.some(bundle => !bundle.monthly_context?.archive_context_page)) unavailable('Archive context material reader is not delivered by Reviewer');
  const files: string[] = [];
  const materialOutcomes = [];
  for (const bundle of bundles) {
    const name = `bundle-${encodeURIComponent(bundle.bundle_id)}.json`;
    const provider = bundle.source ?? source ?? bundle.chunks?.[0]?.events?.[0]?.source.provider ?? 'unknown';
    try {
      const jsonBytes = Buffer.byteLength(JSON.stringify(bundle));
      if (jsonBytes > config.limits.bundle_bytes) throw new Error(`Prepared bundle exceeds final serialized byte budget: ${bundle.bundle_id}`);
      // A trailing LF is optional JSON whitespace; do not reject material that fits exactly.
      await privateAtomicJson(outputDir, name, bundle, true, config.limits.bundle_bytes, jsonBytes < config.limits.bundle_bytes);
      files.push(name);
      materialOutcomes.push({ schema_version: 1 as const, provider, stage: 'material', execution_status: 'complete', reason: null, bundle_ids: [bundle.bundle_id] });
    } catch (error) {
      if(storageFailureCode(error))throw error;
      const reason = error instanceof Error ? error.message : String(error);
      // Semantic bundles remain durable; retry material output without hiding
      // failures in the local Store used to record that debt.
      try { await services.store.enqueueWork({
        schema_version: 1, work_id: `review-material:${bundle.bundle_id}:${createHash('sha256').update(outputDir).digest('hex')}`, kind: 'review_material_retry', lane: request.lane,
        state: 'pending', payload: { provider, bundle_id: bundle.bundle_id, output_dir: outputDir },
        reason, migration_key: null, updated_at: cutoff,
      }); } catch (storageError) { throw storageFailure(storageError); }
      materialOutcomes.push({ schema_version: 1 as const, provider, stage: 'material', execution_status: 'partial', reason, bundle_ids: [bundle.bundle_id] });
    }
  }
  const manifest = {
    schema_version: 1, kind: required(options, 'kind'), lane: required(options, 'lane'), cutoff, bundles: files,
    selection_basis: request.selection_basis ?? (request.range || request.period ? 'capture_lane' : 'event_time'),
    ...(source ? { source } : {}), ...(range ? { range } : {}), providers: [...prepared.providers, ...materialOutcomes],
  };
  await privateAtomicJson(outputDir, 'manifest.json', manifest);
  return { output_dir: outputDir, ...manifest };
}

async function consumeCommand(parsed: ParsedCommand, services: RuntimeServices) {
  const target = required(parsed.options, 'target');
  const expected = target === 'all' ? ['analytics', 'monthly', 'evidence', 'index'] : [target];
  const outcomes = [];
  for (const name of expected) {
    const consumer = services.consumers.find(item => item.target === name);
    if (!consumer) unavailable(`consumer ${name}`);
    try { const outcome = await consumer.consume(); outcomes.push(outcome); assertStorageAvailable({ schema_version: 1, consumers: outcomes }); }
    catch (error) { if (storageFailureCode(error)) throw error; outcomes.push({ schema_version: 1, target: name, status: 'partial', reason: error instanceof Error ? error.message : String(error) }); }
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

async function replayCommand(parsed: ParsedCommand, config: BookkeepingConfig, services: RuntimeServices, cutoff: string) {
  const source = required(parsed.options, 'source');
  const adapters = services.adapters.filter(item => item.provider === source);
  if (!config.providers.some(provider=>provider.enabled&&provider.provider===source)) throw new InputError(`Unknown source ${source}`);
  const range = commandRange(parsed.options);
  let eventIds: string[] | undefined;
  if (parsed.options.events) {
    const manifest = version(await readJson(required(parsed.options, 'events')), 'replay event manifest');
    eventIds = array(manifest.event_ids, 'event_ids').map(value => string(value, 'event_id'));
    if (!eventIds.length || eventIds.length > 64 || new Set(eventIds).size !== eventIds.length) throw new InputError('Replay event selection requires 1–64 unique event IDs');
  }
  const configured = config.providers.filter(item => item.enabled && item.provider === source);
  let batches = 0;
  const recapture = [];
  for (const [index, adapter] of (eventIds ? [] : adapters).entries()) {
    // Runtime factories preserve configured provider order; adapters may also
    // expose an explicit account identity (e.g. native WeChat).
    const accountId = adapter.account_id ?? (configured.length === adapters.length ? configured[index].account_id : undefined);
    let saved = 0;
    let completeCapture = true;
    const checkpoints = await adapterCheckpoints(services, adapter.provider);
    const context = { checkpoints, generation_checkpoints: checkpoints, config };
    let persisting = false;
    try {
      if (!adapter.replay) throw new Error(`Source adapter does not support recapture: ${source}`);
      for await (const batch of adapter.replay(range, context)) {
        persisting = true;
        await services.store.saveCollection(batch);
        persisting = false;
        saved++;
        batches++;
        // Finishing the iterator proves execution ended, not that discovery or
        // capture covered the requested scope. Preserve the adapter's gaps.
        const complete = batch.coverage.length > 0 && batch.coverage.every(item => item.capture_status === 'complete' && item.gaps.length === 0);
        completeCapture &&= complete;
      }
      if (!saved) {
        await recordCollectionFailure(services, config, adapter, 'history', range, cutoff, 'Recapture returned no coverage evidence', false, accountId);
      }
      recapture.push({ provider: source, account_id: accountId ?? null, execution_status: 'complete',
        capture_status: saved ? completeCapture ? 'complete' : 'partial' : 'unknown', batches: saved });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (persisting || storageFailureCode(error)) throw storageFailure(error);
      // A source outage cannot prevent review of already durable events. A
      // failure to persist that outage still fails execution rather than hiding it.
      await recordCollectionFailure(services, config, adapter, 'history', range, cutoff, reason, saved > 0, accountId);
      recapture.push({ provider: source, account_id: accountId ?? null, execution_status: saved ? 'partial' : 'unavailable',
        capture_status: saved ? 'partial' : 'unavailable', batches: saved, reason });
    }
  }
  const replayKey = typeof parsed.options['replay-key'] === 'string' ? parsed.options['replay-key']
    : 'range:' + createHash('sha256').update(JSON.stringify([source, utcComparisonKey(range.from), utcComparisonKey(range.to)])).digest('hex');
  const work = await services.store.requestSemanticReplay({ schema_version: 1, replay_key: replayKey, source, range, cutoff, ...(eventIds ? { event_ids: eventIds } : {}) });
  return { schema_version: 1, source, batches, range, recapture, selection_basis:eventIds?'stored_exact':'recapture_range', replay_id: work.work_id, cutoff: work.payload.cutoff, review_state: work.state,
    next_prepare: `prepare --kind daily --lane history --replay-id ${work.work_id} --output DIR` };
}

export async function executeCommand(parsed: ParsedCommand, config: BookkeepingConfig, services: RuntimeServices, cutoff: string, now: () => Date = () => new Date()): Promise<unknown> {
  const options = parsed.options;
  switch (parsed.command) {
    case 'collect': return collectCommand(parsed, config, services, cutoff);
    case 'prepare': return prepareCommand(parsed, config, services, cutoff);
    case 'journal-proposal': return journalProposalCommand(options,config,services);
    case 'review-risk-inventory': return reviewRiskInventoryCommand(await readJson(required(options,'input')),services);
    case 'journal-reassess': return journalReassessCommand(await readJson(required(options,'input')),services,now);
    case 'journal-decide': return journalDecideCommand(await readJson(required(options,'input')),config,services);
    case 'journal-prepare': return prepareJournalCommand(options, config, services, cutoff);
    case 'journal-resolve': return resolveJournalCommand(await readJson(required(options, 'input')), services);
    case 'journal-inventory': return journalInventoryCommand(options, config, services);
    case 'journal-recover': {
      if (!services.store.recoverJournalPublication) unavailable('journal recovery');
      const input = version(await readJson(required(options, 'input')), 'journal recovery');
      const resultIds = array(input.result_ids, 'result_ids').map(id => string(id, 'result_id'));
      if (!resultIds.length || resultIds.length > 100 || new Set(resultIds).size !== resultIds.length) throw new InputError('Recovery requires1–100 unique accepted result IDs');
      return services.store.recoverJournalPublication({ schema_version: 1, result_ids: resultIds, created_at: now().toISOString() });
    }
    case 'monthly-round': {
      const {runMonthlyRound}=await import('./monthly-round.ts');return runMonthlyRound(options,config,services,now);
    }
    case 'daily-round': {
      const { runDailyRound } = await import('./daily-round.ts');
      return runDailyRound(options, config, services, { now,
        collect: (source, lane, frozen, maxDuration) => collectCommand({ command: 'collect', options: { source, lane, cutoff: frozen } }, config, services, frozen, maxDuration, now) });
    }
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
    case 'replay': return replayCommand(parsed, config, services, cutoff);
    case 'facts': return { schema_version: 1, facts: await services.store.readEffectiveFacts({ range: commandRange(options) }) };
    case 'analytics-review': return services.analyticsReview
      ? services.analyticsReview(await readJson(required(options, 'input'))) : unavailable('analytics review');
    case 'status': return { schema_version: 1, ...await services.store.status(), monthly_semantic: services.store.monthlySemanticStatus ? await services.store.monthlySemanticStatus(cutoff, now().toISOString()) : { schema_version: 1, execution_status: 'unavailable', reason: 'Monthly semantic metadata capability unavailable; completion was not inferred' } };
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
  createRuntime?: (config: BookkeepingConfig, command?: string, options?: Record<string, string | boolean>, now?: () => Date) => Promise<RuntimeServices>;
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
      const executionClock = dependencies.now ?? (() => new Date().toISOString());
      const cutoff = executionClock();
      utc(cutoff, 'runtime clock');
      const now = () => new Date(utc(executionClock(), 'runtime clock'));
      services = await (dependencies.createRuntime ?? createRuntime)(config, parsed.command, parsed.options, now);
      result = await executeCommand(parsed, config, services, cutoff, now);
      assertStorageAvailable(result);
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
    const errorCode = (error as NodeJS.ErrnoException)?.code;
    const storage = storageFailureCode(error) !== null;
    stdout(JSON.stringify({ schema_version: 1, error: { kind: code === 2 ? 'invalid_input' : 'execution_failed', message, ...(storage ? { scope: 'storage' } : {}) }, ...((error as Error & {receipt?: unknown}).receipt ? { receipt: (error as Error & {receipt?: unknown}).receipt } : {}) }) + '\n');
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
