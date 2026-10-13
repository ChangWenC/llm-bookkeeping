import type {DatabaseSync} from 'node:sqlite';
import type {JournalReassessmentRequest,JournalReassessmentReceipt,WorkItem} from '../contracts/types.ts';
import {canonical,digest} from '../analytics/serialization.ts';
import {utc,version,unique} from './domain.ts';
export function reassessmentPlan(db:DatabaseSync,request:JournalReassessmentRequest,targetDigests:Map<string,string>):{receipt:JournalReassessmentReceipt;selected:WorkItem[]} {
 version(request);utc(request.created_at);if(!['preview','apply'].includes(request.mode)||!Array.isArray(request.work_ids)||request.work_ids.length<1||request.work_ids.length>100||request.work_ids.some(id=>typeof id!=='string'||!id.trim()))throw new Error('Reassessment requires 1–100 exact selected work IDs');unique(request.work_ids,'reassessment work IDs');
 const selected:WorkItem[]=[],proof:unknown[]=[];
 const items=[...request.work_ids].sort().map(id=>{const row=db.prepare('SELECT json FROM work WHERE id=?').get(id) as {json:string}|undefined;const work=row?JSON.parse(row.json) as WorkItem:null;
  const ref=work?.payload.fact_ref as {fact_id:string;revision:number}|undefined,fact=ref?db.prepare('SELECT json FROM facts WHERE id=? AND revision=?').get(ref.fact_id,ref.revision) as {json:string}|undefined:undefined;
  const current=ref&&!!db.prepare('SELECT 1 FROM facts f WHERE id=? AND revision=? AND NOT EXISTS(SELECT 1 FROM facts later WHERE later.id=f.id AND later.revision>f.revision) AND NOT EXISTS(SELECT 1 FROM fact_targets t WHERE t.target_id=f.id AND t.target_revision>=f.revision)').get(ref.fact_id,ref.revision);
  const path=typeof work?.payload.path==='string'?work.payload.path:'';
  const eligible=!!work&&work.kind==='journal_publication'&&work.state==='complete'&&['already_present','not_needed'].includes(String(work.payload.disposition))&&work.payload.assessment_policy!=='whole_blocks_v1'&&!work.payload.user_decision_id&&!!fact&&!!current&&targetDigests.has(path);
  const reason=eligible?'Closed journal work lacks versioned whole-block assessment; fresh bounded reassessment is required':!work?'Selected work missing':work.state!=='complete'?'Only selected closed debt can be reopened':work.payload.user_decision_id?'Explicit accepted user decision remains unchanged':work.payload.assessment_policy==='whole_blocks_v1'?'Strong assessment already recorded':!current?'Old accepted fact revision is stale; preserve its record':'No eligible weak current journal assessment or target unavailable';
  proof.push({work_id:id,work_digest:row?digest(row.json):null,fact_digest:fact?digest(fact.json):null,current:!!current,target_digest:targetDigests.get(path)??null,eligible});if(eligible)selected.push(work!);return {schema_version:1 as const,work_id:id,eligible,reason};
 });
 return {receipt:{schema_version:1,plan_digest:digest(canonical({schema_version:1,policy:'journal_reassessment_v1',proof})),items,reopened_work_ids:[]},selected};
}
export function applyReassessment(db:DatabaseSync,request:JournalReassessmentRequest,plan:ReturnType<typeof reassessmentPlan>,putWork:(work:WorkItem)=>void):JournalReassessmentReceipt {
 if(request.expected_plan_digest!==plan.receipt.plan_digest)throw new Error('Journal reassessment plan changed; preview again');
 const key='journal-reassessment:'+plan.receipt.plan_digest,prior=db.prepare('SELECT value FROM metadata WHERE key=?').get(key) as {value:string}|undefined;if(prior)return JSON.parse(prior.value);
 const ids:string[]=[];for(const old of plan.selected){const {operation_id:previousOperation,...oldPayload}=old.payload;const id='journal-reassessment-work:'+digest(canonical([plan.receipt.plan_digest,old.work_id]));putWork({...old,work_id:id,state:'pending',payload:{...oldPayload,...(previousOperation?{previous_operation_id:previousOperation}:{}),disposition:'defer',baseline_assessment:null,assessment_policy:'whole_blocks_v1',previous_work_id:old.work_id,previous_disposition:old.payload.disposition,reassessment_plan_digest:plan.receipt.plan_digest},reason:'Fresh whole-block summary/body semantic reassessment of previously closed work',updated_at:request.created_at,migration_key:null});ids.push(id);}
 const receipt={...plan.receipt,reopened_work_ids:ids};db.prepare('INSERT INTO metadata VALUES(?,?)').run(key,canonical(receipt));return receipt;
}
