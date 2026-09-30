import type {BookkeepingConfig,SourceEvent,CoverageGap} from '../contracts/types.ts';
import {event,gap,hash,parseLossless} from './common.ts';
export interface ImportMetadata {account_id:string;conversation_id:string;owner_id?:string;self_ids?:string[];source_timezone?:string;locator:string;provider?:string;known_range?:{from:string;to:string};coverage_verified?:boolean;identity_verified?:boolean;}
export interface ParsedImport {events:SourceEvent[];gaps:CoverageGap[];members:Record<string,unknown>[];metadata:Record<string,unknown>}
/** Original export bytes must be persisted by the importing coordinator. No filenames infer identity. */
export function parseChatExport(bytes:Buffer|string,format:'chatlab-json'|'chatlab-jsonl'|'legacy-jsonl'|'legacy-json',manifest:ImportMetadata,config:BookkeepingConfig):ParsedImport {
  const text=Buffer.isBuffer(bytes)?bytes.toString('utf8'):bytes;const gaps:CoverageGap[]=[];const members:any[]=[];let meta:any={};const rows:{row:any;offset:number}[]=[];
  if(!manifest.account_id||!manifest.conversation_id||!manifest.locator)throw new Error('import_requires_account_conversation_locator');
  if(format.endsWith('jsonl')){let offset=0;let header=false;for(const line of text.split('\n')){const length=Buffer.byteLength(line)+1;if(line.trim()&&!line.startsWith('#'))try{const r=parseLossless(line);if(format==='chatlab-jsonl'){if(!header){if(r._type!=='header')throw new Error('chatlab_header_required');meta=r;header=true;}else if(r._type==='member')members.push(r);else if(r._type==='message')rows.push({row:r,offset});else gaps.push(gap('chatlab_unknown_row',manifest.locator));}else rows.push({row:r,offset});}catch{gaps.push(gap(`malformed_import_line:${offset}`,manifest.locator));}offset+=length;}if(format==='chatlab-jsonl'&&!header)gaps.push(gap('chatlab_header_missing',manifest.locator));}
  else try{const parsed=parseLossless(text);if(format==='chatlab-json'){meta=parsed;members.push(...(parsed.members??[]));if(!Array.isArray(parsed.messages))throw new Error('chatlab_messages_missing');parsed.messages.forEach((row:any,i:number)=>rows.push({row,offset:i}));}else{const items=Array.isArray(parsed)?parsed:parsed.messages??parsed.rows;if(!Array.isArray(items))throw new Error('legacy_messages_missing');items.forEach((row:any,i:number)=>rows.push({row,offset:i}));}}catch{gaps.push(gap('invalid_or_truncated_import_json',manifest.locator));}
  if(format.startsWith('chatlab')&&meta.chatlab?.version!=='0.0.2')gaps.push(gap('unsupported_chatlab_version',manifest.locator));
  const self=new Set(manifest.self_ids??(manifest.owner_id?[manifest.owner_id]:[]));
  if(!manifest.identity_verified || !self.size)gaps.push(gap('import_self_identity_unverified',manifest.locator));
  if(!manifest.coverage_verified||!manifest.known_range)gaps.push(gap('export_complete_claim_not_coverage_proof',manifest.locator));
  const events:SourceEvent[]=[];const occurrences=new Map<string,number>();
  for(const {row:r,offset} of rows){const chatlab=format.startsWith('chatlab');const sender=String(r.sender??r.sender_id??'');const native=r.platformMessageId??r.server_id??r.message_id??r.id;const body=r.content??r.message_content??r.text;const timestamp=r.timestamp??r.create_time;const kind=chatlab?Number(r.type)===0?'text':`media:${r.type}`:r.message_type??'text';
    if(typeof body!=='string'){gaps.push(gap('import_media_or_content_missing',manifest.locator));continue;}
    if(kind!=='text'&&kind!=='message')gaps.push(gap('media_not_transcribed',manifest.locator));
    const key=hash(JSON.stringify([r.source??manifest.locator,r.source_offset??offset,timestamp,sender,body]));const count=occurrences.get(key)??0;occurrences.set(key,count+1);
    const e=event({provider:manifest.provider??'wechat',account:manifest.account_id,conversation:manifest.conversation_id,message:native==null?null:String(native),block:'0',body,role:manifest.identity_verified&&self.has(sender)?'user':manifest.identity_verified&&sender?'other':'unknown',time:timestamp,wireZone:manifest.source_timezone,offset,locator:manifest.locator,generation:native==null?hash(manifest.locator):'0',kind,context:{sender_id:sender,source_format:format,source_offset:r.source_offset??offset,owner_id:manifest.owner_id??null,suspected_overlap:true}},config);
    if(native==null)e.event_id=hash(`${manifest.provider??'wechat'}:${manifest.account_id}:${manifest.conversation_id}:import:${key}:${count}`);
    if(e.utc_time.value===null)gaps.push(gap(e.utc_time.reason??'import_time_unknown',manifest.locator));
    events.push(e);
  }
  return {events,gaps,members,metadata:meta};
}
