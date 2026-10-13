import type { DatabaseSync } from 'node:sqlite';
import type { MonthlySemanticStatus, MonthlySemanticDebt, FactMaterialProgress, MonthlyReviewResult } from '../contracts/types.ts';
import { normalized, utc } from './domain.ts';
/** Exact frozen refs and read marks, independent of all scheduling state. */
export function factMaterialProgress(db:DatabaseSync,snapshotId:string):FactMaterialProgress|null {
    const row=db.prepare("SELECT s.id AS snapshot_id,json_extract(s.json,'$.cutoff') AS cutoff,json_array_length(s.json,'$.refs') AS total,(SELECT COUNT(*) FROM json_each(s.json,'$.work_ids') frozen LEFT JOIN work w ON w.id=frozen.value WHERE w.id IS NULL OR w.state!='complete') AS pending_work_count,(SELECT COUNT(*) FROM json_each(s.json,'$.context_work_ids') frozen LEFT JOIN work w ON w.id=frozen.value WHERE w.id IS NULL OR w.state!='complete') AS pending_archive_context_count,MIN(CASE WHEN ref.key IS NOT NULL AND NOT EXISTS(SELECT 1 FROM fact_material_reads r WHERE r.snapshot_id=s.id AND r.fact_id=json_extract(ref.value,'$.fact_id') AND r.revision=json_extract(ref.value,'$.revision')) THEN CAST(ref.key AS INTEGER) END) AS first_unread_offset FROM fact_material_snapshots s LEFT JOIN json_each(s.json,'$.refs') ref ON 1=1 WHERE s.id=? GROUP BY s.id").get(snapshotId) as Omit<FactMaterialProgress,'schema_version'>|undefined;
    return row?{schema_version:1,...row}:null;
}
/** Source-free projection: only scheduling IDs, timestamps, reasons and ref positions. */
export function monthlySemanticStatus(db:DatabaseSync,cutoff:string,asOf:string,timezone:string):MonthlySemanticStatus {
    utc(cutoff);
    utc(asOf);
    const current=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit'}).format(new Date(asOf));
    const scope="kind IN ('prepare_monthly','month','archive_context') AND state='pending'";
    const month="COALESCE(json_extract(json,'$.payload.month'),json_extract(json,'$.payload.period'),'unknown')";
    const rows=db.prepare(`SELECT ${month} AS month,COUNT(*) AS pending_count,MIN(utc_key(json_extract(json,'$.updated_at'))) AS oldest_at FROM work WHERE ${scope} GROUP BY month ORDER BY month`).all() as {month:string;pending_count:number;oldest_at:string|null}[];
    const months:MonthlySemanticDebt[]=rows.map(row=> {
        const reasons=db.prepare(`SELECT DISTINCT CASE WHEN json_array_length(json,'$.payload.invalidated_fact_refs')>0 THEN 'Accepted monthly summary evidence corrected or retracted; semantic review remains pending' ELSE COALESCE(json_extract(json,'$.reason'),'Pending monthly semantic '||kind) END AS reason FROM work WHERE ${scope} AND ${month}=? ORDER BY reason LIMIT 32`).all(row.month).map((item:any)=>item.reason as string);
        const snapshot=db.prepare("SELECT s.id,json_extract(s.json,'$.cutoff') AS cutoff,json_array_length(s.json,'$.refs') AS total,MIN(CASE WHEN ref.key IS NOT NULL AND NOT EXISTS(SELECT 1 FROM fact_material_reads r WHERE r.snapshot_id=s.id AND r.fact_id=json_extract(ref.value,'$.fact_id') AND r.revision=json_extract(ref.value,'$.revision')) THEN CAST(ref.key AS INTEGER) END) AS unread FROM fact_material_snapshots s LEFT JOIN json_each(s.json,'$.refs') ref ON 1=1 WHERE json_extract(s.json,'$.kind')='monthly' AND json_extract(s.json,'$.period')=? AND utc_key(json_extract(s.json,'$.cutoff'))<=? AND (EXISTS(SELECT 1 FROM json_each(s.json,'$.refs') frozen WHERE NOT EXISTS(SELECT 1 FROM fact_material_reads r WHERE r.snapshot_id=s.id AND r.fact_id=json_extract(frozen.value,'$.fact_id') AND r.revision=json_extract(frozen.value,'$.revision'))) OR EXISTS(SELECT 1 FROM json_each(s.json,'$.work_ids') frozen WHERE NOT EXISTS(SELECT 1 FROM work w WHERE w.id=frozen.value AND w.state='complete')) OR EXISTS(SELECT 1 FROM json_each(s.json,'$.context_work_ids') frozen WHERE NOT EXISTS(SELECT 1 FROM work w WHERE w.id=frozen.value AND w.state='complete'))) GROUP BY s.id ORDER BY s.rowid DESC LIMIT 1").get(row.month,normalized(cutoff)) as {id:string;cutoff:string;total:number;unread:number|null}|undefined;
        return {schema_version:1,month:row.month,pending_count:row.pending_count,oldest_at:{schema_version:1,value:row.oldest_at,reason:row.oldest_at?null:'Pending monthly work has no measured update time'},reasons,eligible:/^\d{4}-(?:0[1-9]|1[0-2])$/.test(row.month)&&row.month<current&&row.oldest_at!==null&&row.oldest_at<=normalized(cutoff),continuation:snapshot?{schema_version:1,snapshot_id:snapshot.id,cutoff:snapshot.cutoff,offset:snapshot.unread??snapshot.total,next_offset:snapshot.unread,total:snapshot.total}:null};
    });
    return {schema_version:1,cutoff,pending_count:months.reduce((n,item)=>n+item.pending_count,0),oldest_month:months.filter(item=>item.eligible)[0]?.month ?? null,months};
}

