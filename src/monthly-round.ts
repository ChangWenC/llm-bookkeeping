import { randomUUID,createHash } from 'node:crypto';
import { basename,join,resolve } from 'node:path';
import { DEFAULT_MONTHLY_ROUND_LIMITS } from './config.ts';
import { InputError,version,utc,array,string,validateReviewResult } from './contracts/validation.ts';
import { privateDirectory,privateFileParent,privateAtomicJson,readJson,MAX_PRIVATE_JSON_BYTES } from './material-files.ts';
import { calendarDate } from './time.ts';
import { assertStorageAvailable,storageFailureCode } from './storage-errors.ts';
import type { BookkeepingConfig,RuntimeServices,FactsPage,ReviewBundle,MonthlyRoundLimits } from './contracts/types.ts';
interface MonthProgress {cutoff:string;facts_page:FactsPage|null;archive_context_offset:number;done:boolean;unavailable:boolean;work_only?:boolean;pending_work_count?:number;pending_archive_context_count?:number}
interface ActiveMonth {month:string;bundle_id:string;file:string;facts_page:FactsPage|null;archive_next_offset:number|null;accepted?:{result_id:string;batch_id:string|null};material_status?:'partial'|'complete'|'unavailable';terminal_disposition?:string;work_only?:boolean;pending_work_count_before?:number}
interface MonthlyState {
 schema_version:1;run_id:string;started_at:string;cutoff:string;config_identity:string;output_dir:string;limits:MonthlyRoundLimits;
 order:string[];months:Record<string,MonthProgress>;cursor:number;started_bundles:number;started_bundle_ids:string[];
 active:ActiveMonth|null;phase:'review'|'stopped';receipts:Record<string,unknown>[];page_paths:string[];
 archive_month:string|null;archive_attempted:boolean;reason?:string;
}
const identity=(config:BookkeepingConfig)=>createHash('sha256').update(JSON.stringify([config.data_dir,config.wiki_root,config.providers,config.limits,config.monthly_round_limits])).digest('hex');
export function previousMonth(asOf:string,timezone='Europe/Amsterdam'):string {const current=calendarDate(asOf,timezone).slice(0,7);const date=new Date(`${current}-01T12:00:00Z`);date.setUTCMonth(date.getUTCMonth()-1);return date.toISOString().slice(0,7);}
/** One externally authored monthly semantic packet per selected month, then rotate. */
export async function runMonthlyRound(options:Record<string,string|boolean>,config:BookkeepingConfig,services:RuntimeServices,now:()=>Date){
 const output=resolve(options.output as string),path=options.manifest as string;
 await privateDirectory(output,config);const parent=await privateFileParent(path,config);let state:MonthlyState;
 try {
  state=version(version(await readJson(path,MAX_PRIVATE_JSON_BYTES)).monthly_round,'monthly_round') as MonthlyState;
  if(state.config_identity!==identity(config)||state.output_dir!==output)throw new InputError('Monthly round config/output changed');
  utc(state.started_at,'started_at');utc(state.cutoff,'cutoff');
  if(options.cutoff&&options.cutoff!==state.cutoff)throw new InputError('Preserve original monthly cutoff');
  if(options['archive-month']&&options['archive-month']!==state.archive_month)throw new InputError('Preserve selected archive month');
  if(!Number.isSafeInteger(state.started_bundles)||state.started_bundles<0||state.started_bundles>state.limits.max_started_bundles)throw new InputError('Invalid monthly started count');
  array(state.order,'order');array(state.receipts,'receipts');
 }catch(error){
  if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
  if(options.finish||options.input||options['defer-active'])throw new InputError('Monthly continuation requires an existing manifest');
  if(!services.store.monthlySemanticStatus)throw new Error('Monthly semantic metadata capability unavailable');
  const started=now().toISOString(),cutoff=options.cutoff as string??started;utc(cutoff,'cutoff');
  if(Date.parse(cutoff)>Date.parse(started))throw new InputError('Monthly cutoff cannot follow actual start');
  const debt=await services.store.monthlySemanticStatus(cutoff,started),previous=previousMonth(started,config.journal_timezone);
  const order=[previous,...debt.months.filter(m=>m.eligible&&m.month<previous).map(m=>m.month).sort()];
  const months:Record<string,MonthProgress>={};
  for(const month of [...new Set(order)]){const frozen=debt.months.find(m=>m.month===month)?.continuation??null;months[month]={cutoff:frozen?.cutoff??cutoff,facts_page:frozen,archive_context_offset:0,done:false,unavailable:false};}
  let pagePaths:string[]=[];if(options.pages){const targets=version(await readJson(options.pages as string));pagePaths=array(targets.paths,'paths').map(p=>string(p,'path'));}
  const archiveMonth=options['archive-month'] as string??null;
  if(archiveMonth&&archiveMonth>=previous)throw new InputError('Archive retains current and preceding month');
  state={schema_version:1,run_id:randomUUID(),started_at:started,cutoff,config_identity:identity(config),output_dir:output,limits:{...DEFAULT_MONTHLY_ROUND_LIMITS,...config.monthly_round_limits},order:[...new Set(order)],months,cursor:0,started_bundles:0,started_bundle_ids:[],active:null,phase:'review',receipts:[],page_paths:pagePaths,archive_month:archiveMonth,archive_attempted:false};
 }
 const taskDeadline=Date.parse(state.started_at)+state.limits.task_duration_ms,semanticDeadline=Date.parse(state.started_at)+state.limits.semantic_start_duration_ms;
 const remaining=()=>Math.max(0,taskDeadline-now().getTime()),canStart=()=>now().getTime()<semanticDeadline&&state.started_bundles<state.limits.max_started_bundles;
 if(now().getTime()<Date.parse(state.started_at))throw new InputError('Execution clock precedes monthly start');
 services.setDeadline?.(new Date(taskDeadline).toISOString());
 const receiptDir=join(output,'receipts');await privateDirectory(receiptDir,config);
 const save=()=>privateAtomicJson(parent,basename(path),{schema_version:1,monthly_round:state},false,MAX_PRIVATE_JSON_BYTES);
 const receipt=async(stage:string,value:unknown,month?:string)=>{
  const id=randomUUID(),file=join(receiptDir,`${id}.json`),at=now().toISOString();
  await privateAtomicJson(receiptDir,`${id}.json`,{schema_version:1,receipt_id:id,stage,at,month:month??null,result:value},true);
  const object=value as any,summary:Record<string,unknown>={};
  for(const key of ['status','execution_status','reason','fact_commit','result_id','batch_id','export_status'])if(object?.[key]!==undefined)summary[key]=object[key];
  for(const key of ['files','pending','consumers','pages'])if(Array.isArray(object?.[key]))summary[`${key}_count`]=object[key].length;
  state.receipts.push({receipt_id:id,stage,at,month:month??null,file,result:summary});await save();
 };
 const response=async(status:string,extra:Record<string,unknown>={})=>{await save();return {schema_version:1,run_id:state.run_id,manifest:path,started_at:state.started_at,cutoff:state.cutoff,state:status,terminal:state.phase==='stopped',semantic_deadline:new Date(semanticDeadline).toISOString(),task_deadline:new Date(taskDeadline).toISOString(),remaining_ms:remaining(),started_bundles:state.started_bundles,active:state.active,months:state.order.map(month=>({month,...state.months[month]})),stages:state.receipts.slice(-8),next_action:state.phase==='stopped'?'Retain pending debt; next normal monthly run uses a new manifest':state.active?'Read bounded monthly material and submit exact result':'Continue this monthly manifest',...extra};};
 const settle=async(reason:string)=>{
  if(state.active){if(!state.active.accepted&&services.store.acceptedReviewIdentity){const accepted=await services.store.acceptedReviewIdentity(state.active.bundle_id);if(accepted)state.active.accepted={result_id:accepted.result_id,batch_id:accepted.batch_id};}state.active.terminal_disposition=state.active.accepted?'committed_recovery':'deferred_unreviewed';await receipt('finish-active',{bundle_id:state.active.bundle_id,reason,accepted:state.active.accepted??null,execution_status:state.active.terminal_disposition},state.active.month);}
  if(remaining()){
   try{const value=await services.publisher.resume();assertStorageAvailable(value);await receipt('final-resume',value);}catch(error){if(storageFailureCode(error))throw error;await receipt('final-resume',{execution_status:'partial',reason:error instanceof Error?error.message:String(error),receipt:(error as {receipt?:unknown}).receipt});}
   for(const consumer of services.consumers){if(!remaining())break;try{const value=await consumer.consume();assertStorageAvailable(value);await receipt('consume',value);}catch(error){if(storageFailureCode(error))throw error;await receipt('consume',{target:consumer.target,execution_status:'partial',reason:error instanceof Error?error.message:String(error),receipt:(error as {receipt?:unknown}).receipt});}}
   if(state.archive_month&&!state.archive_attempted&&remaining()){
    if(!services.archive)throw new Error('Archive capability unavailable');state.archive_attempted=true;await save();
    const report=await services.archive({month:state.archive_month,mode:'report'});await receipt('archive-report',report,state.archive_month);
    if(remaining()){const applied=await services.archive({month:state.archive_month,mode:'apply'});assertStorageAvailable(applied);await receipt('archive-apply',applied,state.archive_month);
     // Archive creates new index debt; consume once more within the original task budget.
     for(const consumer of services.consumers){if(!remaining())break;try{const value=await consumer.consume();assertStorageAvailable(value);await receipt('post-archive-consume',value);}catch(error){if(storageFailureCode(error))throw error;await receipt('post-archive-consume',{target:consumer.target,execution_status:'partial',reason:error instanceof Error?error.message:String(error),receipt:(error as {receipt?:unknown}).receipt});}}}
   }
  }
  const status=remaining()>=120_000?await services.store.status():null;state.phase='stopped';state.reason=reason;
  return response(remaining()?'complete':'deadline',{reason,status,...(status===null?{status_omitted_reason:'Full status omitted near original task deadline; exact receipts and debt retained'}:{})});
 };
 await save();
 if(state.phase==='stopped')return response(remaining()?'complete':'deadline',{reason:state.reason});
 if(!remaining())return settle('Original two-hour monthly deadline reached');
 if(options.finish)return settle(options.reason as string);
 if(options.input){
  const active=state.active;if(!active)throw new InputError('No active monthly material');
  let input;try{input=validateReviewResult(await readJson(options.input as string));if(input.bundle_id!==active.bundle_id||input.monthly_review?.month!==active.month)throw new InputError('Result does not match active monthly semantic packet');}catch(error){if(storageFailureCode(error))throw error;return response('repair_input',{reason:error instanceof Error?error.message:String(error)});}
  try{
   const published=await services.publisher.publish(input);assertStorageAvailable(published);await receipt('publish',published,active.month);
   if(!['committed','already_committed'].includes(published.fact_commit))return response('publication_pending',{reason:'Uncommitted monthly input retained'});
   active.accepted={result_id:published.result_id??input.result_id,batch_id:published.batch_id};
   active.material_status=input.chunks.length>0&&input.chunks.every(chunk=>chunk.status==='complete')?'complete':'partial';
   if(active.material_status!=='complete')return response('monthly_material_deferred',{accepted:active.accepted,reason:'Accepted semantic result did not complete every supplied material chunk; frozen page remains unread',next_action:'Preserve the accepted result; explicitly defer this active page or finish with its remaining debt'});
   if((input.monthly_review!.completed_work_ids?.length??0)>0&&published.consumers.find(consumer=>consumer.target===`monthly-publish:${published.batch_id}`)?.status!=='complete')return response('publication_pending',{accepted:active.accepted,reason:'Accepted monthly work closure awaits exact batch publication; retain the original active input',next_action:'Retry this identical accepted input within the original run deadline'});
   const progress=state.months[active.month];
   if(!active.facts_page||!services.store.factMaterialProgress){active.material_status='unavailable';return response('monthly_material_deferred',{accepted:active.accepted,reason:'Exact frozen fact material progress unavailable; page completion was not inferred',next_action:'Retain this accepted page and finish or explicitly defer without advancing'});}
   const proof=await services.store.factMaterialProgress(active.facts_page.snapshot_id);
   if(!proof||proof.snapshot_id!==active.facts_page.snapshot_id||proof.cutoff!==active.facts_page.cutoff||proof.total!==active.facts_page.total||![proof.pending_work_count,proof.pending_archive_context_count].every(n=>Number.isSafeInteger(n)&&n>=0)){active.material_status='unavailable';return response('monthly_material_deferred',{accepted:active.accepted,reason:'Exact frozen material/work progress missing or mismatched; unread debt retained'});}
   progress.pending_work_count=proof.pending_work_count;progress.pending_archive_context_count=proof.pending_archive_context_count;
   if(active.work_only&&proof.pending_work_count>0&&proof.pending_work_count>=Number(active.pending_work_count_before)){active.material_status='unavailable';return response('monthly_material_deferred',{accepted:active.accepted,reason:'Accepted work-only page did not close any supplied frozen work; preserve active identity for publication recovery or explicit deferral'});}
   progress.done=proof.first_unread_offset===null&&active.archive_next_offset===null&&proof.pending_work_count===0&&proof.pending_archive_context_count===0;
   progress.facts_page={...active.facts_page,offset:proof.first_unread_offset??proof.total,next_offset:proof.first_unread_offset};
   progress.work_only=proof.first_unread_offset===null&&proof.pending_work_count>0&&proof.pending_archive_context_count===0&&state.page_paths.length===0;
   if(active.archive_next_offset!==null)progress.archive_context_offset=active.archive_next_offset;
   state.active=null;state.cursor=(state.cursor+1)%state.order.length;await save();
  }catch(error){
   if(storageFailureCode(error))throw error;
   const full=(error as {receipt?:any}).receipt;
   if(full&&['committed','already_committed'].includes(full.fact_commit))active.accepted={result_id:full.result_id,batch_id:full.batch_id??null};
   if(!active.accepted&&services.store.acceptedReviewIdentity){const accepted=await services.store.acceptedReviewIdentity(active.bundle_id);if(accepted)active.accepted={result_id:accepted.result_id,batch_id:accepted.batch_id};}
   await receipt('publish-failure',{execution_status:active.accepted?'committed_recovery':error instanceof InputError?'invalid_input':'uncommitted_failure',accepted:active.accepted??null,receipt:full??null,reason:error instanceof Error?error.message:String(error)},active.month);
   return response(!active.accepted&&error instanceof InputError?'repair_input':'publication_pending',{accepted:active.accepted??null,receipt:full??null,next_action:active.accepted?'Recover identical accepted result; never rewrite semantics':'Retry same input or explicitly defer'});
  }
 }else if(options['defer-active']){if(!state.active)throw new InputError('No monthly active to defer');const active=state.active;await receipt('defer',{bundle_id:active.bundle_id,reason:options['defer-active'],execution_status:active.accepted?'committed_recovery':'deferred_unreviewed'},active.month);state.months[active.month].unavailable=true;state.active=null;state.cursor=(state.cursor+1)%state.order.length;await save();}
 else if(state.active)return response(state.active.material_status&&state.active.material_status!=='complete'?'monthly_material_deferred':state.active.accepted?'publication_pending':'monthly_review');
 if(!canStart())return settle(state.started_bundles>=state.limits.max_started_bundles?'96-start limit reached':'105-minute semantic deadline reached');
 for(let attempt=0;attempt<state.order.length&&canStart()&&remaining();attempt++){
  const month=state.order[state.cursor],progress=state.months[month];
  if(progress.facts_page&&!progress.unavailable){
   const proof=await services.store.factMaterialProgress?.(progress.facts_page.snapshot_id);
   if(!proof||proof.snapshot_id!==progress.facts_page.snapshot_id||proof.cutoff!==progress.facts_page.cutoff||proof.total!==progress.facts_page.total||![proof.pending_work_count,proof.pending_archive_context_count].every(n=>Number.isSafeInteger(n)&&n>=0)){progress.done=false;progress.unavailable=true;await receipt('work-progress',{execution_status:'unavailable',reason:'Exact frozen work progress unavailable; completion not inferred'},month);}
   else{
    progress.pending_work_count=proof.pending_work_count;progress.pending_archive_context_count=proof.pending_archive_context_count;
    progress.facts_page={...progress.facts_page,offset:proof.first_unread_offset??proof.total,next_offset:proof.first_unread_offset};
    progress.work_only=false;
    if(proof.first_unread_offset===null&&proof.pending_work_count>0&&proof.pending_archive_context_count===0&&state.page_paths.length===0){
     const prior=services.store.hasCompleteMonthlyConclusion?await services.store.hasCompleteMonthlyConclusion(proof.snapshot_id):null;
     if(typeof prior!=='boolean'){progress.unavailable=true;await receipt('work-progress',{execution_status:'unavailable',reason:'Prior complete monthly conclusion proof unavailable; work-only not inferred'},month);}else progress.work_only=prior;
    }
    if(proof.pending_work_count>0||proof.pending_archive_context_count>0||proof.first_unread_offset!==null)progress.done=false;
   }
  }
  if(progress.done||progress.unavailable){state.cursor=(state.cursor+1)%state.order.length;continue;}
  try{
   const bundles=await services.reviewer.prepare({kind:'monthly',lane:'history',period:month,cutoff:progress.cutoff,max_bundles:1,page_paths:progress.work_only?undefined:state.page_paths,work_only:progress.work_only,fact_snapshot:progress.facts_page?.snapshot_id,fact_offset:progress.facts_page?.offset,archive_context_offset:progress.work_only?undefined:progress.archive_context_offset});
   if(bundles.length!==1||!bundles[0].monthly_context)throw new Error('Monthly preparation unavailable; no typed semantic material');
   const bundle:ReviewBundle=bundles[0];if(bundle.period!==month||bundle.cutoff!==progress.cutoff)throw new Error('Monthly material scope changed');
   if(state.started_bundle_ids.includes(bundle.bundle_id))throw new Error('Repeated monthly packet without accepted progress');
   if(!canStart()||!remaining())break;
   const bytes=Buffer.byteLength(JSON.stringify(bundle));if(bytes>config.limits.bundle_bytes)throw new Error('Monthly packet exceeds final byte budget');
   const name=`monthly-${encodeURIComponent(bundle.bundle_id)}.json`;await privateAtomicJson(output,name,bundle,true,config.limits.bundle_bytes,bytes<config.limits.bundle_bytes);
   state.started_bundles++;state.started_bundle_ids.push(bundle.bundle_id);
   state.active={month,bundle_id:bundle.bundle_id,file:join(output,name),facts_page:bundle.monthly_context!.facts_page??null,archive_next_offset:bundle.monthly_context!.archive_context_page?.next_offset??null,work_only:bundle.monthly_context!.work_only,pending_work_count_before:progress.pending_work_count};
   await receipt('prepare',{bundle_id:bundle.bundle_id,execution_status:'complete',unfinished:bundle.unfinished.length},month);return response('monthly_review');
  }catch(error){if(storageFailureCode(error))throw error;await receipt('prepare',{execution_status:'unavailable',reason:error instanceof Error?error.message:String(error)},month);progress.unavailable=true;state.cursor=(state.cursor+1)%state.order.length;await save();}
 }
 return settle('Frozen monthly semantic selection finished or locally deferred; remaining debt is retained');
}
