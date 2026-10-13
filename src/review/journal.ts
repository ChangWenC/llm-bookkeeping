import type {BookkeepingConfig, JournalWorkRequest, JournalWorkBundle, FactRef} from '../contracts/types.ts';
import type {SqliteStore} from '../store/index.ts';
import {canonical,digest} from '../analytics/serialization.ts';
import {utc,version,unique,refKey} from '../store/domain.ts';
import {journalPayload} from '../store/journal.ts';
import {readPageBaseline} from './baselines.ts';

export async function prepareJournalWork(store:SqliteStore,config:BookkeepingConfig,request:JournalWorkRequest):Promise<JournalWorkBundle> {
    version(request);utc(request.cutoff);
    const max=request.max_items ?? Math.min(32,config.limits.chunk_events);
    if(!Number.isSafeInteger(max)||max<1||max>config.limits.chunk_events*config.limits.bundles_per_round) throw new Error('Invalid bounded journal max_items');
    if(request.work_ids) { unique(request.work_ids,'journal work selection'); if(request.work_ids.length>max) throw new Error('Journal work selection exceeds max_items'); }
    const rows=store.db.prepare("SELECT json FROM work WHERE kind='journal_publication' AND state!='complete'"+(request.work_ids ? ' AND id IN (SELECT value FROM json_each(?))':" AND COALESCE(json_extract(json,'$.payload.awaiting_user_confirmation'),0)!=1")+' ORDER BY rowid LIMIT ?').all(...(request.work_ids?[canonical(request.work_ids)]:[]),max);
    const selected=rows.map(row=>JSON.parse(row.json as string));
    if(request.work_ids && selected.length!==request.work_ids.length) throw new Error('Unknown or completed journal work selection');
    const bundle:JournalWorkBundle={schema_version:1,journal_bundle_id:'',cutoff:request.cutoff,work:[],facts:[],existing_facts:[],baselines:[],conflicts:[]};
    const conflicts=await store.listJournalConflicts();
    for(const work of selected) {
        const payload=journalPayload(work);
        const fact=store.lookupFactRevisions([payload.fact_ref]);
        if(!fact.length) throw new Error('Journal debt references missing immutable fact');
        const targets=[...store.lookupFactRevisions(payload.target_refs),...store.journalRetirementFacts(payload.fact_ref)];
        let baseline;
        if(payload.path && !bundle.baselines.some(b=>b.path===payload.path)) baseline=await readPageBaseline(config,payload.path,Math.max(64,Math.floor(config.limits.bundle_bytes/4)));
        const uniqueFacts=(values:typeof fact)=>[...new Map(values.map(value=>[refKey(value),value])).values()];
        const proposed:JournalWorkBundle={...bundle,work:[...bundle.work,work],facts:uniqueFacts([...bundle.facts,...fact]),existing_facts:uniqueFacts([...bundle.existing_facts,...targets]),baselines:baseline?[...bundle.baselines,baseline]:bundle.baselines,conflicts:[...bundle.conflicts,...conflicts.filter(c=>c.operation_id===payload.operation_id && !bundle.conflicts.some(old=>old.operation_id===c.operation_id))]};
        if(Buffer.byteLength(canonical(proposed))+100>config.limits.bundle_bytes) { if(!bundle.work.length || request.work_ids) throw new Error('Selected journal work exceeds bounded material; increase bundle_bytes or select fewer IDs'); break; }
        Object.assign(bundle,proposed);
    }
    bundle.journal_bundle_id='journal-bundle:'+digest(canonical({...bundle,journal_bundle_id:null}));
    const previous=store.db.prepare('SELECT json FROM journal_bundles WHERE id=?').get(bundle.journal_bundle_id);
    if(previous && previous.json!==canonical(bundle)) throw new Error('Journal bundle identity conflict');
    store.db.prepare('INSERT OR IGNORE INTO journal_bundles VALUES(?,?)').run(bundle.journal_bundle_id,canonical(bundle));
    return bundle;
}