/** SQL-only completion proof; expected prepared chunks, not merely the result's subset. */
export function monthlyChunksCompleteSql(bundleAlias:string,resultAlias:string):string {
    return `json_array_length(${bundleAlias}.json,'$.chunks')>0 AND json_type(${resultAlias}.json,'$.monthly_review')='object' AND NOT EXISTS(SELECT 1 FROM json_each(${bundleAlias}.json,'$.chunks') expected WHERE NOT EXISTS(SELECT 1 FROM json_each(${resultAlias}.json,'$.chunks') reviewed WHERE json_extract(reviewed.value,'$.chunk_id')=json_extract(expected.value,'$.chunk_id') AND json_extract(reviewed.value,'$.status')='complete'))`;
}
/** Stable fresh attempt only after an incomplete accepted monthly page. */
export function monthlyPreparationBundleId(db:DatabaseSync,baseId:string):string {
    const prefix=baseId+':retry:';
    const accepted=db.prepare(`SELECT r.bundle_id,CASE WHEN ${monthlyChunksCompleteSql('b','r')} THEN 1 ELSE 0 END AS complete FROM results r JOIN bundles b ON b.id=r.bundle_id WHERE b.kind='monthly' AND (r.bundle_id=? OR substr(r.bundle_id,1,?)=?) ORDER BY r.rowid DESC`).all(baseId,prefix.length,prefix) as {bundle_id:string;complete:number}[];
    if (!accepted.length) return baseId;
    if (accepted[0].complete) return accepted[0].bundle_id;
    return prefix+accepted.length;
}

/** Preserve original frozen order; missing IDs remain debt in progress, never fake complete. */
export function remainingFrozenWorkIds(db:DatabaseSync,ids:string[]):string[] {
    return db.prepare("SELECT frozen.value AS id FROM json_each(?) frozen JOIN work w ON w.id=frozen.value WHERE w.state!='complete' ORDER BY CAST(frozen.key AS INTEGER)").all(JSON.stringify(ids)).map((row:any)=>row.id as string);
}
function completeMonthlyArtifactQuery(projection:string):string {
    return `SELECT ${projection} FROM results r JOIN bundles b ON b.id=r.bundle_id JOIN outbox o ON o.id=json_extract(r.commit_json,'$.batch_id') WHERE b.kind='monthly' AND json_extract(b.json,'$.monthly_context.facts_page.snapshot_id')=? AND ${monthlyChunksCompleteSql('b','r')} AND json_type(o.json,'$.monthly_review')='object' ORDER BY r.rowid DESC LIMIT 1`;
}
export function hasCompleteMonthlyConclusion(db:DatabaseSync,snapshotId:string):boolean {
    return !!db.prepare(completeMonthlyArtifactQuery('1')).get(snapshotId);
}
/** Work acknowledgements cannot republish a conclusion superseded by another snapshot. */
export function assertCurrentMonthlyConclusion(db:DatabaseSync,snapshotId:string):void {
    const rows=db.prepare(`SELECT json_extract(b.json,'$.monthly_context.facts_page.snapshot_id') AS snapshot_id,a.ordinal FROM results r JOIN bundles b ON b.id=r.bundle_id JOIN outbox o ON o.id=json_extract(r.commit_json,'$.batch_id') LEFT JOIN publication_acceptance_order a ON a.batch_id=o.id WHERE b.kind='monthly' AND json_extract(b.json,'$.monthly_context.month')=(SELECT json_extract(s.json,'$.period') FROM fact_material_snapshots s WHERE s.id=?) AND ${monthlyChunksCompleteSql('b','r')} AND json_type(o.json,'$.monthly_review')='object' ORDER BY a.ordinal DESC`).all(snapshotId) as {snapshot_id:string|null;ordinal:number|null}[];
    if (!rows.length || rows.some(row=>row.ordinal===null) || rows[0].snapshot_id!==snapshotId)
        throw new Error('Work-only monthly conclusion superseded or acceptance-order proof unavailable; frozen work remains pending');
}
/** Project only accepted aggregate conclusions, never source/material/fact bodies. */
export function completeMonthlyConclusion(db:DatabaseSync,snapshotId:string):MonthlyReviewResult|null {
    const row=db.prepare(completeMonthlyArtifactQuery("json_extract(o.json,'$.monthly_review') AS json")).get(snapshotId) as {json:string}|undefined;
    return row?JSON.parse(row.json):null;
}
