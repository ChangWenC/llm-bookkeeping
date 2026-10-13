import { dailyStageOutcomes } from './daily-round-outcomes.ts';
import { basename, join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { PERSONAL_DAILY_ROUND_LIMITS } from './config.ts';
import { InputError, version, utc, validateReviewResult, array } from './contracts/validation.ts';
import { privateDirectory, privateFileParent, privateAtomicJson, readJson, MAX_PRIVATE_JSON_BYTES } from './material-files.ts';
import { saveJournalMaterial, resolveJournalCommand } from './journal-cli.ts';
import { storageFailureCode, assertStorageAvailable } from './storage-errors.ts';
import type { BookkeepingConfig, RuntimeServices, ReviewBundle, ReviewUnit, Lane, DailyRoundLimits, PreparationContinuation } from './contracts/types.ts';

interface ActiveSource { kind: 'source'; source: string; lane: Lane; bundle_id: string; file: string; units: ReviewUnit[]; candidate_continuation?: PreparationContinuation; accepted?: {result_id:string;batch_id:string|null}; input_file?:string; terminal_disposition?:string }
interface ActiveJournal { kind: 'journal'; journal_bundle_id: string; file: string; work_ids: string[]; accepted?: {resolution_id:string}; input_file?:string; terminal_disposition?:string }
export interface DailyRoundState {
  schema_version: 1; run_id: string; cutoff: string; started_at: string; config_identity: string; output_dir: string;
  limits: DailyRoundLimits; sources: string[]; capture_elapsed_ms: number; capture_index: number;
  capture_reservation_ms: number; started_bundles: number; started_bundle_ids: string[];
  wave_started: number; live_started: number; history_started: number;
  fair_cursor: Record<Lane, number>; exhausted: Record<Lane, string[]>; skip_units: ReviewUnit[];
  bootstrap_attempted: Record<Lane, string[]>; allocation_cursor: number;
  skipped_journal_ids: string[]; journal_batches: number; active: ActiveSource | ActiveJournal | null;
  initial_settled: boolean; final_settled: boolean; phase: 'initial' | 'review' | 'final' | 'stopped';
  receipts: Record<string, unknown>[];
  completed_source_bundles?: number; journal_checked_after_source?: number;
  scan_cursor?: number;
  scan_progress?: Record<string,{frontier:string;stalled:number}>;
  blocked?: Record<Lane,string[]>;
  continuations?: Record<string, PreparationContinuation>; unavailable?: Record<Lane,string[]>; finish_reason?:string; read_exclusion_identity?:string;
}
export interface DailyRoundHooks {
  now: () => Date;
  collect: (source: string, lane: Lane, cutoff: string, max_duration_ms: number) => Promise<unknown>;
}

function identity(config: BookkeepingConfig): string {
  return createHash('sha256').update(JSON.stringify([config.data_dir, config.wiki_root, config.cutover_at, config.live_start, config.providers, config.limits, config.daily_round_limits])).digest('hex');
}
export function sourceUnits(bundle: ReviewBundle): ReviewUnit[] {
  const units = bundle.chunks.flatMap(chunk => chunk.events.map(event => {
    const slice = event.context.review_slice as { source_event_id?: string; start_byte?: number; end_byte?: number } | undefined;
    return { schema_version: 1 as const, event_id: slice?.source_event_id ?? event.event_id, start_byte: slice?.start_byte ?? 0, end_byte: slice?.end_byte ?? Buffer.byteLength(event.body ?? '') };
  }));
  return [...new Map(units.map(unit => [JSON.stringify(unit), unit])).values()];
}
function remaining(state: DailyRoundState, now: () => Date): number {
  const elapsed = now().getTime() - Date.parse(state.started_at);
  if (elapsed < 0) throw new InputError('Execution clock precedes persisted round start');
  return Math.max(0, state.limits.task_duration_ms - elapsed);
}
function canStart(state: DailyRoundState, now: () => Date): boolean {
  return now().getTime() - Date.parse(state.started_at) < state.limits.semantic_start_duration_ms && state.started_bundles < state.limits.max_started_bundles;
}
function knownStorage(error: unknown): boolean {
  return storageFailureCode(error) !== null;
}
async function localFailure(error: unknown, services: RuntimeServices): Promise<string> {
  if (knownStorage(error)) throw error;
  return error instanceof Error ? error.message : String(error);
}

/** One persisted external-review step. No model or source semantics are generated here. */
export async function runDailyRound(options: Record<string,string|boolean>, config: BookkeepingConfig, services: RuntimeServices, hooks: DailyRoundHooks) {
  const path = options.manifest as string, output = resolve(options.output as string);
  await privateDirectory(output, config);
  const parent = await privateFileParent(path, config);
  let state: DailyRoundState;
  try {
    const manifest = version(await readJson(path, MAX_PRIVATE_JSON_BYTES), 'daily manifest');
    state = version(manifest.daily_round, 'daily_round') as DailyRoundState;
    if (state.config_identity !== identity(config) || state.output_dir !== output) throw new InputError('Daily round config/output changed; preserve its original scheduling scope');
    utc(state.started_at, 'started_at'); utc(state.cutoff, 'cutoff');
    if (options.cutoff && options.cutoff !== state.cutoff) throw new InputError('Daily round requires its original cutoff');
    if (!Number.isSafeInteger(state.started_bundles) || state.started_bundles < 0 || state.started_bundles > state.limits.max_started_bundles) throw new InputError('Invalid daily manifest bundle count');
    array(state.skip_units, 'skip_units'); array(state.receipts, 'receipts');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if(options.finish)throw new InputError('Finish requires an existing round manifest');
    const started = hooks.now().toISOString(), cutoff = options.cutoff as string ?? started;
    utc(cutoff, 'cutoff');
    if (Date.parse(cutoff) > Date.parse(started)) throw new InputError('Round cutoff cannot follow actual start');
    const limits = config.daily_round_limits ?? { ...PERSONAL_DAILY_ROUND_LIMITS, wave_bundles: config.limits.bundles_per_round,
      live_bundles: Math.max(1, config.limits.bundles_per_round - 1), history_bundles: 1, max_started_bundles: config.limits.bundles_per_round };
    if (config.limits.bundles_per_round === 1 && !config.daily_round_limits) { limits.live_bundles = 1; limits.history_bundles = 0; }
    state = { schema_version: 1, run_id: randomUUID(), cutoff, started_at: started, config_identity: identity(config), output_dir: output, limits,
      sources: [...new Set(config.providers.filter(p => p.enabled).map(p => p.provider))], capture_elapsed_ms: 0, capture_index: 0, capture_reservation_ms: 0,
      started_bundles: 0, started_bundle_ids: [], wave_started: 0, live_started: 0, history_started: 0,
      fair_cursor: { live: 0, history: 0 }, exhausted: { live: [], history: [] }, bootstrap_attempted: { live: [], history: [] }, allocation_cursor: 0, skip_units: [], skipped_journal_ids: [], journal_batches: 0, active: null,
      initial_settled: false, final_settled: false, phase: 'initial', receipts: [] };
  }
  // Add scheduling metadata without replacing the original clock, active material or counters.
  state.completed_source_bundles ??= Math.max(0,state.started_bundles-state.journal_batches-(state.active?.kind==='source'?1:0));
  state.journal_checked_after_source ??= state.completed_source_bundles;
  state.continuations ??= {}; state.unavailable ??= {live:[],history:[]};
  state.scan_cursor ??= state.allocation_cursor;
  state.scan_progress ??= {}; state.blocked ??= {live:[],history:[]};
  const exclusionsIdentity=createHash('sha256').update(JSON.stringify(config.review_read_exclusions??null)).digest('hex');
  if(state.read_exclusion_identity!==exclusionsIdentity){
    // Only this permitted metadata protection change invalidates candidate tokens.
    // Never relax unrelated source/config/scope validation or reset the run clock.
    state.continuations={};
    if(state.active?.kind==='source')delete state.active.candidate_continuation;
    state.read_exclusion_identity=exclusionsIdentity;
  }
  const receiptDir = join(output, 'receipts'); await privateDirectory(receiptDir, config);
  const pendingReceipts: { name: string; value: unknown }[] = [];
  const save = async () => {
    while (pendingReceipts.length) { const item = pendingReceipts[0]; await privateAtomicJson(receiptDir, item.name, item.value, true); pendingReceipts.shift(); }
    await privateAtomicJson(parent, basename(path), { schema_version: 1, daily_round: state }, false, MAX_PRIVATE_JSON_BYTES);
  };
  services.setDeadline?.(new Date(Date.parse(state.started_at) + state.limits.task_duration_ms).toISOString());
  const receipt = (stage: string, result: unknown, source?: string, lane?: Lane) => {
    const receiptId = randomUUID(), name = `${receiptId}.json`, at = hooks.now().toISOString();
    const entry = { schema_version: 1, receipt_id: receiptId, stage, ...(source ? { source } : {}), ...(lane ? { lane } : {}), at, result };
    pendingReceipts.push({ name, value: entry });
    const value = result as Record<string,any> | null, summary: Record<string,unknown> = {};
    if (value && typeof value === 'object') {
      for (const key of ['execution_status','fact_commit','export_status','result_id','batch_id','resolution_id','target','status','reason','reused']) if (value[key] !== undefined) summary[key] = value[key];
      for (const key of ['files','providers','consumers','work_ids','bundle_ids','pending']) if (Array.isArray(value[key])) summary[`${key}_count`] = value[key].length;
      if (Array.isArray(value.consumers)) summary.consumer_outcomes=value.consumers.map((consumer:any)=>({target:consumer.target,status:consumer.status,reason:consumer.reason}));
      if (value.receipt && typeof value.receipt==='object') {for(const key of ['fact_commit','export_status'])if(value.receipt[key]!==undefined)summary[key]=value.receipt[key];}
      if (Array.isArray(value.files)) summary.file_status_counts = Object.fromEntries(['applied','noop','pending','conflict'].map(status => [status,value.files.filter((file:any)=>file.status===status).length]));
    }
    state.receipts.push({ receipt_id: receiptId, stage, ...(source ? { source } : {}), ...(lane ? { lane } : {}), at, file: join(receiptDir,name), result: summary });
  };
  const skip = (units: ReviewUnit[]) => { state.skip_units = [...new Map([...state.skip_units, ...units].map(unit => [JSON.stringify(unit), unit])).values()]; };
  const response = async (status: string, extra: Record<string,unknown> = {}) => {
    await save();
    return { schema_version: 1, run_id: state.run_id, manifest: path, cutoff: state.cutoff, started_at: state.started_at, state: status,
      started_bundles: state.started_bundles, capture_elapsed_ms: state.capture_elapsed_ms, remaining_ms: remaining(state, hooks.now),
      terminal: state.phase==='stopped',
      semantic_deadline: new Date(Date.parse(state.started_at)+state.limits.semantic_start_duration_ms).toISOString(),
      task_deadline: new Date(Date.parse(state.started_at)+state.limits.task_duration_ms).toISOString(),
      next_action: state.phase==='stopped'?'Retain remaining debt; use a new manifest for another run':state.active?'Review or recover the same active identity':'Continue this manifest',
      blocked_pairs: [...state.blocked!.live.map(source=>({source,lane:'live',reason:'Three preparations without real progress'})),...state.blocked!.history.map(source=>({source,lane:'history',reason:'Three preparations without real progress'}))],
      active: state.active, stages: state.receipts.slice(-8), ...dailyStageOutcomes(state,extra.status as Record<string,any>|null|undefined,services.consumers.map(consumer=>consumer.target)), ...extra };
  };
  await save();
  // Deadline and explicit finish use metadata before any active/source body guard.
  if(state.phase==='stopped')return response(remaining(state,hooks.now)?'complete':'deadline',{reason:state.finish_reason??'This run already stopped'});
  const finish = async(reason:string) => {
    if(state.active?.kind==='source') {
      const active=state.active;
      if(!active.accepted && services.store.acceptedReviewIdentity) {
        const accepted=await services.store.acceptedReviewIdentity(active.bundle_id);
        if(accepted)active.accepted={result_id:accepted.result_id,batch_id:accepted.batch_id};
      }
      if(!active.accepted) { skip(active.units); active.terminal_disposition='deferred_unreviewed'; receipt('finish-active',{execution_status:'deferred',reason,bundle_id:active.bundle_id,units:active.units},active.source,active.lane); }
      else {active.terminal_disposition='committed_recovery';receipt('finish-active',{execution_status:'committed_recovery',...active.accepted,bundle_id:active.bundle_id},active.source,active.lane);}
    } else if(state.active?.kind==='journal') {
      const active=state.active;
      if(!active.accepted&&services.store.acceptedJournalResolutionIdentity){const accepted=await services.store.acceptedJournalResolutionIdentity(active.journal_bundle_id);if(accepted)active.accepted={resolution_id:accepted.resolution_id};}
      active.terminal_disposition=active.accepted?'committed_recovery':'deferred_unreviewed';
      if(!active.accepted)state.skipped_journal_ids.push(...active.work_ids);
      receipt('finish-active',{execution_status:active.terminal_disposition,reason,journal_bundle_id:active.journal_bundle_id,work_ids:active.work_ids,...active.accepted});
    }
    if(remaining(state,hooks.now)>0) {
      try {const result=await services.publisher.resume();receipt('finish-resume',result);assertStorageAvailable(result);await save();}
      catch(error){if(knownStorage(error))throw error;const value=error as {receipt?:unknown};receipt('finish-resume',{execution_status:'partial',reason:error instanceof Error?error.message:String(error),receipt:value.receipt});await save();}
      for(const consumer of services.consumers){if(!remaining(state,hooks.now))break;try{const result=await consumer.consume();receipt('finish-consume',result);assertStorageAvailable(result);await save();}catch(error){if(knownStorage(error))throw error;receipt('finish-consume',{target:consumer.target,execution_status:'partial',reason:error instanceof Error?error.message:String(error),receipt:(error as {receipt?:unknown}).receipt});await save();}}
    }
    const status=remaining(state,hooks.now)>=120_000?await services.store.status():null;
    state.phase='stopped';state.final_settled=true;state.finish_reason=reason;
    return response(remaining(state,hooks.now)?'complete':'deadline',{reason,status,...(status===null?{status_omitted_reason:'Full status omitted near original task deadline; exact receipts and debt retained'}:{})});
  };
  if(!remaining(state,hooks.now))return finish('Two-hour task deadline reached; durable debt retained');
  if(options.finish)return finish(options.reason as string);
  if (state.active?.kind === 'source' && !options['defer-active']) {
    if (config.review_read_exclusions?.events.length && !services.store.assertReviewBundleReadable) throw new InputError('Store cannot enforce configured review read exclusions');
    if(!state.active.accepted&&services.store.acceptedReviewIdentity){const accepted=await services.store.acceptedReviewIdentity(state.active.bundle_id);if(accepted)state.active.accepted={result_id:accepted.result_id,batch_id:accepted.batch_id};}
    // Accepted publication recovery does not reopen restricted source material.
    if(!state.active.accepted)await services.store.assertReviewBundleReadable?.(state.active.bundle_id);
  }

  // Invalid JSON or result shape keeps the same active identity for pure format repair.
  if (options.input || options['journal-input']) {
    const active = state.active;
    if (!active || Boolean(options.input) !== (active.kind === 'source')) throw new InputError('Input must match the current active source/journal material');
    let input: unknown;
    try { input = await readJson((options.input ?? options['journal-input']) as string); }
    catch (error) { if(knownStorage(error))throw error;receipt('format', { execution_status: 'invalid_input', reason: error instanceof Error ? error.message : String(error) }); return response('repair_input'); }
    try {
      if (active.kind === 'source') {
        const result = validateReviewResult(input);
        if (result.bundle_id !== active.bundle_id) throw new InputError('ReviewResult does not match active bundle');
        active.input_file=options.input as string;
        const published = await services.publisher.publish(result);
        receipt('publish', published, active.source, active.lane);
        assertStorageAvailable(published); await save();
        if (published.fact_commit === 'pending' || published.fact_commit === 'failed') return response('publication_pending', { reason: 'Active semantic result has not committed; preserve it for retry or explicit deferral' });
        active.accepted={result_id:published.result_id??result.result_id,batch_id:published.batch_id};
        skip(active.units); state.completed_source_bundles!++;
        if(active.candidate_continuation)state.continuations![`${active.source}:${active.lane}`]=active.candidate_continuation;
      } else {
        const result = version(input, 'journal resolution');
        if (result.journal_bundle_id !== active.journal_bundle_id) throw new InputError('JournalResolution does not match active journal bundle');
        const resolved = await resolveJournalCommand(input, services); receipt('journal-resolve', resolved); assertStorageAvailable(resolved); await save();
        active.accepted={resolution_id:resolved.resolution_id};
        state.skipped_journal_ids.push(...active.work_ids);
      }
      state.active = null; await save();
    } catch (error) {
      if(knownStorage(error))throw error;
      const reason=error instanceof Error?error.message:String(error);
      const fullReceipt=(error as {receipt?:any}).receipt;
      if(active.kind==='source' && fullReceipt && ['committed','already_committed'].includes(fullReceipt.fact_commit))active.accepted={result_id:fullReceipt.result_id,batch_id:fullReceipt.batch_id??null};
      if(active.kind==='journal' && fullReceipt?.resolution_commit==='committed')active.accepted={resolution_id:fullReceipt.resolution_id};
      if(active.kind==='source' && !active.accepted && services.store.acceptedReviewIdentity){const accepted=await services.store.acceptedReviewIdentity(active.bundle_id);if(accepted)active.accepted={result_id:accepted.result_id,batch_id:accepted.batch_id};}
      const committed=!!active.accepted;
      receipt('acceptance',{execution_status:committed?'committed_recovery':error instanceof InputError?'invalid_input':'uncommitted_failure',reason,accepted:active.accepted??null,receipt:fullReceipt??null},active.kind==='source'?active.source:undefined);
      await save();
      return response(committed?'publication_pending':error instanceof InputError?'repair_input':'publication_pending',{reason,receipt:fullReceipt??null,accepted:active.accepted??null,next_action:committed?'Recover the same accepted identity; do not rewrite its semantic input':'Retry the same input or explicitly defer this uncommitted active item'});
    }
  } else if (options['defer-active']) {
    const active = state.active;
    if (!active) throw new InputError('No active material to defer');
    const reason = options['defer-active'] as string;
    receipt(options['defer-stage'] as string ?? (active.kind === 'journal' ? 'journal' : 'review'), { execution_status: 'deferred', reason }, active.kind === 'source' ? active.source : undefined, active.kind === 'source' ? active.lane : undefined);
    if (active.kind === 'source') skip(active.units); else state.skipped_journal_ids.push(...active.work_ids);
    state.active = null; await save();
  } else if (state.active) {
    if(state.active.accepted)return response('publication_pending',{accepted:state.active.accepted,next_action:'Retry the same accepted input or --finish --reason REASON for bounded recovery'});
    return response(state.active.kind === 'source' ? 'review' : 'journal_review');
  }

  // Reserve each physical call before execution: a crash charges that finite allowance.
  const captures = ['live','history'].flatMap(lane => state.sources.map(source => ({ source, lane: lane as Lane })));
  while (state.capture_index < captures.length && remaining(state, hooks.now) > 0 && canStart(state, hooks.now)) {
    const { source, lane } = captures[state.capture_index];
    const allowance = Math.min(state.limits.capture_duration_ms - state.capture_elapsed_ms, remaining(state, hooks.now));
    if (allowance <= 0) break;
    const before = hooks.now().getTime();
    state.capture_reservation_ms = allowance; state.capture_elapsed_ms += allowance; state.capture_index++; await save();
    try { receipt('collect', await hooks.collect(source, lane, state.cutoff, allowance), source, lane); }
    catch (error) { if(knownStorage(error))throw error;receipt('collect', { execution_status: 'partial', reason:error instanceof Error?error.message:String(error), receipt:(error as {receipt?:unknown}).receipt??null }, source, lane);await save(); }
    const elapsed = Math.max(0, hooks.now().getTime() - before);
    state.capture_elapsed_ms += elapsed - allowance; state.capture_reservation_ms = 0; await save();
  }

  async function settle(phase: 'initial' | 'final' | 'interleaved'): Promise<boolean> {
    if (!remaining(state, hooks.now)) return false;
    const settled = phase === 'initial' ? state.initial_settled : phase === 'final' ? state.final_settled : false;
    if (!settled) {
      try { const resumed = await services.publisher.resume(); receipt(`${phase}-resume`, resumed); assertStorageAvailable(resumed); await save(); }
      catch (error) {if(knownStorage(error))throw error;receipt(`${phase}-resume`,{execution_status:'partial',reason:error instanceof Error?error.message:String(error),receipt:(error as {receipt?:unknown}).receipt??null});await save();}
      if (phase === 'initial') state.initial_settled = true; else if (phase === 'final') state.final_settled = true;
      await save();
    }
    if (!remaining(state, hooks.now) || !canStart(state, hooks.now) || !services.reviewer.prepareJournalWork || (phase === 'initial' && state.journal_batches >= 1)) return false;
    const work = (await services.store.listWork('journal_publication')).filter(w => w.state !== 'complete' && w.payload.awaiting_user_confirmation!==true && !state.skipped_journal_ids.includes(w.work_id));
    if (!work.length) return false;
    const candidates = work.slice(0, Math.min(32, config.limits.chunk_events * config.limits.bundles_per_round)).map(w => w.work_id);
    while (candidates.length && canStart(state, hooks.now) && remaining(state, hooks.now)) {
      let count = candidates.length;
      while (count > 0 && canStart(state, hooks.now) && remaining(state, hooks.now)) {
        const ids = candidates.slice(0, count);
        try {
          const material = await services.reviewer.prepareJournalWork({ schema_version: 1, cutoff: state.cutoff, work_ids: ids, max_items: ids.length });
          if (!material.work.length) throw new Error('Journal preparation provided no work progress');
          if (material.work.some(work => !ids.includes(work.work_id)) || new Set(material.work.map(work=>work.work_id)).size !== material.work.length) throw new Error('Journal preparation did not honor selected unique work IDs');
          if (state.started_bundle_ids.includes(material.journal_bundle_id)) throw new Error('Repeated journal bundle without progress');
          if (!canStart(state, hooks.now) || !remaining(state, hooks.now)) return false;
          const saved = await saveJournalMaterial(material, output, config);
          state.journal_batches++; state.started_bundles++; state.started_bundle_ids.push(material.journal_bundle_id);
          state.active = { kind: 'journal', journal_bundle_id: material.journal_bundle_id, file: saved.file, work_ids: saved.work_ids };
          receipt(`${phase}-journal`, saved); return true;
        } catch (error) {
          const reason = await localFailure(error, services);
          if (count > 1) { count = Math.max(1, Math.floor(count / 2)); continue; }
          receipt(`${phase}-journal`, { execution_status: 'partial', reason, work_ids: ids });
          state.skipped_journal_ids.push(ids[0]); candidates.shift(); await save(); break;
        }
      }
    }
    return false;
  }

  if (state.phase === 'initial') {
    if (await settle('initial')) return response('journal_review');
    state.phase = 'review'; await save();
  }
  const exhausted = (lane: Lane) => state.sources.every(source => state.exhausted[lane].includes(source)||state.unavailable![lane].includes(source)||state.blocked![lane].includes(source));
  while (state.phase === 'review' && canStart(state, hooks.now) && remaining(state, hooks.now) > 0 && !(exhausted('live') && exhausted('history'))) {
    const journalDue=state.completed_source_bundles!-state.journal_checked_after_source!>=4;
    const lateJournal=hooks.now().getTime()-Date.parse(state.started_at)>=5_400_000;
    if(journalDue||lateJournal){state.journal_checked_after_source=state.completed_source_bundles;if(await settle('interleaved'))return response('journal_review');}
    if (state.wave_started >= state.limits.wave_bundles) {
      state.wave_started = 0; state.live_started = 0; state.history_started = 0;
    }
    const bootstrapLive = !state.sources.every(source => state.bootstrap_attempted.live.includes(source));
    const bootstrapHistory = !state.sources.every(source => state.bootstrap_attempted.history.includes(source));
    let lane: Lane = bootstrapLive ? 'live' : bootstrapHistory ? 'history' : state.scan_cursor! % 3 === 2 ? 'history' : 'live';
    if (lane === 'live' && state.live_started >= state.limits.live_bundles && !exhausted('history')) lane = 'history';
    if (lane === 'history' && state.history_started >= state.limits.history_bundles && !exhausted('live')) lane = 'live';
    if (exhausted(lane)) lane = lane === 'live' ? 'history' : 'live';
    const candidates = state.sources;
    let source = '';
    for (let count = 0; count < candidates.length; count++) {
      const index = state.fair_cursor[lane] % candidates.length; state.fair_cursor[lane] = (index + 1) % candidates.length;
      if (!state.exhausted[lane].includes(candidates[index]) && !state.unavailable![lane].includes(candidates[index]) && !state.blocked![lane].includes(candidates[index]) && (!(lane === 'live' ? bootstrapLive : bootstrapHistory) || !state.bootstrap_attempted[lane].includes(candidates[index]))) { source = candidates[index]; break; }
    }
    if (!source) break;
    if (!state.bootstrap_attempted[lane].includes(source)) state.bootstrap_attempted[lane].push(source);
    state.scan_cursor!++;
    try {
      const request = { kind: 'daily' as const, lane, source, cutoff: state.cutoff, max_bundles: 1, skip_units: state.skip_units, selection_basis:'event_time' as const, candidate_continuation:state.continuations![`${source}:${lane}`] };
      const prepared = services.reviewer.prepareWithOutcomes ? await services.reviewer.prepareWithOutcomes(request)
        : { bundles: await services.reviewer.prepare(request), providers: [] };
      receipt('prepare', { providers: prepared.providers, bundle_ids: prepared.bundles.map(b => b.bundle_id) }, source, lane);
      if (prepared.bundles.length > 1) throw new Error('One-bundle preparation exceeded allocation');
      const candidate=prepared.providers.find(p=>p.provider===source)?.preparation;
      if(candidate?.deferred_units.length)skip(candidate.deferred_units.map(item=>item.unit));
      const bundle = prepared.bundles[0];
      const pair=`${source}:${lane}`, previous=state.scan_progress![pair];
      const frontier=candidate?.progress?.frontier ?? createHash('sha256').update(JSON.stringify([candidate?.progress?.phase??null,candidate?.deferred_units??[],Boolean(bundle?.chunks.some(chunk=>chunk.events.length))])).digest('hex');
      const realProgress=Boolean(bundle?.chunks.some(chunk=>chunk.events.length)) || Boolean(candidate?.progress?.advanced) || Boolean(previous&&previous.frontier!==frontier);
      const stalled=realProgress?0:(previous?.stalled??0)+1;
      state.scan_progress![pair]={frontier,stalled};

      if (!bundle || !bundle.chunks.some(c => c.events.length)) {
        if(candidate?.continuation)state.continuations![`${source}:${lane}`]=candidate.continuation;
        if(candidate?.state==='exhausted') {state.exhausted[lane].push(source);await save();continue;}
        if(candidate?.state==='unavailable'){state.unavailable![lane].push(source);await save();continue;}
        if(stalled>=3 && !state.blocked![lane].includes(source))state.blocked![lane].push(source);
        // Old implementations cannot prove exhaustion from one empty filtered page.
        return response(stalled>=3?'prepare_blocked':'prepare_more',{source,lane,preparation:candidate??null,next_action:'Continue bounded preparation with this manifest; empty material is not source exhaustion'});
      }
      if (bundle.source !== source || bundle.lane !== lane || bundle.cutoff !== state.cutoff) throw new Error('Prepared bundle source/lane/cutoff does not match selection');
      const units = sourceUnits(bundle);
      if (state.started_bundle_ids.includes(bundle.bundle_id)) { skip(units); state.unavailable![lane].push(source); receipt('prepare', { execution_status: 'partial', reason: 'Repeated bundle without progress' }, source, lane); await save(); continue; }
      if (!canStart(state, hooks.now) || !remaining(state, hooks.now)) break;
      const jsonBytes = Buffer.byteLength(JSON.stringify(bundle));
      if (jsonBytes > config.limits.bundle_bytes) { skip(units); throw new Error('Final source bundle exceeds configured byte bound'); }
      const name = `bundle-${encodeURIComponent(bundle.bundle_id)}.json`;
      try { await privateAtomicJson(output, name, bundle, true, config.limits.bundle_bytes, jsonBytes < config.limits.bundle_bytes); }
      catch (error) { skip(units); throw error; }
      state.started_bundles++; state.started_bundle_ids.push(bundle.bundle_id); state.wave_started++;
      if (lane === 'live') state.live_started++; else state.history_started++;
      if (!bootstrapLive && !bootstrapHistory) state.allocation_cursor++;
      state.active = { kind: 'source', source, lane, bundle_id: bundle.bundle_id, file: join(output, name), units, ...(candidate?.continuation?{candidate_continuation:candidate.continuation}:{}) };
      return response('review');
    } catch (error) {
      receipt('prepare', { execution_status: 'partial', reason: await localFailure(error, services) }, source, lane);
      state.unavailable![lane].push(source); await save();
    }
  }
  state.phase = 'final';
  if (await settle('final')) return response('journal_review');
  if (remaining(state, hooks.now)) {
    for (const consumer of services.consumers) {
      if (!remaining(state, hooks.now)) break;
      try { const outcome = await consumer.consume(); receipt('consume', outcome); assertStorageAvailable(outcome); await save(); }
      catch (error) {if(knownStorage(error))throw error;receipt('consume',{target:consumer.target,execution_status:'partial',reason:error instanceof Error?error.message:String(error),receipt:(error as {receipt?:unknown}).receipt??null});await save();}
    }
  }
  const status = remaining(state, hooks.now)>=120_000 ? await services.store.status() : null;
  state.phase = 'stopped';
  return response(remaining(state, hooks.now) ? 'complete' : 'deadline', { review_status: state.blocked!.live.length+state.blocked!.history.length+state.unavailable!.live.length+state.unavailable!.history.length+state.skip_units.length>0?'partial':'accessible_complete', stop_reason: state.started_bundles >= state.limits.max_started_bundles ? 'bundle_limit' : canStart(state, hooks.now) ? 'no_progress' : 'semantic_deadline', status, ...(status===null?{status_omitted_reason:'Full status omitted near original task deadline; exact receipts and debt retained'}:{}) });
}
