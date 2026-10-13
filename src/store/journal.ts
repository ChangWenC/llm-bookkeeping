import type { DatabaseSync } from 'node:sqlite';
import type { BookkeepingConfig, FactRevision, FactRef, JournalPatch, ReviewBundle, ReviewResult, WorkItem, JournalPublicationPayload, JournalDisposition, JournalWorkBundle, JournalResolution, JournalResolutionCommit, FileOutcome } from '../contracts/types.ts';
import {strongJournalAssessment} from './journal-assessment.ts';
import { canonical, digest } from '../analytics/serialization.ts';
import { refKey, version, utc, unique } from './domain.ts';

type EvidenceDisposition = JournalDisposition & { evidence_text?: string };
const parse = <T>(row: any): T => JSON.parse(row.json);
export const journalPayload = (item: WorkItem): JournalPublicationPayload => item.payload as unknown as JournalPublicationPayload;
export function journalWorkId(ref: FactRef, date: string, path: string): string { return 'journal-publication:' + digest(canonical([refKey(ref), date, path])); }
export function canonicalJournalPath(db: DatabaseSync, date: string, cutoff: string, timezone: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return '';
    const daily = `wiki/personal/journals/日记_${date.replaceAll('-', '_')}.md`;
    const current = new Intl.DateTimeFormat('en-CA', {timeZone:timezone,year:'numeric',month:'2-digit'}).format(new Date(cutoff));
    const previous = new Date(current + '-01T12:00:00Z'); previous.setUTCMonth(previous.getUTCMonth()-1);
    const archived = db.prepare("SELECT 1 FROM work WHERE kind='archive' AND json_extract(json,'$.payload.date')=? LIMIT 1").get(date)
        || db.prepare("SELECT 1 FROM intents WHERE state='applied' AND json_extract(json,'$.path')=? AND json_extract(json,'$.desired_bytes_base64') IS NULL LIMIT 1").get(daily);
    return archived || date.slice(0,7) < previous.toISOString().slice(0,7) ? `wiki/personal/journals/reviews/回顾_${date.slice(0,7).replace('-', '_')}.md` : daily;
}
export function updateJournalWork(db: DatabaseSync, item: WorkItem): void {
    db.prepare('UPDATE work SET json=?,state=? WHERE id=?').run(canonical(item),item.state,item.work_id);
}
/** Called while holding the Wiki writer lock, after every exact linked debt is closed. */
export function terminalizeJournalOperation(db:DatabaseSync,id:string,auditRef:string,reason:string,at:string):void {
    if(db.prepare("SELECT 1 FROM work WHERE kind='journal_publication' AND state!='complete' AND json_extract(json,'$.payload.operation_id')=? LIMIT 1").get(id)) return;
    const patch=db.prepare('SELECT status FROM patches WHERE id=?').get(id) as any,intent=db.prepare('SELECT state,json FROM intents WHERE id=?').get(id) as any;
    if(!['pending','conflict'].includes(patch?.status) && !['prepared','pending','conflict'].includes(intent?.state)) return;
    db.prepare('INSERT OR IGNORE INTO operation_terminals VALUES(?,?,?,?)').run(id,auditRef,reason,at);
    if(['pending','conflict'].includes(patch?.status)) db.prepare("UPDATE patches SET status='superseded',reason=? WHERE id=?").run(reason,id);
    if(['prepared','pending','conflict'].includes(intent?.state)) db.prepare("UPDATE intents SET state='superseded',json=? WHERE id=?").run(canonical({...JSON.parse(intent.json),state:'superseded',reason}),id);
}
/** Exact bytes are checked mechanically; consistency remains the reviewer's semantic declaration. */
export function journalBaselineAssessmentValid(disposition: {disposition?:string;baseline_assessment?: import('../contracts/types.ts').JournalBaselineAssessment}, baseline: {content:string|null;digest:string;excerpt?:boolean}|undefined):boolean {
    if(!strongJournalAssessment(disposition.baseline_assessment,baseline))return false;
    // N/A witnesses support intentional omission, never a declaration of representation.
    return disposition.disposition==='not_needed'||!!disposition.baseline_assessment?.body_evidence?.some(item=>item.dimensions.action==='consistent'||item.dimensions.result==='consistent');
}
export function validateJournalDecision(disposition: {disposition:string;reason:string|null;evidence_text?:string}, baseline: {content:string|null} | undefined): void {
    if (!['patch','already_present','not_needed','defer'].includes(disposition.disposition)) throw new Error('Invalid journal disposition');
    if (disposition.disposition !== 'patch' && !disposition.reason?.trim()) throw new Error('Journal disposition requires explicit reason');

}
/** Exact accepted revision debt, independent of source completion and fact export. */
export function queueAcceptedJournalWork(db: DatabaseSync, bundle: ReviewBundle, result: ReviewResult, facts: FactRevision[], patches: JournalPatch[], refs: Map<string,FactRef[]>, putWork: (item: WorkItem)=>void, timezone: string, currentPresentPaths?:Set<string>,wikiLockHeld=false): string[] {
    const decisions = (result.journal_dispositions ?? []) as EvidenceDisposition[];
    unique(decisions.map(d => canonical([d.candidate_id,d.date,d.path])), 'journal dispositions');
    for (const decision of decisions) {
        version(decision);
        if (!result.candidates.some(c=>c.candidate_id===decision.candidate_id)) throw new Error('Journal disposition references unknown candidate');
        validateJournalDecision(decision, bundle.baselines.find(b=>b.path===decision.path));
        if (decision.disposition === 'patch' && !result.pages.some(p=>p.suggestion_id===decision.suggestion_id && p.date===decision.date && p.path===decision.path && p.candidate_ids.includes(decision.candidate_id))) throw new Error('Journal disposition requires a matching supplied page suggestion');
        if (decision.disposition !== 'patch' && result.pages.some(p=>p.date===decision.date && p.path===decision.path && p.candidate_ids.includes(decision.candidate_id))) throw new Error('Non-patch journal decision contradicts a supplied patch');
    }
    const ids: string[] = [], consumed = new Set<EvidenceDisposition>();
    const subjects=facts.map(fact=>({fact,candidateId:[...refs].find(([,items])=>items.some(r=>refKey(r)===refKey(fact)))?.[0]}));
    for(const candidate of result.candidates.filter(c=>c.disposition==='keep')) for(const ref of refs.get(candidate.candidate_id) ?? []) {
        const row=db.prepare('SELECT json FROM facts WHERE id=? AND revision=?').get(ref.fact_id,ref.revision);
        if(row) subjects.push({fact:parse<FactRevision>(row),candidateId:candidate.candidate_id});
    }
    const terminals=new Set<string>();
    for (const {fact,candidateId} of subjects) {
        const affected = [fact, ...fact.target_refs.flatMap(ref=> {
            const row=db.prepare('SELECT json FROM facts WHERE id=? AND revision=?').get(ref.fact_id,ref.revision); return row ? [parse<FactRevision>(row)] : [];
        })];
        const dates=[...new Set(affected.map(f=>f.journal_date.value ?? ''))];
        for (const date of dates) {
            const path=canonicalJournalPath(db,date,bundle.cutoff,timezone), ref: FactRef={schema_version:1,fact_id:fact.fact_id,revision:fact.revision};
            const decision=decisions.find(d=>d.candidate_id===candidateId && d.date===date && d.path===path);
            if(decision) consumed.add(decision);
            const patch=patches.find(p=>p.date===date && p.path===path && p.fact_refs.some(r=>refKey(r)===refKey(ref)) && (!decision?.suggestion_id || result.pages.find(page=>page.suggestion_id===decision.suggestion_id)?.path===p.path));
            const payload: JournalPublicationPayload={schema_version:1,fact_ref:ref,date,path,target_refs:fact.target_refs,...(patch?{operation_id:patch.operation_id}:{}),...(decision?{disposition:decision.disposition,baseline_assessment:decision.baseline_assessment??null,assessment_policy:'whole_blocks_v1'}:patch?{disposition:'patch' as const}:{})};
            const work_id=journalWorkId(ref,date,path);
            const stalePresent=['already_present','not_needed'].includes(decision?.disposition??'') && currentPresentPaths!==undefined && !currentPresentPaths.has(path);
            const assessmentHeld=['already_present','not_needed'].includes(decision?.disposition??'')&&(!journalBaselineAssessmentValid(decision??{},bundle.baselines.find(page=>page.path===path))||decision?.disposition==='already_present'&&(!decision.evidence_text?.trim()||decision.evidence_text!==decision.baseline_assessment?.body_evidence_text));
            const correctionHeld=(fact.action!=='assert'||decision?.baseline_assessment?.relation==='correction')&&['already_present','not_needed'].includes(decision?.disposition??'');
            const state= !date || !path || stalePresent || correctionHeld || assessmentHeld || decision?.disposition==='defer' ? 'deferred' : ['already_present','not_needed'].includes(decision?.disposition ?? '') ? 'complete' : 'pending';
            const item:WorkItem={schema_version:1,work_id,kind:'journal_publication',lane:bundle.lane,state,payload:payload as unknown as Record<string,unknown>,reason:!date || !path?'Accepted fact target date/path is unresolved':correctionHeld?'Known semantic correction requires full current summary/body assessment and explicit journal confirmation; a matching substring cannot close it':assessmentHeld?'Full frozen baseline, complete summary and body consistency assessment is missing or unresolved':stalePresent?'Current page changed or writer lock unavailable; baseline evidence requires revalidation':decision?.reason ?? (patch? 'Awaiting verified file publication':'Accepted fact target lacks a journal disposition'),migration_key:null,updated_at:result.created_at};
            const old=db.prepare('SELECT json FROM work WHERE id=?').get(work_id);
            if (!old) putWork(item);
            else if(decision || patch) {
                const previous=parse<WorkItem>(old),oldPayload=journalPayload(previous);
                if(previous.payload.awaiting_user_confirmation===true && decision && ['already_present','not_needed'].includes(decision.disposition)) {
                    updateJournalWork(db,{...previous,state:'deferred',reason:'awaiting_user_confirmation; automatic journal disposition cannot approve or dismiss the proposal',updated_at:result.created_at});
                    ids.push(work_id);continue;
                }
                // Newly allocated source-review patches have never been visible to a writer.
                // Keep cannot make a second operation for an already completed/unfinished exact target.
                if(patch && (previous.state==='complete' || (oldPayload.operation_id && oldPayload.operation_id!==patch.operation_id))) {
                    const reason=previous.state==='complete'?'Exact accepted revision target is already complete':'Existing exact journal operation requires file-only continuation';
                    db.prepare('INSERT INTO operation_terminals VALUES(?,?,?,?)').run(patch.operation_id,result.result_id,reason,result.created_at);
                    db.prepare("UPDATE patches SET status='superseded',reason=? WHERE id=?").run(reason,patch.operation_id);
                    if(previous.state!=='complete') updateJournalWork(db,{...previous,state:'deferred',reason,updated_at:result.created_at});
                    ids.push(work_id);continue;
                }
                if(previous.state==='complete') {ids.push(work_id);continue;}
                const knownConflict=oldPayload.operation_id && (db.prepare("SELECT 1 FROM patches WHERE id=? AND status='conflict'").get(oldPayload.operation_id)||db.prepare("SELECT 1 FROM intents WHERE id=? AND state='conflict'").get(oldPayload.operation_id));
                if(knownConflict&&['already_present','not_needed'].includes(decision?.disposition??'')){updateJournalWork(db,{...previous,state:'deferred',reason:'Known journal conflict requires explicit confirmation; baseline assessment cannot approve it',updated_at:result.created_at});ids.push(work_id);continue;}
                const closing=['already_present','not_needed'].includes(decision?.disposition ?? '') && item.state==='complete';
                const needsLock=closing && oldPayload.operation_id && (db.prepare("SELECT 1 FROM patches WHERE id=? AND status IN ('pending','conflict')").get(oldPayload.operation_id) || db.prepare("SELECT 1 FROM intents WHERE id=? AND state IN ('prepared','pending','conflict')").get(oldPayload.operation_id));
                updateJournalWork(db,{...previous,state:needsLock&&!wikiLockHeld?'deferred':item.state,payload:{...previous.payload,...(decision?{disposition:decision.disposition,baseline_assessment:decision.baseline_assessment??null,assessment_policy:'whole_blocks_v1'}:{}),...(patch?{operation_id:patch.operation_id}:{})},reason:needsLock&&!wikiLockHeld?'Journal decision awaits the shared Wiki lock':item.reason,updated_at:result.created_at});
                if(closing && oldPayload.operation_id && wikiLockHeld) terminals.add(oldPayload.operation_id);
            }
            ids.push(work_id);
        }
    }
    if (decisions.some(d=>refs.has(d.candidate_id)&&!consumed.has(d))) throw new Error('Journal disposition target does not match an accepted fact target');
    for(const id of terminals) terminalizeJournalOperation(db,id,result.result_id,'Exact journal decision completed every linked debt',result.created_at);
    return ids;
}
export function journalConflicts(db: DatabaseSync): FileOutcome[] {
    const values = new Map<string,FileOutcome>();
    for (const row of db.prepare("SELECT id,json,reason FROM patches WHERE status='conflict' AND NOT EXISTS(SELECT 1 FROM operation_supersessions s WHERE s.original_id=patches.id) ORDER BY rowid").all() as any[]) {
        const patch=parse<JournalPatch>(row); values.set(row.id,{schema_version:1,operation_id:row.id,path:patch.path,status:'conflict',reason:row.reason});
    }
    for (const row of db.prepare("SELECT id,json FROM intents WHERE state='conflict' AND NOT EXISTS(SELECT 1 FROM operation_supersessions s WHERE s.original_id=intents.id) ORDER BY rowid").all() as any[]) {
        const intent=JSON.parse(row.json); values.set(row.id,{schema_version:1,operation_id:row.id,path:intent.path,status:'conflict',reason:intent.reason});
    }
    return [...values.values()];
}
export function supersedeOperation(db: DatabaseSync, original: string, replacement: string, path: string, at: string): void {
    if(db.prepare('SELECT 1 FROM operation_terminals WHERE original_id=?').get(original)) throw new Error('Original operation is terminally resolved');
    if (original===replacement) throw new Error('Operation cannot supersede itself');
    const existing=db.prepare('SELECT replacement_id FROM operation_supersessions WHERE original_id=?').get(original) as any;
    if (existing) { if(existing.replacement_id!==replacement) throw new Error('Automatic replacement already allocated for original operation'); return; }
    if (db.prepare('SELECT 1 FROM operation_supersessions WHERE replacement_id=?').get(original)) throw new Error('Automatic replacement cannot itself be replaced automatically');
    const patch=db.prepare('SELECT json,status FROM patches WHERE id=?').get(original) as any;
    const intent=db.prepare('SELECT json,state FROM intents WHERE id=?').get(original) as any;
    if (!patch && !intent) throw new Error('Unknown superseded operation');
    if ((patch && (JSON.parse(patch.json).path!==path || !['pending','conflict'].includes(patch.status))) || (intent && (JSON.parse(intent.json).path!==path || !['pending','prepared','conflict'].includes(intent.state)))) throw new Error('Only unfinished same-target operations can be superseded');
    db.prepare('INSERT INTO operation_supersessions VALUES(?,?,?)').run(original,replacement,at);
    if (patch) db.prepare("UPDATE patches SET status='superseded',reason=? WHERE id=?").run('Superseded by '+replacement,original);
    if (intent) db.prepare("UPDATE intents SET state='superseded',json=? WHERE id=?").run(canonical({...JSON.parse(intent.json),state:'superseded',reason:'Superseded by '+replacement}),original);
}
export interface JournalResolutionStore {
    db: DatabaseSync; config?: BookkeepingConfig; transaction<T>(fn:()=>T):T;
    effective():FactRevision[]; allocateId(namespace:string):string;
    wikiLockHeld?:boolean;
}
export function commitJournalResolution(store: JournalResolutionStore, resolution: JournalResolution): JournalResolutionCommit {
    version(resolution); utc(resolution.created_at);
    if(!resolution.resolution_id?.trim()) throw new Error('Missing journal resolution identity');
    return store.transaction(()=>{
        const old=store.db.prepare('SELECT json,commit_json FROM journal_resolutions WHERE id=? OR bundle_id=?').get(resolution.resolution_id,resolution.journal_bundle_id) as any;
        if(old) { if(old.json!==canonical(resolution)) throw new Error('Journal resolution identity conflict'); return {...JSON.parse(old.commit_json),reused:true}; }
        const row=store.db.prepare('SELECT json FROM journal_bundles WHERE id=?').get(resolution.journal_bundle_id);
        if(!row) throw new Error('Unknown journal work bundle');
        const bundle=parse<JournalWorkBundle>(row);
        unique(resolution.dispositions.map(d=>d.work_id),'journal resolution work'); unique(resolution.pages.map(p=>p.suggestion_id),'journal resolution pages');
        const works=new Map(bundle.work.map(item=>[item.work_id,item]));
        const active=new Set(store.effective().map(refKey));
        const latest=(ref:FactRef)=> (store.db.prepare('SELECT MAX(revision) AS revision FROM facts WHERE id=?').get(ref.fact_id) as any)?.revision===ref.revision;
        const current=new Map<string,WorkItem>();
        const assessmentDeferred=new Map<string,string>();
        for(const decision of resolution.dispositions) {
            version(decision);
            const frozen=works.get(decision.work_id),now=store.db.prepare('SELECT json FROM work WHERE id=?').get(decision.work_id);
            if(!frozen || !now) throw new Error('Journal disposition outside frozen work');
            const item=parse<WorkItem>(now),payload=journalPayload(item),fact=bundle.facts.find(f=>refKey(f)===refKey(payload.fact_ref));
            if(item.payload.awaiting_user_confirmation===true && decision.disposition!=='defer')throw new Error('Journal work awaits explicit user confirmation; automatic resolution cannot approve or dismiss it');
            if(item.state==='complete' || canonical(item)!==canonical(frozen)) throw new Error('Journal work changed; prepare again');
            // A retract is intentionally absent from the effective view, but must still be the current immutable revision.
            const currentFact=!!fact && latest(payload.fact_ref) && (fact.action==='retract' || active.has(refKey(fact)));
            if(currentFact&&(fact!.action!=='assert'||decision.baseline_assessment?.relation==='correction')&&['already_present','not_needed'].includes(decision.disposition))assessmentDeferred.set(item.work_id,'Known semantic correction requires explicit confirmation; matching baseline substring is insufficient');
            const related=new Set(fact?[refKey(fact)]:[]);
            let changed=true;
            while(changed) {changed=false;for(const next of bundle.existing_facts) if(!related.has(refKey(next)) && next.target_refs.some(ref=>related.has(refKey(ref)))) {related.add(refKey(next));changed=true;}}
            const retirementEvidence=fact && bundle.existing_facts.some(next=>related.has(refKey(next)) && refKey(next)!==refKey(fact) && (active.has(refKey(next)) || (next.action==='retract' && latest(next))));
            if(!fact || (!currentFact && !(decision.disposition==='not_needed' && retirementEvidence)) || payload.target_refs.some(ref=>!bundle.existing_facts.some(f=>refKey(f)===refKey(ref)))) throw new Error('Stale journal fact/target revision; prepare again');
            validateJournalDecision(decision,bundle.baselines.find(b=>b.path===payload.path));
            if(currentFact&&['already_present','not_needed'].includes(decision.disposition)) {
                if(!journalBaselineAssessmentValid(decision,bundle.baselines.find(b=>b.path===payload.path))||decision.disposition==='already_present'&&(!decision.evidence_text?.trim()||decision.evidence_text!==decision.baseline_assessment?.body_evidence_text))assessmentDeferred.set(item.work_id,'Journal completion requires full frozen baseline, complete summary and consistent whole body block assessment');

            }
            if(['already_present','not_needed'].includes(decision.disposition)&&payload.operation_id&&(store.db.prepare("SELECT 1 FROM patches WHERE id=? AND status='conflict'").get(payload.operation_id)||store.db.prepare("SELECT 1 FROM intents WHERE id=? AND state='conflict'").get(payload.operation_id)))assessmentDeferred.set(item.work_id,'Known journal conflict requires explicit user confirmation');
            if(decision.disposition==='patch' && !resolution.pages.some(p=>p.suggestion_id===decision.suggestion_id && p.work_ids.includes(item.work_id))) throw new Error('Journal patch decision requires a supplied suggestion');
            current.set(item.work_id,item);
        }
        const patches:JournalPatch[]=[];
        const deferred=new Map<string,string>(assessmentDeferred);
        for(const page of resolution.pages) {
            version(page); unique(page.work_ids,'journal page work');
            if(!page.work_ids.length || page.work_ids.some(id=>!current.has(id) || !resolution.dispositions.some(d=>d.work_id===id && d.disposition==='patch' && d.suggestion_id===page.suggestion_id))) throw new Error('Journal page has missing or unrelated work decision');
            const baseline=bundle.baselines.find(b=>b.path===page.path);
            if(!baseline || baseline.digest!==page.baseline_digest || page.work_ids.some(id=>{const payload=journalPayload(current.get(id)!);return payload.date!==page.date || payload.path!==page.path;})) throw new Error('Journal page differs from precise frozen target/baseline');
            if(!['append','replace'].includes(page.mode) || typeof page.new_text!=='string' || (page.mode==='replace' && (!page.old_text || !baseline.content?.includes(page.old_text)))) throw new Error('Journal replacement must be visible in frozen baseline');
            if(!page.supersedes_operation_id && page.work_ids.some(id=>journalPayload(current.get(id)!).operation_id)) throw new Error('Existing unfinished journal operation requires explicit supersedes_operation_id');
            if(page.supersedes_operation_id && page.work_ids.some(id=>journalPayload(current.get(id)!).operation_id!==page.supersedes_operation_id)) throw new Error('Replacement must supersede the selected work operation');
            if(page.supersedes_operation_id) {
                if(store.db.prepare('SELECT 1 FROM operation_supersessions WHERE original_id=? OR replacement_id=?').get(page.supersedes_operation_id,page.supersedes_operation_id)) {
                    for(const id of page.work_ids) deferred.set(id,'One automatic replacement is exhausted; manual journal resolution remains deferred');
                    continue;
                }
                const linked=store.db.prepare("SELECT id FROM work WHERE kind='journal_publication' AND state!='complete' AND json_extract(json,'$.payload.operation_id')=?").all(page.supersedes_operation_id) as any[];
                if(linked.some(item=>!page.work_ids.includes(item.id))) throw new Error('Replacement must include every unfinished exact debt linked to the original operation');
            }
            const patch:JournalPatch={schema_version:1,operation_id:store.allocateId('operation'),date:page.date,path:page.path,baseline_digest:page.baseline_digest,mode:page.mode,old_text:page.old_text,new_text:page.new_text,fact_refs:[...new Map(page.work_ids.map(id=>{const ref=journalPayload(current.get(id)!).fact_ref;return [refKey(ref),ref] as const;})).values()],...(page.supersedes_operation_id?{supersedes_operation_id:page.supersedes_operation_id}:{})};
            if(page.supersedes_operation_id) { if(!store.wikiLockHeld) throw new Error('Journal supersession requires the shared Wiki writer lock'); supersedeOperation(store.db,page.supersedes_operation_id,patch.operation_id,patch.path,resolution.created_at); }
            store.db.prepare('INSERT INTO patches VALUES(?,?,?,NULL)').run(patch.operation_id,canonical(patch),'pending'); patches.push(patch);
            for(const id of page.work_ids) { const item=current.get(id)!; current.set(id,{...item,payload:{...item.payload,operation_id:patch.operation_id,disposition:'patch'}}); }
        }
        for(const decision of resolution.dispositions) {
            const item=current.get(decision.work_id)!;
            updateJournalWork(store.db,{...item,state:deferred.has(item.work_id)||decision.disposition==='defer'?'deferred':decision.disposition==='patch'?'pending':'complete',payload:{...item.payload,disposition:deferred.has(item.work_id)?'defer':decision.disposition,baseline_assessment:decision.baseline_assessment??null,assessment_policy:'whole_blocks_v1'},reason:deferred.get(item.work_id) ?? decision.reason,updated_at:resolution.created_at});
        }
        for(const item of current.values()) {
            const payload=journalPayload(item),decision=resolution.dispositions.find(d=>d.work_id===item.work_id);
            if(!deferred.has(item.work_id) && payload.operation_id && ['already_present','not_needed'].includes(decision?.disposition ?? '')) {
                if(!store.wikiLockHeld) throw new Error('Journal terminal decision requires the shared Wiki writer lock');
                terminalizeJournalOperation(store.db,payload.operation_id,resolution.resolution_id,'Exact journal resolution completed every linked debt',resolution.created_at);
            }
        }
        const commit:JournalResolutionCommit={schema_version:1,resolution_id:resolution.resolution_id,reused:false,patches,work_ids:resolution.dispositions.map(d=>d.work_id)};
        store.db.prepare('INSERT INTO journal_resolutions VALUES(?,?,?,?)').run(resolution.resolution_id,resolution.journal_bundle_id,canonical(resolution),canonical(commit));
        return commit;
    });
}
