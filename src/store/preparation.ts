import type { DatabaseSync } from 'node:sqlite';
import type { PreparationContinuation, PreparationScope, DeferredReviewUnit, ReviewUnit,FactRef,PageBaseline,PreparationPhase,CoverageGap } from '../contracts/types.ts';
import { canonical, digest } from '../analytics/serialization.ts';
export interface EventPosition { time:string; ordering:string; id:string }
export interface CandidateCursor { after:EventPosition|null; deferred:DeferredReviewUnit[]; skip_units:ReviewUnit[]; pending?:{
  positions:EventPosition[]; event_ids:string[]; exhausted:boolean; phase:PreparationPhase;
  fact_refs?:FactRef[]; facts_omitted?:boolean; coverage_ids?:string[];
  journal_paths?:Record<string,string>; gap_results?:Record<string,CoverageGap[]>; contexts?:Record<string,string[]>; baselines?:PageBaseline[]; bundle_ids?:string[];
} }
const invalid=(message:string) => Object.assign(new Error(message),{code:'BOOKKEEPING_PREPARATION_CURSOR_INVALID'});
/** Cursor rows contain scalar identities and byte ranges only, never source material. */
export function loadPreparationCursor(db:DatabaseSync, continuation:PreparationContinuation|undefined, scope:PreparationScope, configDigest:string, skipUnits:ReviewUnit[]=[]):CandidateCursor {
    if (!continuation) return {after:null,deferred:[],skip_units:skipUnits};
    if (continuation.schema_version !== 1 || canonical(continuation.scope) !== canonical(scope) || typeof continuation.cursor !== 'string') throw invalid('Preparation continuation scope mismatch');
    const row=db.prepare('SELECT json FROM preparation_cursors WHERE id=? AND scope_digest=?').get(continuation.cursor,digest(canonical([scope,configDigest]))) as {json:string}|undefined;
    if (!row) throw invalid('Unknown preparation continuation or changed selection configuration');
    const value=JSON.parse(row.json) as CandidateCursor;
    for(const old of value.skip_units) {
        const spans=skipUnits.filter(unit=>unit.event_id===old.event_id).sort((a,b)=>a.start_byte-b.start_byte || a.end_byte-b.end_byte);
        let frontier=old.start_byte,covered=false;
        for(const span of spans){if(span.start_byte>frontier)break;if(span.end_byte>=frontier){frontier=span.end_byte;if(frontier>=old.end_byte){covered=true;break;}}}
        if(!covered)throw invalid('Preparation continuation skip progress cannot shrink');
    }
    return value;
}
export function savePreparationCursor(db:DatabaseSync, scope:PreparationScope, configDigest:string, value:CandidateCursor):PreparationContinuation {
    const id='preparation:'+digest(canonical([scope,configDigest,value]));
    db.prepare('INSERT OR IGNORE INTO preparation_cursors VALUES(?,?,?)').run(id,digest(canonical([scope,configDigest])),canonical(value));
    return {schema_version:1,scope,cursor:id};
}
