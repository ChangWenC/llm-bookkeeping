import type {SqliteStore} from '../store/index.ts';
export interface PreparationTimingReport {
    schema_version:1; elapsed_ms:number; dropped_steps:number;
    steps:{name:string;start_ms:number;elapsed_ms:number;depth:number;rows:number|null;failed:boolean}[];
    totals:{name:string;calls:number;elapsed_ms:number;max_ms:number;rows:number;failures:number}[];
}
/** Operator-only measurement of the existing preparation path. Never emits
 * source identities, arguments, SQL, result values or error text. Installing
 * this probe does not make preparation read-only: its normal classification,
 * cursor and bundle writes must be confined to the coordinator's clone. */
export function installPreparationTimingProbe(store:SqliteStore):{stop():PreparationTimingReport} {
    const started=performance.now(),steps:PreparationTimingReport['steps']=[],totals=new Map<string,PreparationTimingReport['totals'][number]>(),restore:(()=>void)[]=[];
    let depth=0,dropped=0;
    const rows=(value:unknown):number|null=>Array.isArray(value)?value.length:value instanceof Map||value instanceof Set?value.size:value===undefined||value===null?0:typeof value==='object'?1:null;
    const record=(name:string,start:number,level:number,value:unknown,failed:boolean,detailed:boolean)=>{
        const elapsed=performance.now()-start,count=rows(value),total=totals.get(name)??{name,calls:0,elapsed_ms:0,max_ms:0,rows:0,failures:0};total.calls++;total.elapsed_ms+=elapsed;total.max_ms=Math.max(total.max_ms,elapsed);total.rows+=count??0;total.failures+=Number(failed);totals.set(name,total);
        if(detailed){if(steps.length<256)steps.push({name,start_ms:start-started,elapsed_ms:elapsed,depth:level,rows:count,failed});else dropped++;}
    };
    const wrap=(target:any,key:string,name:string,detailed=true)=>{
        const original=target[key];if(typeof original!=='function')return;
        target[key]=function(...args:any[]){const start=performance.now(),level=depth++;try{const value=original.apply(this,args);if(value&&typeof value.then==='function')return Promise.resolve(value).then(result=>{record(name,start,level,result,false,detailed);return result;},error=>{record(name,start,level,undefined,true,detailed);throw error;}).finally(()=>{depth--;});depth--;record(name,start,level,value,false,detailed);return value;}catch(error){depth--;record(name,start,level,undefined,true,detailed);throw error;}};
        restore.push(()=>{target[key]=original;});
    };
    const bucket=(sql:string)=>{
        if(/preparation_cursors/.test(sql))return /SELECT/i.test(sql)?'sql.cursor_read':'sql.cursor_save';
        if(/kind='archive'/.test(sql))return 'sql.journal_archive_work';
        if(/state='applied'.*desired_bytes_base64/.test(sql))return 'sql.journal_archived_intent';
        if(/FROM fragments/.test(sql))return 'sql.source_fragment';
        if(/SELECT id,ordering,CASE/.test(sql))return 'sql.codex_anchor';
        if(/FROM events WHERE id IN/.test(sql))return 'sql.selected_source_rows';
        if(/reviewed_(units|spans|sources)/.test(sql))return 'sql.review_marks';
        if(/FROM facts WHERE id=/.test(sql))return 'sql.exact_fact_rows';
        if(/FROM coverage/.test(sql))return 'sql.coverage_rows';
        if(/event_classification|event_identity_time|event_conflict/.test(sql))return 'sql.diagnostic_metadata';
        if(/^\s*SELECT/i.test(sql))return 'sql.other_read';
        return 'sql.other_write';
    };
    const db=store.db as any,prepare=db.prepare;
    db.prepare=function(sql:string){const statement=prepare.call(this,sql),name=bucket(sql);return new Proxy(statement,{get(target,key){const value=Reflect.get(target,key,target);if(typeof value!=='function')return value;if(!['get','all','run'].includes(String(key)))return value.bind(target);return (...args:any[])=>{const start=performance.now();try{const output=value.apply(target,args);record(name,start,depth,output,false,false);return output;}catch(error){record(name,start,depth,undefined,true,false);throw error;}};}});};restore.push(()=>{db.prepare=prepare;});
    const exec=db.exec;db.exec=function(sql:string){const name=/^\s*BEGIN/i.test(sql)?'sql.transaction_begin':/^\s*COMMIT/i.test(sql)?'sql.transaction_commit':/^\s*ROLLBACK/i.test(sql)?'sql.transaction_rollback':'sql.exec_other',start=performance.now();try{const value=exec.call(this,sql);record(name,start,depth,value,false,false);return value;}catch(error){record(name,start,depth,undefined,true,false);throw error;}};restore.push(()=>{db.exec=exec;});
    for(const name of ['getExplicitReviewFacts','acceptedReviewIdentity','getBundle','getReviewCandidatePage','getSelectedReviewEvents','resolveJournalPath','getReviewMarks','lookupFactRevisions','getScopedReviewFacts','filterReviewFacts','listReviewCoverage','reviewReadExclusions','getClassificationGaps','sourcePendingGaps','metadataScopeGaps','getContextEvents','isContextTruncated','saveBundle','reconcileCodexPage','resolveCodexEvent','sourceFragment','fragmentReadBlocked','persistCodexCorrection','transaction'])wrap(store,name,'store.'+name);
    for(const name of ['allowed','enrich','eventAllowed'])wrap(store.reviewScope,name,'scope.'+name,false);
    for(const name of ['allowed','fragmentBlocked','eventAllowed'])wrap(store.readExclusions,name,'exclusions.'+name,false);
    return {stop(){for(const undo of restore.reverse())undo();return {schema_version:1,elapsed_ms:performance.now()-started,dropped_steps:dropped,steps:steps.sort((a,b)=>a.start_ms-b.start_ms),totals:[...totals.values()].sort((a,b)=>b.elapsed_ms-a.elapsed_ms)};}};
}
