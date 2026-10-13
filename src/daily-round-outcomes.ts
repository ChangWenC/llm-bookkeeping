type Status = 'unknown' | 'not_run' | 'partial' | 'complete';
interface Outcome { status:Status; reason:string; }
const outcome=(status:Status,reason:string):Outcome=>({status,reason});
/** Receipts prove stage execution; stopping a round never proves delivery or semantic completion. */
export function dailyStageOutcomes(state: {receipts:Record<string,unknown>[];active:unknown;skip_units:unknown[];skipped_journal_ids:string[];blocked?:Record<string,string[]>;unavailable?:Record<string,string[]>;phase:string;sources?:string[];exhausted?:Record<string,string[]>}, status?:Record<string,any>|null,expectedTargets:string[]=[]){
 const receipts=state.receipts.map(row=>({stage:String(row.stage),value:row.result as Record<string,any>}));
 const published=receipts.filter(row=>row.value?.fact_commit!==undefined||row.value?.export_status!==undefined);
 const latest=published.at(-1)?.value;
 const reviewDebt=state.active||state.skip_units.length||Object.values(state.blocked??{}).some(ids=>ids.length)||Object.values(state.unavailable??{}).some(ids=>ids.length);
 const scopeExhausted=Boolean(state.sources?.length&&state.sources.every(source=>['live','history'].every(lane=>state.exhausted?.[lane]?.includes(source))));
 const review=outcome(reviewDebt||Number(status?.review?.eligible_pending)>0?'partial':scopeExhausted?'complete':state.phase==='stopped'?'partial':receipts.some(row=>row.stage==='prepare'||row.stage==='publish')?'partial':'not_run',scopeExhausted&&!reviewDebt?'Every accessible source/lane is explicitly exhausted; partial coverage remains independent':Number(status?.review?.eligible_pending)>0?'Global metadata reports eligible debt (possibly outside this frozen run); stopping does not certify complete review':'Stopping, quota limits and deadlines do not prove remaining material reviewed');
 const pendingExports=status?.pending_exports;
 const fact_export=outcome(typeof pendingExports==='number'&&pendingExports>0?'partial':!latest?'not_run':latest.export_status==='ready'&&pendingExports===0?'complete':latest.export_status==='pending'||latest.export_status==='failed'?'partial':'unknown',typeof pendingExports==='number'?`${pendingExports} durable fact exports pending`:'No final metadata proof of remaining export debt');
 const pendingFiles=status?.pending_patches,conflicts=status?.conflicting_patches;
 const fileRun=receipts.some(row=>row.value?.file_status_counts!==undefined);
 const file_publication=outcome((typeof pendingFiles==='number'&&pendingFiles>0)||(typeof conflicts==='number'&&conflicts>0)?'partial':!fileRun?'not_run':pendingFiles===0&&conflicts===0?'complete':'unknown',typeof pendingFiles==='number'?`${pendingFiles} pending patches; ${conflicts??'unknown'} conflicts`:'Final file debt metadata unavailable');
 const journalDebt=status?.journal_publication;
 const journalRun=receipts.some(row=>row.stage.includes('journal')||row.value?.resolution_id!==undefined);
 const journal=outcome(state.skipped_journal_ids.length||['pending','conflict','unresolved','awaiting_user_confirmation'].some(key=>Number(journalDebt?.[key])>0)?'partial':!journalRun?'not_run':journalDebt?.pending===0?'complete':'unknown',journalDebt?`${journalDebt.pending} journal work pending; awaiting user confirmation and deferred work are not completed`:'Journal metadata unavailable; no implicit approval or completion');
 const targets=new Map<string,Record<string,any>>();
 for(const row of receipts){for(const consumer of row.value?.consumer_outcomes??[])targets.set(consumer.target,consumer);if(row.value?.target)targets.set(row.value.target,row.value);}
 const indexReceipt=targets.get('index');
 const index=outcome(!indexReceipt?'not_run':indexReceipt.status==='complete'?'complete':['pending','partial','unavailable'].includes(indexReceipt.status)?'partial':'unknown',indexReceipt?.reason??(!indexReceipt?'Index stage was not run':'Latest index receipt'));
 const consumerRows=[...targets.values()].filter(row=>row.target!=='index');
 const expected=[...new Set(expectedTargets.filter(target=>target!=='index'))],missing=expected.filter(target=>!targets.has(target));
 const consumers=outcome(!consumerRows.length?'not_run':!expected.length?'unknown':missing.length||consumerRows.some(row=>row.status!=='complete')?'partial':'complete',!consumerRows.length?'No consumer receipt':consumerRows.map(row=>`${row.target}:${row.status}`).join('; ')+(missing.length?`; not run: ${missing.join(',')}`:'')+'; delivery does not prove monthly semantic review');
 const stages={review,fact_export,file_publication,journal,index,consumers};
 return {stage_outcomes:stages,overall_status:Object.values(stages).every(row=>row.status==='complete')?'complete' as const:'partial' as const};
}
