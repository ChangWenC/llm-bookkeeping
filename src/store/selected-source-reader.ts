import type {DatabaseSync} from 'node:sqlite';
import type {BookkeepingConfig,SourceEvent} from '../contracts/types.ts';
import {validateSourceEvent} from '../contracts/validation.ts';
import {ReviewReadExclusions} from './read-exclusions.ts';
import {WechatReviewScope,conversationTypeSql} from './wechat-scope.ts';
export interface SelectedSourceRead {schema_version:1;events:SourceEvent[];withheld:{schema_version:1;event_id:string;reason:string}[];body_bytes:number}
/** Coordinator-only caller owns a read-only connection. Freeze metadata/body reads in one read snapshot. */
export function readAdmittedSourceEvents(db:DatabaseSync,config:BookkeepingConfig,ids:string[],maxBodyBytes=131072):SelectedSourceRead {
 if(!Array.isArray(ids)||ids.length<1||ids.length>32||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!id.trim()||Buffer.byteLength(id)>256||/[\s\u0000-\u001f\u007f*?\[\]]/.test(id))||!Number.isSafeInteger(maxBodyBytes)||maxBodyBytes<1||maxBodyBytes>131072)throw new Error('Selected source read requires 1–32 unique exact IDs and 1–128KiB body budget');
 const exclusions=new ReviewReadExclusions(config),scope=new WechatReviewScope(config),receipt:SelectedSourceRead={schema_version:1,events:[],withheld:[],body_bytes:0};
 const hold=(event_id:string,reason:string)=>receipt.withheld.push({schema_version:1,event_id,reason});
 db.exec('BEGIN');try {
  exclusions.validateExists(db);
  const rows=db.prepare(`SELECT id,json_extract(json,'$.schema_version') AS version,json_extract(json,'$.event_id') AS event_id,COALESCE(json_extract(json,'$.context.review_slice.source_event_id'),id) AS original_id,json_extract(json,'$.source.provider') AS provider,json_extract(json,'$.source.account_id') AS account,json_extract(json,'$.source.conversation_id') AS conversation,classification,json_extract(json,'$.role') AS role,json_extract(json,'$.kind') AS kind,json_extract(json,'$.fragment_ref') AS fragment,${conversationTypeSql('json')} AS conversation_type,json_extract(json,'$.context.identity_verified') AS verified,json_extract(json,'$.context.sender_id') AS sender,json_extract(json,'$.context.incomplete_turn') AS incomplete,json_extract(json,'$.context.turn_complete') AS turn_complete,json_extract(json,'$.context.media_unread') AS media_unread,json_extract(json,'$.context.media_transcription_disabled') AS media_disabled,json_extract(json,'$.context.media_transcribed') AS media_transcribed,json_type(json,'$.body') AS body_type FROM events WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)) as any[];
  for(const id of ids){const row=rows.find(row=>row.id===id);if(!row){hold(id,'Selected source event missing');continue;}
   if(exclusions.reasons.has(id)||!exclusions.allowed(row.original_id)){hold(id,'Exact stored source read exclusion');continue;}
   if(row.version!==1||row.event_id!==id){hold(id,'Stored source identity/schema unknown');continue;}
   if(!config.providers.some(provider=>provider.enabled&&provider.provider===row.provider&&provider.account_id===row.account)){hold(id,'Provider/account is not currently admitted');continue;}
   if(row.classification!=='main'||row.role==='unknown'){hold(id,'Source classification or sender role remains unknown/excluded');continue;}
   if(!scope.allowed(row.provider,row.account,row.conversation,row.conversation_type)){hold(id,'Current WeChat conversation scope is not admitted');continue;}
   if(row.provider==='wechat'&&(row.verified!==1||row.sender==null||scope.pendingReason(row.provider,row.account,row.conversation,row.conversation_type,row.role,row.verified,row.sender))){hold(id,'Current WeChat sender identity/type remains unknown');continue;}
   if(exclusions.fragmentBlocked(db,row.fragment)){hold(id,'Source shares a protected raw fragment');continue;}
   if(row.incomplete===1||row.role!=='user'&&row.turn_complete===0){hold(id,'Incomplete source turn remains unread');continue;}
   if(row.body_type!=='text'||row.media_unread===1||row.media_disabled===1||row.media_transcribed!==1&&(/^(image|audio|video|media:)/i.test(row.kind)||row.provider==='wechat'&&row.media_transcribed===0&&!['text','Text','message','1'].includes(row.kind))){hold(id,'Missing media/unread source evidence remains deferred');continue;}
   // Only admitted identities reach body byte measurement; large originals are withheld whole.
   const size=db.prepare("SELECT length(CAST(json_extract(json,'$.body') AS BLOB)) AS body_bytes,length(CAST(json AS BLOB)) AS json_bytes FROM events WHERE id=?").get(id) as {body_bytes:number;json_bytes:number};
   if(size.body_bytes>maxBodyBytes-receipt.body_bytes||size.json_bytes+Buffer.byteLength(JSON.stringify(receipt))+4096>131072){hold(id,'Complete original exceeds bounded read budget; prepare exact ordinary source slices');continue;}
   const saved=db.prepare('SELECT json FROM events WHERE id=?').get(id) as {json:string};const event=JSON.parse(saved.json) as SourceEvent;validateSourceEvent(event);
   if(!exclusions.eventAllowed(event)||!scope.eventAllowed(event))throw new Error('Selected source admission changed inside frozen read');
   receipt.events.push(event);receipt.body_bytes+=size.body_bytes;
  }
  if(Buffer.byteLength(JSON.stringify(receipt))>131072)throw new Error('Selected source receipt exceeds 128KiB');return receipt;
 }finally{db.exec('ROLLBACK');}
}
