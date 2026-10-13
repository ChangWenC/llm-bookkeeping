import { resolve, join } from 'node:path';
import { InputError, version, array, string, utc, date } from './contracts/validation.ts';
import { privateDirectory, privateAtomicJson, readJson } from './material-files.ts';
import { acquireWikiLock } from './publish/lock.ts';
import { assertStorageAvailable } from './storage-errors.ts';
import type { BookkeepingConfig, RuntimeServices, JournalResolution, JournalWorkBundle, JournalUserDecision, JournalReassessmentRequest, ReviewRiskInventoryRequest } from './contracts/types.ts';

export function validateJournalResolution(value: unknown): JournalResolution {
  const r = version(value, 'journal resolution');
  string(r.resolution_id, 'resolution_id'); string(r.journal_bundle_id, 'journal_bundle_id'); utc(r.created_at, 'created_at');
  for (const forbidden of ['chunks','candidates','facts','bundle_id','analysis','monthly_review']) if (forbidden in r) throw new InputError('Journal resolution cannot carry source review or new facts');
  for (const d of array(r.dispositions, 'dispositions')) {
    version(d); string(d.work_id, 'work_id');
    if (!['patch','already_present','not_needed','defer'].includes(d.disposition)) throw new InputError('Invalid journal disposition');
    if (d.suggestion_id !== undefined) string(d.suggestion_id, 'suggestion_id');
    if (d.evidence_text !== undefined) string(d.evidence_text, 'evidence_text');
    if (d.disposition === 'already_present') string(d.evidence_text, 'already_present.evidence_text');
    if (d.disposition !== 'patch') string(d.reason, 'disposition.reason');
  }
  for (const p of array(r.pages, 'pages')) {
    version(p); for (const key of ['suggestion_id','path','baseline_digest']) string(p[key], key);
    date(p.date, 'page.date'); array(p.work_ids, 'work_ids').forEach(id => string(id, 'work_id'));
    if (!['append','replace'].includes(p.mode) || typeof p.new_text !== 'string') throw new InputError('Invalid journal page mode/text');
    if (p.mode === 'replace') string(p.old_text, 'old_text');
    if (p.supersedes_operation_id !== undefined) string(p.supersedes_operation_id, 'supersedes_operation_id');
  }
  return r as JournalResolution;
}

export async function saveJournalMaterial(bundle: JournalWorkBundle, output: string, config: BookkeepingConfig) {
  await privateDirectory(output, config);
  if (Buffer.byteLength(JSON.stringify(bundle) + '\n') > config.limits.bundle_bytes) throw new InputError('Journal bundle exceeds configured final byte bound');
  const name = `journal-${encodeURIComponent(bundle.journal_bundle_id)}.json`;
  await privateAtomicJson(output, name, bundle, true);
  return { schema_version: 1, journal_bundle_id: bundle.journal_bundle_id, cutoff: bundle.cutoff, file: join(output, name), work_ids: bundle.work.map(w => w.work_id), facts: bundle.facts.length, baselines: bundle.baselines.length, conflicts: bundle.conflicts.length };
}

export async function prepareJournalCommand(options: Record<string,string|boolean>, config: BookkeepingConfig, services: RuntimeServices, cutoff: string) {
  if (!services.reviewer.prepareJournalWork) throw new Error('Journal preparation capability unavailable');
  const output = resolve(options.output as string);
  let workIds: string[] | undefined;
  if (options.work) { const selection = version(await readJson(options.work as string), 'journal work selection'); workIds = array(selection.work_ids, 'work_ids').map(id => string(id, 'work_id')); }
  const bundle = await services.reviewer.prepareJournalWork({ schema_version: 1, cutoff: options.cutoff as string ?? cutoff, work_ids: workIds, max_items: options['max-items'] === undefined ? undefined : Number(options['max-items']) });
  return saveJournalMaterial(bundle, output, config);
}

