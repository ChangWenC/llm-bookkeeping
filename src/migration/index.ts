import { MIGRATION_HARD_LIMITS } from '../contracts/migration-limits.ts';
import { isAbsolute, resolve, relative, basename } from 'node:path';
import type { Store, BookkeepingConfig, Manifest, WorkItem, FactRevision, LegacyImportBatch, SourceCheckpoint, CollectionBatch } from '../contracts/types.ts';
import { zone, utc, date } from '../contracts/validation.ts';
import { parseChatExport } from '../adapters/imports.ts';
import { hash, unknown, gap } from '../adapters/common.ts';
import { DataReader, type RecordFrame, type ReaderCheckpoint } from './reader.ts';
import type { MigrationService, MigrationReport, EntryResult, MigrationEntry, ImportEntry, Budget, LegacyAnalyticsPort, AnalyticsEntry, AnalyticsMapping, AnalyticsHistoryRecord } from './types.ts';
export type * from './types.ts';
const stable = (value:unknown):string => Array.isArray(value)?'['+value.map(stable).join(',')+']':value!==null&&typeof value==='object'?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable((value as Record<string,unknown>)[k])).join(',')+'}':JSON.stringify(value);
const obj=(v:unknown):Record<string,unknown>|null=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:null;
const defaults:Budget={max_bytes:8*1024*1024,max_records:2000,max_record_bytes:256*1024,max_duration_ms:30000};
function work(key:string,kind:string,payload:Record<string,unknown>,at:string,reason:string|null):WorkItem{return{schema_version:1,work_id:'migration:'+hash(key),kind,lane:'history',state:'pending',payload,reason,migration_key:key,updated_at:at};}
function migrationKey(entry:MigrationEntry,frame:RecordFrame){return 'migration:'+hash(stable([entry.source_file_id,entry.kind,frame.start,hash(frame.raw)]));}
function historicalWork(entry:MigrationEntry,frame:RecordFrame,kind:string){return work(migrationKey(entry,frame)+':history',kind,{source_file_id:entry.source_file_id,locator:'sealed:'+entry.source_file_id,offset:frame.start,raw_bytes_base64:frame.raw.toString('base64'),record:frame.value},entry.recorded_at,'Immutable legacy input; not a verified new fact');}
function factFor(entry:MigrationEntry,record:Record<string,unknown>,section:string,index:number,item:unknown,occurrence:number):FactRevision {
  const raw=typeof item==='string'?item:stable(item),day=String(record.date);
  const locator=stable([entry.source_file_id,String(record.id),section,index,hash(raw),occurrence]);
  return{schema_version:1,fact_id:'legacy:'+hash(locator),revision:1,event_refs:[],content:raw,subject:'legacy_subject_unknown',occurred_at:unknown<string>(null,'Legacy calendar date has no proven event instant'),journal_date:unknown(day),kind:'legacy_record',analytics_projection:unknown(null,'Legacy content has no reviewed professional projection'),action:'assert',target_refs:[],scope:['legacy:journal'],attribution:{legacy_source_file_id:entry.source_file_id,legacy_daily_id:record.id,section,item_index:index,content_sha256:hash(raw),occurrence},recorded_at:entry.recorded_at,legacy_locator:locator};
}
function entryCheck(entry:MigrationEntry){
  if(!obj(entry)||!entry.kind||!entry.source_file_id||!entry.path||!isAbsolute(entry.path))throw new Error('entry_requires_absolute_path_and_sealed_identity');
  utc(entry.recorded_at,'recorded_at');
  if(!/\.jsonl?$/i.test(entry.path))throw new Error('non_json_input_forbidden');if(/(?:^|[._\/-])(credentials?|secrets?|tokens?|passwords?|keychain)(?:$|[._\/-])/i.test(entry.path))throw new Error('credential_input_forbidden');
  if(entry.kind==='chat_export'){
    if(!['chatlab-json','chatlab-jsonl','legacy-json','legacy-jsonl'].includes(entry.format))throw new Error('unsupported_import_format');
    if(!entry.account_id||!entry.conversation_id||!entry.owner_id||!['timestamp','create_time','epoch'].includes(entry.time_source))throw new Error('explicit_identity_and_time_source_required');
    if(entry.known_range?.schema_version!==1)throw new Error('known_range_required');utc(entry.known_range.from,'known_range.from');utc(entry.known_range.to,'known_range.to');if(Date.parse(entry.known_range.from)>=Date.parse(entry.known_range.to))throw new Error('invalid_known_range');
  }else if(!['daily_journal','analytics_observation','analytics_weekly','analytics_review','pending_state'].includes(entry.kind))throw new Error('unsupported_entry_kind');
}
export function createMigrationService(store:Store,config:BookkeepingConfig,options:{analytics?:LegacyAnalyticsPort;budget?:Partial<Budget>}={}):MigrationService {
  const budget={...defaults,...options.budget};
  for(const n of Object.values(budget))if(!Number.isSafeInteger(n)||n<1)throw new Error('invalid_migration_budget');
  if(Object.entries(budget).some(([key,value])=>value>MIGRATION_HARD_LIMITS[key as keyof typeof MIGRATION_HARD_LIMITS]))throw new Error('migration_budget_above_hard_limit');
  async function run(manifest:Manifest,kind:'import'|'migration'):Promise<MigrationReport>{
    if(manifest.schema_version!==1||manifest.kind!==kind||!manifest.manifest_id||!Array.isArray(manifest.entries))throw new Error('invalid_manifest');
    const report:MigrationReport={schema_version:1,manifest_id:manifest.manifest_id,kind,entries:[],budget,bytes_read:0,records:0,capture_status:'unknown'};
    const deadline=Date.now()+budget.max_duration_ms;
    // Provider-exclusive namespace keeps import offsets independent of live adapter offsets.
    const checkpoints=await store.getCheckpoints('migration','history');
    for(const rawEntry of manifest.entries.slice(0,2000)){
      const entry=rawEntry as unknown as MigrationEntry;
      const result:EntryResult={source_file_id:typeof entry?.source_file_id==='string'?entry.source_file_id:'unknown',kind:typeof entry?.kind==='string'?entry.kind:'unknown',status:'pending',records:0,bytes_read:0,next_offset:null,pending:[]};report.entries.push(result);
      try{
        entryCheck(entry);if(/^schema_[a-z_]+\.json$/i.test(basename(entry.path))){result.status='inspected';continue;}
        if(kind==='import'&&entry.kind!=='chat_export'){result.pending.push('import_requires_chat_export_entry');continue;}
        if(kind==='migration'&&entry.kind==='chat_export'){result.pending.push('use_import_for_chat_exports');continue;}
        if(report.bytes_read>=budget.max_bytes||report.records>=budget.max_records||Date.now()>=deadline){result.pending.push('manifest_budget_unread');continue;}
        const checkpointId='migration:'+hash(stable([entry.source_file_id,entry.kind,hash(stable(entry))]));
        const previous=checkpoints.find(c=>c.checkpoint_id===checkpointId);
        const readerCheckpoint=obj(previous?.cursor.reader) as unknown as ReaderCheckpoint|undefined;
        // Explicit file identity + immutable row migration keys detect conflicting reuses.
        const reader=new DataReader(entry.path,entry.kind==='pending_state'&&entry.format==='json'?'object':entry.format?.endsWith('jsonl')||entry.format==='jsonl'?'jsonl':'json',{...budget,max_bytes:budget.max_bytes-report.bytes_read,max_records:budget.max_records-report.records,max_duration_ms:Math.max(1,deadline-Date.now())},readerCheckpoint);
        for await(const frame of reader.frames()){
          try{
            if(entry.kind==='chat_export'){await importFrame(entry,frame,result);reader.next.meta=frame.checkpoint.meta;}
            else if(frame.invalid)await store.importLegacy({schema_version:1,migration_key:migrationKey(entry,frame),facts:[],mappings:[],work:[historicalWork(entry,frame,'needs_review')]});
            else if(entry.kind==='daily_journal')await journalFrame(entry,frame,result);
            else if(entry.kind==='pending_state')await stateFrame(entry,frame,result);
            else await analyticsFrame(entry,frame,result);
            // Checkpoint follows durable semantic/legacy import; crash before it safely reuses immutable keys.
            const checkpoint:SourceCheckpoint={schema_version:1,checkpoint_id:checkpointId,provider:'migration',lane:'history',locator:entry.path,generation:entry.source_file_id,cursor:{reader:frame.checkpoint,entry_fingerprint:hash(stable(entry))},updated_at:entry.recorded_at};
            if(entry.kind!=='chat_export')await store.saveCollection({schema_version:1,batch_id:'migration-checkpoint:'+hash(stable([checkpointId,frame.end,hash(frame.raw),hash(stable(entry))])),events:[],fragments:[],coverage:[],checkpoints:[checkpoint]});
            result.records++;report.records++;result.next_offset=frame.end;
          }catch{result.pending.push('record_persistence_or_mapping_conflict');break;}
        }
        result.bytes_read=reader.bytes_read;report.bytes_read+=reader.bytes_read;result.pending.push(...reader.pending);
        if(entry.kind==='chat_export')result.pending.push('export_complete_claim_not_coverage_proof');
        result.pending=[...new Set(result.pending)];result.status=result.pending.length?'partial':reader.finished?'inspected':'unknown';
        if(result.pending.length){await store.enqueueWork(work('migration-remainder:'+hash(stable([entry.source_file_id,entry.kind,result.next_offset,result.pending])),'needs_review',{source_file_id:entry.source_file_id,kind:entry.kind,next_offset:result.next_offset,reasons:result.pending},entry.recorded_at,'Migration is partial; does not block live work'));}
      }catch{result.pending.push('invalid_or_unavailable_entry');result.status='pending';}
    }
    if(manifest.entries.length>2000)report.entries.push({source_file_id:'unknown',kind:'unexamined_entries',status:'unknown',records:0,bytes_read:0,next_offset:null,pending:['manifest_entry_budget_unread']});
    report.capture_status=report.entries.some(e=>e.status==='partial'||e.status==='pending')?'partial':'unknown';return report;
  }
  async function importFrame(entry:ImportEntry,frame:RecordFrame,result:EntryResult){
    const fragmentId='import-fragment:'+hash(stable([entry.source_file_id,frame.start,hash(frame.raw)]));
    const record=obj(frame.value);const checkpoint={...frame.checkpoint,meta:{...frame.checkpoint.meta}};
    if(entry.format==='chatlab-jsonl'&&record?._type==='header'){checkpoint.meta.header=record;frame.checkpoint=checkpoint;}
    let wireZone:string|undefined;
    if(entry.source_timezone){try{zone(entry.source_timezone,'source_timezone');wireZone=entry.source_timezone;}catch{result.pending.push('unknown_iana_source_timezone');}}

    const metadata={account_id:entry.account_id,conversation_id:entry.conversation_id,owner_id:entry.owner_id,conversation_type:entry.conversation_type,self_ids:entry.self_ids,self_aliases:entry.self_aliases,mention_aliases:entry.mention_aliases,aliases_verified:entry.aliases_verified,source_timezone:wireZone,locator:'sealed:'+entry.source_file_id,provider:entry.provider??'wechat',known_range:entry.known_range,identity_verified:entry.identity_verified,coverage_verified:false};
    const isHeader=entry.format==='chatlab-jsonl'&&record?._type!=='message';
    let bytes:string;
    const normalRecord=record?{...record,source_offset:frame.start,timestamp:record[entry.time_source]}:frame.value;
    if(entry.format==='chatlab-jsonl')bytes=JSON.stringify(checkpoint.meta.header??{_type:'header'})+'\n'+(isHeader?'':JSON.stringify(normalRecord)+'\n');
    else if(entry.format==='chatlab-json')bytes=JSON.stringify({chatlab:checkpoint.meta.chatlab,messages:[normalRecord]});
    else bytes=JSON.stringify(normalRecord)+'\n';
    let parsed:ReturnType<typeof parseChatExport>;try{parsed=frame.invalid?{events:[],gaps:[gap('invalid_import_record',entry.path)],members:[],metadata:{}}:parseChatExport(bytes,entry.format.startsWith('chatlab')?entry.format:'legacy-jsonl',metadata,config);}catch{parsed={events:[],gaps:[gap('unsupported_identity_time_or_import_record',entry.path)],members:[],metadata:{}};}
    if(!isHeader&&!entry.source_timezone&&parsed.events.some(event=>event.utc_time.value===null)) parsed.gaps.push(gap('source_timezone_unknown',entry.path));
    if(!isHeader&&entry.format.startsWith('chatlab')&&!record)parsed.gaps.push(gap('chatlab_record_not_object',entry.path));
    if(!entry.identity_verified)result.pending.push('import_self_identity_unverified');
    if(entry.pagination?.limit_hit||entry.pagination?.truncated||entry.pagination?.duplicate_page||entry.pagination?.cursor_verified===false)parsed.gaps.push(gap('export_pagination_or_truncation_unknown',entry.path));
    for(const event of parsed.events){
      event.fragment_ref=fragmentId;
      // Native IDs share live identity; conflicting payloads remain local pending in Store.
      if(event.source.message_id===null){event.context.duplicate_status='unknown';parsed.gaps.push(gap('non_native_overlap_requires_reconciliation',entry.path));}
      event.context.import_file_id=entry.source_file_id;
    }
    const priorGaps=Array.isArray(checkpoint.meta.import_gaps)?checkpoint.meta.import_gaps as typeof parsed.gaps:[];
    const allGaps=[...new Map([...priorGaps,...parsed.gaps].map(g=>[g.reason,g])).values()].slice(0,128);checkpoint.meta.import_gaps=allGaps;frame.checkpoint=checkpoint;
    result.pending.push(...allGaps.map(g=>g.reason));
    const coverage={schema_version:1 as const,coverage_id:'import:'+hash(stable([entry.source_file_id,entry.account_id,entry.conversation_id,entry.known_range])),provider:entry.provider??'wechat',account_id:entry.account_id,conversation_id:entry.conversation_id,lane:'history' as const,query_range:entry.known_range,cutoff:entry.known_range.to,read_ranges:[],gaps:allGaps,capture_status:'partial' as const,review_status:'pending' as const};
    const batch:CollectionBatch={schema_version:1,batch_id:'import:'+hash(stable([entry.source_file_id,frame.start,hash(frame.raw),hash(stable(entry))])),events:parsed.events,fragments:[{schema_version:1,fragment_id:fragmentId,locator:'sealed:'+entry.source_file_id+':byte:'+frame.start,bytes_base64:frame.raw.toString('base64'),sha256:hash(frame.raw)}],coverage:[coverage],checkpoints:[]};
    // Collection checkpoint and raw/events must share this transaction, not the later generic checkpoint.
    const id='migration:'+hash(stable([entry.source_file_id,entry.kind,hash(stable(entry))]));
    batch.checkpoints=[{schema_version:1,checkpoint_id:id,provider:'migration',lane:'history',locator:entry.path,generation:entry.source_file_id,cursor:{reader:frame.checkpoint,entry_fingerprint:hash(stable(entry))},updated_at:entry.recorded_at}];
    await store.saveCollection(batch);
  }
  async function journalFrame(entry:MigrationEntry,frame:RecordFrame,result:EntryResult){
    const record=obj(frame.value);let validDate=false;try{date(record?.date,'legacy.date');validDate=true;}catch{}const facts:FactRevision[]=[];const jobs:WorkItem[]=[historicalWork(entry,frame,'legacy_journal_history')];
    if(!validDate||!record||record.schema_version!=='daily-journal-jsonl-v1'||typeof record.id!=='string'||!/^daily:\d{4}-\d{2}-\d{2}$/.test(record.id)||typeof record.date!=='string'||record.id!==`daily:${record.date}`||!obj(record.sections)){
      result.pending.push('unsupported_daily_archive_record');jobs.push(work(migrationKey(entry,frame)+':needs_review','needs_review',{source_file_id:entry.source_file_id,offset:frame.start},entry.recorded_at,'Unsupported daily archive record'));
    }else{
      const required=['original_stem','title','summary','links','sources','promoted_to','retention','created','updated'];if(required.some(k=>!(k in record))){result.pending.push('legacy_required_fields_missing');jobs.push(work(migrationKey(entry,frame)+':schema-review','needs_review',{source_file_id:entry.source_file_id,offset:frame.start},entry.recorded_at,'Legacy archive has incomplete schema fields; assertions remain unverified'));}
      const occurrences=new Map<string,number>();
      for(const [section,items] of Object.entries(record.sections as Record<string,unknown>)){
        if(!Array.isArray(items)){result.pending.push('legacy_section_not_array');jobs.push(work(migrationKey(entry,frame)+':section:'+hash(section),'needs_review',{source_file_id:entry.source_file_id,offset:frame.start,section},entry.recorded_at,'Legacy section is not an array'));continue;}
        for(const [index,item] of items.entries()){
          if(typeof item!=='string'&&!obj(item)){result.pending.push('legacy_item_unsupported');jobs.push(work(migrationKey(entry,frame)+':item:'+hash(stable([section,index])),'needs_review',{source_file_id:entry.source_file_id,offset:frame.start,section,index},entry.recorded_at,'Legacy item has unsupported shape'));continue;}
          const key=hash(stable([section,item]));const n=occurrences.get(key)??0;occurrences.set(key,n+1);facts.push(factFor(entry,record,section,index,item,n));
        }
      }
    }
    await store.importLegacy({schema_version:1,migration_key:migrationKey(entry,frame),facts,mappings:[],work:jobs});
  }
  async function stateFrame(entry:MigrationEntry,frame:RecordFrame,result:EntryResult){
    const stateEntry=entry as import('./types.ts').StateEntry;const record=obj(frame.value);const key=migrationKey(entry,frame),jobs=[historicalWork(entry,frame,'legacy_state_history')];
    const allowed=new Set(['collect','review','draft','consumer','index','out_of_scope','needs_review']);
    const category=stateEntry.category??(typeof record?.category==='string'?record.category:typeof record?.kind==='string'?record.kind:'needs_review');
    if(!allowed.has(category))result.pending.push('legacy_state_unknown_category');
    if(category==='index'){
      const files=Array.isArray(record?.files)?record!.files:typeof record?.path==='string'?[record.path]:[];
      for(const file of files){if(typeof file!=='string')continue;const path=resolve(config.wiki_root,file),rel=relative(config.wiki_root,path);if(rel.startsWith('..')||isAbsolute(rel)){jobs.push(work(key+':invalid-index','needs_review',{source_file_id:entry.source_file_id},entry.recorded_at,'Index target escapes Wiki'));continue;}jobs.push(work('migration:index:'+hash(path),'index',{path},entry.recorded_at,'Merged current-file index debt'));}
      if(!files.length)jobs.push(work(key+':index-unknown','needs_review',{source_file_id:entry.source_file_id},entry.recorded_at,'Index state has no explicit current files'));
    }else jobs.push(work(key+':pending',allowed.has(category)?category:'needs_review',{source_file_id:entry.source_file_id,offset:frame.start,legacy_payload:record??frame.value},entry.recorded_at,'Legacy state is ordinary queued work; complete claims are untrusted'));
    await store.importLegacy({schema_version:1,migration_key:key,facts:[],mappings:[],work:jobs});
  }
  async function analyticsFrame(entry:AnalyticsEntry,frame:RecordFrame,result:EntryResult){
    const record=obj(frame.value);const key=migrationKey(entry,frame)+':reconcile:'+hash(stable([entry.projections??[],entry.mappings??[]]));const jobs=[historicalWork(entry,frame,'legacy_analytics_history')];
    const sourceId=typeof record?.id==='string'?record.id:null;const contentHash=typeof record?.content_hash==='string'?record.content_hash:null;
    const kind=entry.kind==='analytics_observation'?'observation':entry.kind==='analytics_weekly'?'weekly':'review';
    const expected=kind==='review'?'self-analytics-review-event-v1':kind==='weekly'?'self-analytics-weekly-record-v1':'self-analytics-observation-v1';
    const projection=entry.projections?.find(p=>p.source_id===sourceId&&p.content_hash===contentHash);
    const mappings:AnalyticsMapping[]=(entry.mappings??[]).filter(m=>m.source_id===sourceId).map(m=>{
      const targetMatches=m.target_content_hash===(kind==='review'?record?.target_content_hash:contentHash);
      const weeklyMatches=kind!=='review'||(m.weekly_content_hash===record?.weekly_content_hash&&m.weekly_ref?.revision===record?.weekly_revision);
      return{...m,confidence:targetMatches&&weeklyMatches&&m.target_ref&&m.confidence==='verified'?'verified':'unresolved',reason:targetMatches&&weeklyMatches?m.reason:'Exact legacy hash/revision binding is absent or mismatched'};
    });
    if(!sourceId||!contentHash||record?.schema_version!==expected||!projection||!options.analytics){
      result.pending.push('analytics_history_requires_exact_mapping_or_professional_projection');jobs.push(work(key+':needs-review','needs_review',{source_file_id:entry.source_file_id,offset:frame.start,source_id:sourceId},entry.recorded_at,'History retained; confirmations not transferred'));
    }else{
      const revision=kind==='review'?record.weekly_revision:record.revision;
      if(!Number.isSafeInteger(revision)||Number(revision)<1)throw new Error('invalid_legacy_revision');
      let professionalPayload=projection.professional_payload;
      if(kind==='review'){if(!['confirm','reject','correct','retract'].includes(String(record.decision))){result.pending.push('legacy_action_requires_manual_revision_mapping');await store.importLegacy({schema_version:1,migration_key:key,facts:[],mappings:[],work:[...jobs,work(key+':unsupported-action','needs_review',{source_id:sourceId,source_file_id:entry.source_file_id},entry.recorded_at,'Legacy action has no automatic new review equivalent')]});return;}
        professionalPayload={...professionalPayload,schema_version:1,review_id:sourceId,action:record.decision};
        if(typeof record.recorded_at==='string'){utc(record.recorded_at,'legacy.review.recorded_at');professionalPayload.created_at=record.recorded_at;}
        if(professionalPayload.action!==projection.professional_payload.action)result.pending.push('legacy_review_projection_action_overridden');
      }
      const history:AnalyticsHistoryRecord={kind,source_id:sourceId,logical_id:typeof record.logical_id==='string'?record.logical_id:sourceId,revision:Number(revision),content_hash:contentHash,professional_payload:professionalPayload};
      const imported=await options.analytics.importHistory({schema_version:1,migration_key:key,records:[history],mappings});
      if(imported.unresolved){result.pending.push('analytics_exact_revision_unresolved');jobs.push(work(key+':needs-review','needs_review',{source_file_id:entry.source_file_id,offset:frame.start,source_id:sourceId},entry.recorded_at,'Exact revision mapping unresolved; no inherited confirmation'));}
    }
    await store.importLegacy({schema_version:1,migration_key:key,facts:[],mappings:[],work:jobs});
  }
  return{importManifest:manifest=>run(manifest,'import'),migrateManifest:manifest=>run(manifest,'migration')};
}
