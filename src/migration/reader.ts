import { open, type FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import { parseLossless } from '../adapters/common.ts';
import type { Budget } from './types.ts';
export interface ReaderCheckpoint { offset:number;mode:'jsonl'|'array';root:'array'|'object';key:string|null;meta:Record<string,unknown>;separator_required?:boolean }
export interface RecordFrame { raw:Buffer;value:unknown;start:number;end:number;checkpoint:ReaderCheckpoint;invalid:boolean }
class Stop extends Error {}
/** Reads ASCII JSON delimiters as bytes; UTF-8 string bytes are never split semantically. */
export class DataReader {
  bytes_read=0; records=0; pending:string[]=[]; finished=false; next:ReaderCheckpoint;
  private file:FileHandle|null=null; private buffer=Buffer.alloc(0); private index=0; private position=0; private deadline=0; private size=0;
  readonly path:string;readonly format:'json'|'jsonl'|'object';readonly budget:Budget;
  constructor(path:string,format:'json'|'jsonl'|'object',budget:Budget,checkpoint?:ReaderCheckpoint) {
    this.path=path;this.format=format;this.budget=budget;
    this.next=checkpoint??{offset:0,mode:format==='jsonl'?'jsonl':'array',root:'object',key:null,meta:{}};
  }
  private async byte():Promise<number|null> {
    if (Date.now()>this.deadline) { this.pending.push('duration_budget'); throw new Stop(); }
    if(this.index>=this.buffer.length){
      if(this.position>=this.size)return null;
      const remaining=this.budget.max_bytes-this.bytes_read;
      if(remaining<=0){this.pending.push('byte_budget');throw new Stop();}
      const buffer=Buffer.alloc(Math.min(65536,remaining,this.size-this.position));
      const read=await this.file!.read(buffer,0,buffer.length,this.position);
      this.buffer=buffer.subarray(0,read.bytesRead);this.index=0;this.bytes_read+=read.bytesRead;
      if(!read.bytesRead)return null;
    }
    this.position++;return this.buffer[this.index++];
  }
  private unread(){this.index--;this.position--;}
  private async significant(){let c;while((c=await this.byte())!==null&&[9,10,13,32].includes(c)){}return c;}
  private async value(first:number):Promise<Buffer> {
    const bytes:number[]=[first];let depth=first===123||first===91?1:0, quoted=first===34,escape=false;
    const container=depth>0;
    while(true){
      if(bytes.length>this.budget.max_record_bytes){this.pending.push('record_byte_budget');throw new Stop();}
      if(!container&&!quoted&&[125,93].includes(bytes.at(-1)!))throw new Error('unexpected_close');
      const c=await this.byte();
      if(c===null){if(depth||quoted)throw new Error('truncated_value');return Buffer.from(bytes);}
      if(quoted){bytes.push(c);if(escape)escape=false;else if(c===92)escape=true;else if(c===34){quoted=false;if(!container)return Buffer.from(bytes);}continue;}
      if(c===34){quoted=true;bytes.push(c);continue;}
      if(c===123||c===91){depth++;bytes.push(c);continue;}
      if(c===125||c===93){if(container){depth--;bytes.push(c);if(depth===0)return Buffer.from(bytes);}else{this.unread();return Buffer.from(bytes);}continue;}
      if(!container&&(c===44||[9,10,13,32].includes(c))){this.unread();return Buffer.from(bytes);}
      bytes.push(c);
    }
  }
  async *frames():AsyncGenerator<RecordFrame> {
    this.deadline=Date.now()+this.budget.max_duration_ms;
    try {
      this.file=await open(this.path,constants.O_RDONLY|constants.O_NOFOLLOW);const initial=await this.file.stat();this.size=initial.size;
      if(!initial.isFile())throw new Error('not_regular_file');
      this.position=this.next.offset;
      if(this.position>this.size){this.pending.push('source_truncated_checkpoint');return;}
      if(this.format==='object'){if(this.position>0){this.finished=true;return;}const first=await this.significant();if(first===null){this.finished=true;return;}const start=this.position-1;const raw=await this.value(first);const value=parseLossless(raw.toString('utf8'));this.next={...this.next,offset:this.position};this.records++;yield{raw,value,start,end:this.position,checkpoint:{...this.next},invalid:false};if(await this.significant()!==null)throw new Error('extra_json_data');this.finished=true;}else if(this.format==='jsonl'){
        while(this.records<this.budget.max_records){
          const start=this.position;const bytes:number[]=[];let c:number|null=null;
          while((c=await this.byte())!==null&&c!==10){bytes.push(c);if(bytes.length>this.budget.max_record_bytes){this.pending.push('record_byte_budget');throw new Stop();}}
          if(!bytes.length&&c===null){this.finished=true;break;}
          const raw=Buffer.from(bytes);this.next={...this.next,offset:this.position};
          if(!raw.toString('utf8').trim())continue;
          let value:unknown=null,invalid=false;try{value=parseLossless(raw.toString('utf8'));}catch{invalid=true;this.pending.push(c===null?'truncated_or_invalid_final_line':'invalid_jsonl_line');}
          this.records++;yield {raw,value,start,end:this.position,checkpoint:{...this.next,meta:{...this.next.meta}},invalid};
          if(c===null){this.finished=true;break;}
        }
      }else{
        if(this.position===0){
          const first=await this.significant();
          if(first===91)this.next={offset:this.position,mode:'array',root:'array',key:null,meta:{}};
          else if(first===123){
            while(true){
              const c=await this.significant();if(c!==34)throw new Error('object_key_expected');
              const key=String(parseLossless((await this.value(c)).toString('utf8')));
              if(await this.significant()!==58)throw new Error('colon_expected');
              const v=await this.significant();if(v===null)throw new Error('truncated_object');
              if((key==='messages'||key==='rows')&&v===91){this.next={offset:this.position,mode:'array',root:'object',key,meta:{...this.next.meta}};break;}
              const raw=await this.value(v);if(key==='chatlab')this.next.meta.chatlab=parseLossless(raw.toString('utf8'));
              const separator=await this.significant();if(separator===125){this.pending.push('message_array_missing');return;}if(separator!==44)throw new Error('separator_expected');
            }
          }else throw new Error('array_or_object_expected');
        }
        while(this.records<this.budget.max_records){
          let first=await this.significant();if(this.next.separator_required&&first!==44&&first!==93)throw new Error('array_separator_expected');if(first===44){first=await this.significant();if(first===93)throw new Error('trailing_array_comma');}
          if(first===93){
            if(this.next.root==='object'){
              // Consume bounded trailing root members to detect truncation; no arbitrary values escape.
              let tail=await this.significant();
              while(tail===44){const key=await this.significant();if(key!==34)throw new Error('trailing_key_expected');await this.value(key);if(await this.significant()!==58)throw new Error('colon_expected');const v=await this.significant();if(v===null)throw new Error('truncated_tail');await this.value(v);tail=await this.significant();}
              if(tail!==125)throw new Error('truncated_root');
            }
            if(await this.significant()!==null)throw new Error('extra_json_data');
            this.finished=true;break;
          }
          if(first===null)throw new Error('truncated_array');
          const start=this.position-1;const raw=await this.value(first);
          let value:unknown=null,invalid=false;try{value=parseLossless(raw.toString('utf8'));}catch{invalid=true;this.pending.push('invalid_json_record');}
          this.next={...this.next,offset:this.position,separator_required:true};this.records++;yield{raw,value,start,end:this.position,checkpoint:{...this.next,meta:{...this.next.meta}},invalid};
        }
      }
      if(this.records>=this.budget.max_records&&!this.finished)this.pending.push('record_budget');
      const after=await this.file.stat();if(after.size!==initial.size||after.mtimeMs!==initial.mtimeMs)this.pending.push('source_changed_during_read');
    }catch(error){if(!(error instanceof Stop))this.pending.push('invalid_truncated_or_unavailable_input');}
    finally{await this.file?.close();}
  }
}