export async function resolveJournalCommand(input: unknown, services: RuntimeServices) {
  if (!services.store.commitJournalResolution) throw new Error('Journal resolution capability unavailable');
  const commit = await services.store.commitJournalResolution(validateJournalResolution(input));
  const accepted = { schema_version: 1, resolution_id: commit.resolution_id, reused: commit.reused, work_ids: commit.work_ids, patch_operation_ids: commit.patches.map(patch=>patch.operation_id), resolution_commit: 'committed' };
  let files;
  try { files = await services.publisher.applyPatches(commit.patches); }
  catch(error) { throw Object.assign(new Error(error instanceof Error?error.message:String(error),{cause:error}),{receipt:{...accepted,execution_status:'partial',files:null,publication:null,continuation:{stage:'apply',status:'failed'}}}); }
  assertStorageAvailable({ ...accepted, files });
  // Derived historical targets and pre-existing exports continue without a new semantic result.
  let publication;
  try { publication = await services.publisher.resume(); }
  catch(error) { throw Object.assign(new Error(error instanceof Error?error.message:String(error),{cause:error}),{receipt:{...accepted,execution_status:'partial',files,publication:null,continuation:{stage:'resume',status:'failed'}}}); }
  return { ...accepted, files,
    publication, pending: [...files.filter(f => ['pending','conflict'].includes(f.status)).map(f => f.operation_id), ...publication.pending] };
}

export async function journalInventoryCommand(options: Record<string,string|boolean>, config: BookkeepingConfig, services: RuntimeServices) {
  if (!services.store.inventoryAcceptedDaily) throw new Error('Accepted daily inventory capability unavailable');
  const inventory = await services.store.inventoryAcceptedDaily({ from: options.from as string, to: options.to as string, after_result_id: options['after-result'] as string | undefined,
    limit: Number(options.limit ?? 20), include_unknown_acceptance: !options['exclude-unknown'] });
  const output = resolve(options.output as string); await privateDirectory(output, config);
  const name = 'accepted-daily-inventory.json'; await privateAtomicJson(output, name, inventory);
  return { schema_version: 1, file: join(output, name), items: inventory.items.length, unknown_acceptance: inventory.items.filter(i => i.window_membership === 'unknown').length,
    result_ids: inventory.items.map(i => i.result_id), next_result_id: inventory.next_result_id, range: { schema_version: 1, from: options.from, to: options.to } };
}


export function validateJournalUserDecision(value: unknown): JournalUserDecision {
  const item=version(value,'journal user decision');
  const fields=new Set(['schema_version','decision_id','proposal_id','proposal_digest','decision','basis','baseline_digest','fact_refs','work_ids','reason','response_source','response_content']);
  if(Object.keys(item).some(key=>!fields.has(key)))throw new InputError('Unknown journal decision field');
  for(const key of ['decision_id','proposal_id','proposal_digest','baseline_digest','reason'])string(item[key],key);
  if(item.response_source!==undefined||item.response_content!==undefined){string(item.response_source,'response_source');string(item.response_content,'response_content');if(Buffer.byteLength(item.response_source)>1024||Buffer.byteLength(item.response_content)>16384)throw new InputError('Journal answer metadata exceeds bound');}
  if(!['confirm','keep_existing'].includes(item.decision)||item.basis!=='explicit_user_response')throw new InputError('Journal decision requires explicit user response in cooperative chat');
  const ids=array(item.work_ids,'work_ids').map(id=>string(id,'work_id'));
  if(ids.length>320||new Set(ids).size!==ids.length)throw new InputError('Invalid exact work IDs');
  const refs=array(item.fact_refs,'fact_refs');if(refs.length>320)throw new InputError('Too many confirmation fact refs');
  for(const ref of refs){version(ref);string(ref.fact_id,'fact_id');if(!Number.isSafeInteger(ref.revision)||ref.revision<1)throw new InputError('Invalid confirmation fact revision');}
  if(new Set(refs.map(ref=>JSON.stringify([ref.fact_id,ref.revision]))).size!==refs.length)throw new InputError('Duplicate confirmation ref');
  return item as JournalUserDecision;
}
export async function journalProposalCommand(options: Record<string,string|boolean>,config:BookkeepingConfig,services:RuntimeServices){
  if(!services.store.getJournalConfirmation)throw new Error('Journal confirmation capability unavailable');
  const proposal=await services.store.getJournalConfirmation(options.id as string);
  if(!proposal)throw new InputError('Unknown journal proposal');
  const output=resolve(options.output as string);await privateDirectory(output,config);
  const name=`proposal-${encodeURIComponent(proposal.proposal_id)}.json`;await privateAtomicJson(output,name,proposal,true);
  return {schema_version:1,proposal_id:proposal.proposal_id,proposal_digest:proposal.proposal_digest,state:proposal.state,path:proposal.path,file:join(output,name),fact_refs:proposal.fact_refs,work_ids:proposal.work_ids};
}
export async function journalDecideCommand(input:unknown,config:BookkeepingConfig,services:RuntimeServices){
  const decision=validateJournalUserDecision(input);
  if(!services.store.decideJournalConfirmation)throw new Error('Journal confirmation capability unavailable');
  const lock=await acquireWikiLock(config.wiki_root);
  if(!lock)return {schema_version:1,decision_id:decision.decision_id,proposal_id:decision.proposal_id,status:'pending',reason:'Wiki writer is active; user decision was not committed'};
  try{return await services.store.decideJournalConfirmation(decision,lock);}finally{await lock.release();}
}

