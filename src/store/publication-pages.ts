import type { DatabaseSync } from 'node:sqlite';
import type { PublicationOutboxPageRequest, PublicationOutboxPage, PublicationFilePageRequest, PublicationFilePage, PublicationRecoveryKind, FactArtifact, FileIntent } from '../contracts/types.ts';
import { canonical, digest } from '../analytics/serialization.ts';
const limitCheck=(limit:number) => {if(!Number.isSafeInteger(limit)||limit<1||limit>64)throw new Error('Publication page limit must be 1–64');};
function after(cursor:string|undefined, scope:string):number {
    if(cursor===undefined) return 0;
    const prefix=scope+':';
    if(!cursor.startsWith(prefix)||!/^\d+$/.test(cursor.slice(prefix.length)))throw new Error('Publication cursor scope mismatch');
    const position=Number(cursor.slice(prefix.length));
    if(!Number.isSafeInteger(position)||position<1)throw new Error('Invalid publication cursor');
    return position;
}
export function outboxPage(db:DatabaseSync,request:PublicationOutboxPageRequest):PublicationOutboxPage {
    if(request.schema_version!==1||!['pending','ready'].includes(request.status))throw new Error('Invalid publication outbox page');
    limitCheck(request.limit);
    const scope='outbox:'+request.status;
    const position=after(request.after,scope);
    const ids=db.prepare('SELECT rowid,id FROM outbox WHERE status=? AND rowid>? ORDER BY rowid LIMIT ?').all(request.status,position,request.limit+1) as {rowid:number;id:string}[];
    const items=ids.slice(0,request.limit).map(row=> {
        const item=db.prepare('SELECT json,status,export_path FROM outbox WHERE id=?').get(row.id) as {json:string;status:'pending'|'ready';export_path:string|null};
        return {schema_version:1 as const,batch_id:row.id,artifact:JSON.parse(item.json) as FactArtifact,status:item.status,export_path:item.export_path};
    });
    return {schema_version:1,items,next_cursor:ids.length>request.limit?scope+':'+ids[request.limit-1].rowid:null};
}
export function filePage(db:DatabaseSync,request:PublicationFilePageRequest):PublicationFilePage {
    if(request.schema_version!==1||!Array.isArray(request.states)||!request.states.length||new Set(request.states).size!==request.states.length||request.states.some(state=>!['prepared','applied','pending','conflict'].includes(state)))throw new Error('Invalid publication file page');
    limitCheck(request.limit);
    const scope='intents:'+digest(canonical([...request.states].sort()));
    const position=after(request.after,scope);
    const ids=db.prepare("SELECT i.rowid,i.id FROM intents i WHERE i.state IN (SELECT value FROM json_each(?)) AND i.rowid>? AND NOT EXISTS(SELECT 1 FROM operation_supersessions s WHERE s.original_id=i.id) AND NOT EXISTS(SELECT 1 FROM operation_terminals t WHERE t.original_id=i.id) ORDER BY i.rowid LIMIT ?").all(canonical(request.states),position,request.limit+1) as {rowid:number;id:string}[];
    const items=ids.slice(0,request.limit).map(row=>JSON.parse((db.prepare('SELECT json FROM intents WHERE id=?').get(row.id) as {json:string}).json) as FileIntent);
    return {schema_version:1,items,next_cursor:ids.length>request.limit?scope+':'+ids[request.limit-1].rowid:null};
}
export function recoveryCursor(db:DatabaseSync,kind:PublicationRecoveryKind,value?:string|null):string|null {
    if(!['ready_exports','applied_intents'].includes(kind))throw new Error('Unknown publication recovery cursor');
    const key='publication_recovery:'+kind;
    if(value!==undefined) {
        if(value!==null)after(value,kind==='ready_exports'?'outbox:ready':'intents:'+digest(canonical(['applied'])));
        db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,canonical(value));
        return value;
    }
    const row=db.prepare('SELECT value FROM metadata WHERE key=?').get(key) as {value:string}|undefined;
    return row?JSON.parse(row.value):null;
}
