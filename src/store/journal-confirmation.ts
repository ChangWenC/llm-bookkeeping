import type { DatabaseSync } from 'node:sqlite';
import type { JournalConfirmationRequest, JournalConfirmationProposal, JournalConfirmationGuard, JournalUserDecision, JournalUserDecisionReceipt, FileIntent, WorkItem, FactRef } from '../contracts/types.ts';
import { canonical,digest } from '../analytics/serialization.ts';
import { refKey,version,unique } from './domain.ts';
import { updateJournalWork } from './journal.ts';

const sortedRefs=(refs:FactRef[])=>[...new Map(refs.map(ref=>[refKey(ref),ref])).values()].sort((a,b)=>refKey(a).localeCompare(refKey(b)));
export function currentConfirmationRefs(db:DatabaseSync,refs:FactRef[]):boolean {
    return refs.every(ref=>!!db.prepare(`SELECT 1 FROM facts f WHERE f.id=? AND f.revision=?
      AND NOT EXISTS(SELECT 1 FROM facts later WHERE later.id=f.id AND later.revision>f.revision)
      AND NOT EXISTS(SELECT 1 FROM fact_targets t WHERE t.target_id=f.id AND t.target_revision>=f.revision)`).get(ref.fact_id,ref.revision));
}
export function getConfirmation(db:DatabaseSync,id:string):JournalConfirmationProposal|null {
    const row=db.prepare("SELECT json_extract(json,'$.payload.proposal') AS proposal FROM work WHERE id=? AND kind='journal_confirmation'").get(id) as {proposal:string}|undefined;
    return row?JSON.parse(row.proposal):null;
}
/** Fact changes can invalidate waiting work before the next writer or user decision. */
export function refreshStaleConfirmationFacts(db:DatabaseSync,at:string):void {
    const rows=db.prepare(`SELECT json_extract(w.json,'$.payload.proposal') AS proposal FROM work w WHERE w.kind='journal_confirmation' AND w.state='pending' AND EXISTS(SELECT 1 FROM json_each(w.json,'$.payload.proposal.fact_refs') r WHERE NOT EXISTS(SELECT 1 FROM facts f WHERE f.id=json_extract(r.value,'$.fact_id') AND f.revision=json_extract(r.value,'$.revision') AND NOT EXISTS(SELECT 1 FROM facts later WHERE later.id=f.id AND later.revision>f.revision) AND NOT EXISTS(SELECT 1 FROM fact_targets t WHERE t.target_id=f.id AND t.target_revision>=f.revision)))`).all();
    for(const row of rows)setProposal(db,{...JSON.parse(row.proposal as string),state:'stale'},at);
}
const guard=(proposal:JournalConfirmationProposal):JournalConfirmationGuard=>({schema_version:1,status:proposal.state,proposal_id:proposal.proposal_id,work_ids:proposal.work_ids,reason:proposal.reason});
export function ensureConfirmation(db:DatabaseSync,request:JournalConfirmationRequest,at:string):JournalConfirmationGuard {
    version(request);
    const operation=request.intent??request.patch;
    if(!operation || !operation.operation_id?.trim() || typeof request.old_text!=='string' || typeof request.new_text!=='string' || !request.reason?.trim())throw new Error('Invalid journal confirmation request');
    const linked=db.prepare("SELECT json FROM work WHERE kind='journal_publication' AND json_extract(json,'$.payload.operation_id')=? ORDER BY id").all(operation.operation_id).map(row=>JSON.parse(row.json as string) as WorkItem);
    const workIds=[...new Set(request.work_ids??linked.filter(item=>item.state!=='complete').map(item=>item.work_id))].sort();
    if(request.work_ids && (workIds.length!==request.work_ids.length || workIds.some(id=>!linked.some(item=>item.work_id===id))))throw new Error('Confirmation work outside exact journal operation');
    const refs=sortedRefs(operation.fact_refs);
    if(workIds.some(id=>{const item=linked.find(item=>item.work_id===id)!;return item.payload.path!==operation.path || !refs.some(ref=>refKey(ref)===refKey(item.payload.fact_ref as FactRef));}))throw new Error('Confirmation does not represent exact journal work');
    const previous=db.prepare("SELECT json_extract(json,'$.payload.proposal') AS proposal FROM work WHERE kind='journal_confirmation' AND json_extract(json,'$.payload.proposal.operation_id')=? ORDER BY rowid DESC").all(operation.operation_id).map(row=>JSON.parse(row.proposal as string) as JournalConfirmationProposal);
    const knownConflict=refs.some(ref=>!!db.prepare("SELECT 1 FROM facts WHERE id=? AND revision=? AND json_extract(json,'$.action') IN ('replace','retract')").get(ref.fact_id,ref.revision)) || linked.some(item=>item.reason?.includes('conflict'));
    if(!request.requires_confirmation && !knownConflict && !previous.length)return {schema_version:1,status:'not_required',proposal_id:null,work_ids:workIds,reason:null};
    const desired=request.intent?.desired_digest??digest(request.new_text);
    const body={schema_version:1 as const,operation_id:operation.operation_id,path:operation.path,baseline_digest:request.current_baseline_digest,desired_digest:desired,old_text:request.old_text,new_text:request.new_text,fact_refs:refs,work_ids:workIds,reason:request.reason};
    const proposalDigest=digest(canonical(body)),id='journal-confirmation:'+proposalDigest;
    const old=getConfirmation(db,id);
    const valid=currentConfirmationRefs(db,refs);
    for(const prior of previous.filter(item=>item.proposal_id!==id && item.state!=='keep_existing'))setProposal(db,{...prior,state:'stale'},at);
    if(old) {
        if(!valid || old.baseline_digest!==request.current_baseline_digest){setProposal(db,{...old,state:'stale'},at);return guard({...old,state:'stale'});}
        return guard(old);
    }
    const proposal:JournalConfirmationProposal={...body,proposal_id:id,proposal_digest:proposalDigest,state:valid?'awaiting_user_confirmation':'stale'};
    const work:WorkItem={schema_version:1,work_id:id,kind:'journal_confirmation',lane:linked[0]?.lane??'history',state:valid?'pending':'deferred',payload:{proposal},reason:valid?'awaiting_user_confirmation':'Exact proposed fact revision is stale',migration_key:null,updated_at:at};
    db.prepare('INSERT INTO work VALUES(?,?,?,?,?)').run(id,canonical(work),work.kind,work.state,null);
    for(const item of linked.filter(item=>workIds.includes(item.work_id)&&item.state!=='complete'))updateJournalWork(db,{...item,state:'deferred',payload:{...item.payload,confirmation_proposal_id:id,awaiting_user_confirmation:valid},reason:work.reason,updated_at:at});
    return guard(proposal);
}
function setProposal(db:DatabaseSync,proposal:JournalConfirmationProposal,at:string):void {
    const row=db.prepare('SELECT json FROM work WHERE id=?').get(proposal.proposal_id);
    if(!row)return;
    const work=JSON.parse(row.json as string) as WorkItem;
    updateJournalWork(db,{...work,state:proposal.state==='keep_existing'?'complete':proposal.state==='stale'?'deferred':'pending',payload:{...work.payload,proposal},reason:proposal.state,updated_at:at});
    if(proposal.state==='stale')for(const id of proposal.work_ids) {
        const linked=db.prepare('SELECT json FROM work WHERE id=?').get(id);if(!linked)continue;
        const item=JSON.parse(linked.json as string) as WorkItem;
        if(item.state!=='complete'&&item.payload.confirmation_proposal_id===proposal.proposal_id)updateJournalWork(db,{...item,state:'deferred',payload:{...item.payload,awaiting_user_confirmation:false},reason:'stale_confirmation; prepare current baseline and exact fact revisions again',updated_at:at});
    }
}
export function validateConfirmation(db:DatabaseSync,intent:FileIntent,currentDigest:string,at:string):JournalConfirmationGuard {
    const rows=db.prepare("SELECT json_extract(json,'$.payload.proposal') AS proposal FROM work WHERE kind='journal_confirmation' AND json_extract(json,'$.payload.proposal.operation_id')=? ORDER BY rowid DESC").all(intent.operation_id);
    if(!rows.length)return {schema_version:1,status:'not_required',proposal_id:null,work_ids:[],reason:null};
    const proposal=rows.map(row=>JSON.parse(row.proposal as string) as JournalConfirmationProposal).find(item=>item.baseline_digest===intent.baseline_digest&&item.desired_digest===intent.desired_digest&&canonical(item.fact_refs)===canonical(sortedRefs(intent.fact_refs)));
    if(!proposal)return {schema_version:1,status:'stale',proposal_id:null,work_ids:[],reason:'Intent differs from the exact confirmed proposal'};
    if(proposal.state==='keep_existing')return guard(proposal);
    if(currentDigest!==proposal.baseline_digest || !currentConfirmationRefs(db,proposal.fact_refs)) {setProposal(db,{...proposal,state:'stale'},at);return guard({...proposal,state:'stale'});}
    return guard(proposal);
}
export function decideConfirmation(db:DatabaseSync,decision:JournalUserDecision,currentDigest:string,at:string):JournalUserDecisionReceipt {
    version(decision);unique(decision.work_ids,'confirmation work IDs');
    if(decision.basis!=='explicit_user_response'||!['confirm','keep_existing'].includes(decision.decision)||!decision.decision_id?.trim()||!decision.reason?.trim())throw new Error('Confirmation requires a separate explicit user response');
    const key='journal-user-decision:'+decision.decision_id,old=db.prepare('SELECT value FROM metadata WHERE key=?').get(key) as {value:string}|undefined;
    if(old){const value=JSON.parse(old.value);if(canonical(value.decision)!==canonical(decision))throw new Error('Journal user decision identity conflict');const proposal=getConfirmation(db,decision.proposal_id);if(value.receipt.status==='confirmed'&&proposal&&(currentDigest!==proposal.baseline_digest||!currentConfirmationRefs(db,proposal.fact_refs)||proposal.state==='stale')){setProposal(db,{...proposal,state:'stale'},at);return {...value.receipt,status:'stale',reason:'Current baseline or exact fact revision changed; prepare a new proposal'};}return value.receipt;}
    if(!decision.response_source?.trim()||!decision.response_content?.trim()||Buffer.byteLength(decision.response_source)>1024||Buffer.byteLength(decision.response_content)>16384)throw new Error('New journal user decision requires bounded actual chat response_source and response_content');
    const proposal=getConfirmation(db,decision.proposal_id);if(!proposal)throw new Error('Unknown journal confirmation proposal');
    if(proposal.proposal_digest!==decision.proposal_digest || proposal.baseline_digest!==decision.baseline_digest || canonical(sortedRefs(decision.fact_refs))!==canonical(proposal.fact_refs)||canonical([...decision.work_ids].sort())!==canonical(proposal.work_ids))throw new Error('User decision does not match exact frozen proposal');
    let state:JournalUserDecisionReceipt['status']=decision.decision==='confirm'?'confirmed':'keep_existing';
    if(currentDigest!==proposal.baseline_digest||!currentConfirmationRefs(db,proposal.fact_refs)||proposal.state==='stale')state='stale';
    if(proposal.state==='keep_existing'&&state==='confirmed')throw new Error('Kept-existing proposal cannot be reopened');
    if(proposal.state!=='keep_existing')setProposal(db,{...proposal,state},at);
    if(state==='keep_existing') {
        for(const id of proposal.work_ids){const row=db.prepare('SELECT json FROM work WHERE id=?').get(id);if(!row)throw new Error('Confirmation work disappeared');const work=JSON.parse(row.json as string) as WorkItem;updateJournalWork(db,{...work,state:'complete',payload:{...work.payload,user_decision_id:decision.decision_id,user_decision:'keep_existing'},reason:decision.reason,updated_at:at});}
        db.prepare('INSERT OR IGNORE INTO operation_terminals VALUES(?,?,?,?)').run(proposal.operation_id,decision.decision_id,'Explicit user chose keep_existing',at);
    }
    const receipt:JournalUserDecisionReceipt={schema_version:1,decision_id:decision.decision_id,proposal_id:proposal.proposal_id,status:state,operation_id:proposal.operation_id,work_ids:proposal.work_ids,reason:state==='stale'?'Current baseline or exact fact revision changed; prepare a new proposal':null};
    db.prepare('INSERT INTO metadata VALUES(?,?)').run(key,canonical({decision,receipt}));return receipt;
}