export async function journalReassessCommand(input:unknown,services:RuntimeServices,now:()=>Date){
 if(!services.store.reassessJournalPublication)throw new Error('Journal reassessment capability unavailable');
 const item=version(input,'journal reassessment');
 if(Object.keys(item).some(key=>!['schema_version','work_ids','mode','expected_plan_digest'].includes(key)))throw new InputError('Unknown reassessment field');
 const workIds=array(item.work_ids,'work_ids').map(id=>string(id,'work_id'));
 if(workIds.length<1||workIds.length>100||new Set(workIds).size!==workIds.length)throw new InputError('Reassessment requires1–100 unique exact work IDs');
 if(!['preview','apply'].includes(item.mode))throw new InputError('Reassessment mode must be preview or apply');
 if(item.mode==='apply'&&(typeof item.expected_plan_digest!=='string'||!/^[a-f0-9]{64}$/.test(item.expected_plan_digest)))throw new InputError('Apply requires exact preview plan digest');
 if(item.mode==='preview'&&item.expected_plan_digest!==undefined)throw new InputError('Preview cannot carry apply digest');
 return services.store.reassessJournalPublication({...item,work_ids:workIds,created_at:now().toISOString()} as JournalReassessmentRequest);
}

export function validateReviewRiskInventoryRequest(input:unknown):ReviewRiskInventoryRequest {
 const item=version(input,'review risk inventory');
 if(Object.keys(item).some(key=>!['schema_version','from','to','limit','after_result_id','known_mixed_event_ids'].includes(key)))throw new InputError('Unknown review risk inventory field');
 const from=utc(item.from,'from'),to=utc(item.to,'to');if(Date.parse(to)<=Date.parse(from)||Date.parse(to)-Date.parse(from)>7*86400000)throw new InputError('Review risk window must be nonempty and at most7 days');
 if(item.limit!==undefined&&(!Number.isSafeInteger(item.limit)||item.limit<1||item.limit>100))throw new InputError('Review risk limit must be1–100');
 if(item.after_result_id!==undefined)string(item.after_result_id,'after_result_id');
 if(item.known_mixed_event_ids!==undefined){const ids=array(item.known_mixed_event_ids,'known_mixed_event_ids').map(id=>string(id,'event_id'));if(ids.length>100||new Set(ids).size!==ids.length)throw new InputError('At most100 unique exact mixed event IDs');}
 return item as ReviewRiskInventoryRequest;
}
export async function reviewRiskInventoryCommand(input:unknown,services:RuntimeServices){
 if(!services.store.inventoryReviewRisks)throw new Error('Review risk inventory capability unavailable');
 return services.store.inventoryReviewRisks(validateReviewRiskInventoryRequest(input));
}
