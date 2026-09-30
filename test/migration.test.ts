import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store/index.ts';
import { createMigrationService } from '../src/migration/index.ts';
import { DataReader } from '../src/migration/reader.ts';
import { event, hash } from '../src/adapters/common.ts';
import type { BookkeepingConfig, Manifest, FactRevision } from '../src/contracts/types.ts';
const range={schema_version:1 as const,from:'2026-01-01T00:00:00Z',to:'2027-01-01T00:00:00Z'},at='2026-09-30T12:00:00Z';
async function fixture(){const root=await mkdtemp(join(tmpdir(),'bookkeeping-migration-test-'));await mkdir(join(root,'wiki'));const config:BookkeepingConfig={schema_version:1,wiki_root:join(root,'wiki'),data_dir:join(root,'data'),journal_timezone:'Europe/Amsterdam',analysis_timezone:'Europe/Amsterdam',cutover_at:at,live_start:at,journal_timezone_timeline:[],providers:[],limits:{chunk_events:80,chunk_body_bytes:32768,bundle_bytes:131072,bundles_per_round:4},project_whitelist:[],goal_whitelist:[]};return{root,config,store:await createStore(config)};}
const manifest=(entries:Record<string,unknown>[],kind:'import'|'migration'='import'):Manifest=>({schema_version:1,manifest_id:'synthetic:'+kind,kind,entries});
function importEntry(path:string,extra:Record<string,unknown>={}){return{kind:'chat_export',path,source_file_id:'sealed:synthetic-export',recorded_at:at,format:'legacy-jsonl',account_id:'account-synthetic',conversation_id:'chat-synthetic',owner_id:'self-synthetic',identity_verified:true,time_source:'timestamp',source_timezone:'Europe/Amsterdam',known_range:range,...extra};}

test('streaming import atomically saves raw/events/checkpoint, preserves 64-bit IDs, minute precision and native overlap',async()=>{
 const f=await fixture();try{
 const path=join(f.root,'export.jsonl');await writeFile(path,'{"id":9223372036854775807,"sender":"self-synthetic","timestamp":"2026-09-30 12:34","text":"synthetic professional test"}\n{"sender":"other-synthetic","timestamp":"2026-09-30T13:00:00+02:00","text":"same"}\n{"sender":"other-synthetic","timestamp":"2026-09-30T13:00:00+02:00","text":"same"}\n');
 const service=createMigrationService(f.store,f.config);const report=await service.importManifest(manifest([importEntry(path,{complete:true,pagination:{limit_hit:true}})]));
 assert.equal(report.capture_status,'partial');assert(report.entries[0].pending.includes('export_pagination_or_truncation_unknown'));assert(report.entries[0].pending.includes('non_native_overlap_requires_reconciliation'));
 const events=await f.store.listEvents({range,include_context:true});assert.equal(events.length,3);const first=events.find(e=>e.source.message_id==='9223372036854775807')!;assert(first);assert.equal(first.time_precision,'minute');assert.equal(first.utc_time.value,'2026-09-30T10:34:00.000Z');assert(first.fragment_ref);const checkpoints=await f.store.getCheckpoints('migration','history');assert.equal(checkpoints.length,1);
 await service.importManifest(manifest([importEntry(path,{complete:true,pagination:{limit_hit:true}})]));assert.equal((await f.store.listEvents({range,include_context:true})).length,3);
 const native=event({provider:'wechat',account:'account-synthetic',conversation:'chat-synthetic',message:'9223372036854775807',block:'0',body:'synthetic professional test',role:'user',time:'2026-09-30 12:34',wireZone:'Europe/Amsterdam',offset:0,locator:'/synthetic/live',generation:'0'},f.config);
 assert.equal(native.event_id,first.event_id);await f.store.saveCollection({schema_version:1,batch_id:'synthetic-live-overlap',events:[native],fragments:[],coverage:[],checkpoints:[]});assert.equal((await f.store.status()).events,3);assert.equal((await f.store.listWork('event_conflict')).length,1);
 }finally{f.store.close();await rm(f.root,{recursive:true,force:true});}
});

test('JSON documents resume within message array; ChatLab JSONL header state survives rounds',async()=>{
 const f=await fixture();try{
 const path=join(f.root,'chatlab.json');await writeFile(path,JSON.stringify({chatlab:{version:'0.0.2'},members:[{id:'self-synthetic'}],messages:Array.from({length:5},(_,i)=>({platformMessageId:String(i+1),sender:'self-synthetic',timestamp:'2026-09-30T12:00:00Z',type:0,content:`synthetic ${i}`}))}));
 const entry=importEntry(path,{format:'chatlab-json'});const service=createMigrationService(f.store,f.config,{budget:{max_records:2}});
 for(let i=0;i<4;i++)await service.importManifest(manifest([entry]));assert.equal((await f.store.listEvents({range,include_context:true})).length,5);
 const lines=join(f.root,'chatlab.jsonl');await writeFile(lines,'{"_type":"header","chatlab":{"version":"0.0.2"}}\n{"_type":"message","platformMessageId":"six","sender":"self-synthetic","timestamp":"2026-09-30T12:00:00Z","type":0,"content":"synthetic sixth"}\n');
 const lineEntry=importEntry(lines,{format:'chatlab-jsonl',source_file_id:'sealed:chatlab-lines'});const one=createMigrationService(f.store,f.config,{budget:{max_records:1}});await one.importManifest(manifest([lineEntry]));const second=await one.importManifest(manifest([lineEntry]));assert(!second.entries[0].pending.includes('unsupported_chatlab_version'));assert.equal((await f.store.status()).events,6);
 }finally{f.store.close();await rm(f.root,{recursive:true,force:true});}
});

test('unknown zone, DST ambiguity, malformed row, truncation and bounded unread work remain local partial',async()=>{
 const f=await fixture();try{
 const path=join(f.root,'unknown.jsonl');await writeFile(path,'{bad}\n{"id":"dst","sender":"self-synthetic","timestamp":"2026-10-25 02:30","text":"ambiguous"}\n{"id":"known","sender":"self-synthetic","timestamp":"2026-09-30T12:00:00Z","text":"valid"}\n');
 const service=createMigrationService(f.store,f.config);const r=await service.importManifest(manifest([importEntry(path,{source_file_id:'sealed:dst'}),importEntry(path,{source_file_id:'sealed:unknown-zone',conversation_id:'other-chat',source_timezone:null})]));assert(r.entries[0].pending.includes('ambiguous_local_time'));assert(r.entries[1].pending.includes('source_timezone_unknown'));assert((await f.store.listWork('event_identity_time')).length>=1);assert.equal((await f.store.listEvents({range,include_context:true})).length,2);
 const truncated=join(f.root,'truncated.json');await writeFile(truncated,'{"messages":[{"id":"last","sender":"self-synthetic","timestamp":"2026-09-30T12:00:00Z","text":"retained"}');const rt=await service.importManifest(manifest([importEntry(truncated,{format:'legacy-json',source_file_id:'sealed:truncated'})]));assert(rt.entries[0].pending.includes('invalid_truncated_or_unavailable_input'));assert.equal((await f.store.status()).events,5);
 const bounded=await createMigrationService(f.store,f.config,{budget:{max_bytes:5}}).importManifest(manifest([importEntry(path,{source_file_id:'sealed:tiny-budget'}),importEntry(truncated,{format:'legacy-json',source_file_id:'sealed:unread'})]));assert(bounded.bytes_read<=5);assert(bounded.entries[1].pending.includes('manifest_budget_unread'));
 }finally{f.store.close();await rm(f.root,{recursive:true,force:true});}
});

test('legacy strings/objects get stable immutable IDs, repeat positions survive and corrections fold without rewriting annual input',async()=>{
 const f=await fixture();try{
 const path=join(f.root,'daily_2026.jsonl');const bytes=JSON.stringify({schema_version:'daily-journal-jsonl-v1',id:'daily:2026-09-29',date:'2026-09-29',sections:{activities:['same','same',{text:'structured legacy context'}]},summary:'private synthetic'})+'\n';await writeFile(path,bytes);
 const entry={kind:'daily_journal',format:'jsonl',path,source_file_id:'sha256:synthetic-sealed-digest',recorded_at:at};const service=createMigrationService(f.store,f.config);await service.migrateManifest(manifest([entry],'migration'));await service.migrateManifest(manifest([entry],'migration'));let facts=await f.store.readEffectiveFacts({range});assert.equal(facts.length,3);assert(facts.every(v=>v.kind==='legacy_record'&&v.occurred_at.value===null));assert.equal(new Set(facts.map(v=>v.fact_id)).size,3);assert.equal((await readFile(path,'utf8')),bytes);
 const target=facts[0],replacement:FactRevision={...target,fact_id:'synthetic-correction',content:'corrected synthetic record',action:'replace',target_refs:[{schema_version:1,fact_id:target.fact_id,revision:1}],legacy_locator:null,recorded_at:'2026-09-30T13:00:00Z'};
 await f.store.importLegacy({schema_version:1,migration_key:'synthetic-correction-batch',facts:[replacement],mappings:[],work:[]});facts=await f.store.readEffectiveFacts({range});assert.equal(facts.length,3);assert(!facts.some(v=>v.fact_id===target.fact_id));
 const retract={...replacement,fact_id:'synthetic-retraction',action:'retract' as const,target_refs:[{schema_version:1 as const,fact_id:replacement.fact_id,revision:1}],recorded_at:'2026-09-30T14:00:00Z'};await f.store.importLegacy({schema_version:1,migration_key:'synthetic-retract-batch',facts:[retract],mappings:[],work:[]});assert.equal((await f.store.readEffectiveFacts({range})).length,2);
 }finally{f.store.close();await rm(f.root,{recursive:true,force:true});}
});

test('Analytics raw history survives absent projection/port and mismatched exact hashes cannot transfer confirmation; index debt merges by file',async()=>{
 const f=await fixture();try{
 const path=join(f.root,'reviews.jsonl');const old={schema_version:'self-analytics-review-event-v1',id:'old-review',weekly_id:'old-week',weekly_revision:2,weekly_content_hash:'a'.repeat(64),target_id:'old-target',target_content_hash:'b'.repeat(64),decision:'confirm',reason:'synthetic private clause',content_hash:'c'.repeat(64)};await writeFile(path,JSON.stringify(old)+'\n');const entry={kind:'analytics_review',format:'jsonl',path,source_file_id:'sealed:reviews',recorded_at:at};await createMigrationService(f.store,f.config).migrateManifest(manifest([entry],'migration'));assert.equal((await f.store.listWork('legacy_analytics_history')).length,1);assert.equal((await f.store.listWork('needs_review')).length>=1,true);
 let seen:any;const port={async importHistory(input:any){seen=input;return{reused:false,retained:1,activated:0,unresolved:1};}};
 await createMigrationService(f.store,f.config,{analytics:port}).migrateManifest(manifest([{...entry,projections:[{source_id:'old-review',content_hash:old.content_hash,professional_payload:{action:'confirm',target_ref:{schema_version:1,logical_id:'target',revision:2}}}],mappings:[{source_id:'old-review',target_ref:{schema_version:1,logical_id:'target',revision:2},weekly_ref:{schema_version:1,logical_id:'week',revision:2},target_content_hash:'d'.repeat(64),weekly_content_hash:old.weekly_content_hash,confidence:'verified',reason:null}]}],'migration'));
 assert(seen);assert.equal(seen.mappings[0].confidence,'unresolved');assert(!JSON.stringify(seen).includes('private clause'));
 const state=join(f.root,'state.json');await writeFile(state,JSON.stringify({complete:true,files:['wiki/personal/journals/synthetic.md']}));const stateEntry={kind:'pending_state',format:'json',category:'index',path:state,source_file_id:'sealed:state-a',recorded_at:at};await createMigrationService(f.store,f.config).migrateManifest(manifest([stateEntry,{...stateEntry,source_file_id:'sealed:state-b'}],'migration'));assert.equal((await f.store.listWork('index')).length,1);
 }finally{f.store.close();await rm(f.root,{recursive:true,force:true});}
});

test('DataReader refuses oversized records without advancing a false checkpoint',async()=>{const dir=await mkdtemp(join(tmpdir(),'bookkeeping-migration-reader-test-'));try{const path=join(dir,'huge.jsonl');await writeFile(path,JSON.stringify({text:'x'.repeat(10000)})+'\n');const reader=new DataReader(path,'jsonl',{max_bytes:100,max_record_bytes:50,max_records:10,max_duration_ms:1000});const frames=[];for await(const frame of reader.frames())frames.push(frame);assert.equal(frames.length,0);assert.equal(reader.next.offset,0);assert(reader.pending.includes('record_byte_budget'));assert(reader.bytes_read<=100);}finally{await rm(dir,{recursive:true,force:true});}});

test('same native WeChat rows in import/live order keep one identity, preserve both raw sources and isolate real conflicts',async()=>{
 const {parseWechatHistory}=await import('../src/adapters/wechat.ts');
 for(const order of ['import-first','live-first']){
 const f=await fixture();try{
 const path=join(f.root,'wire.jsonl');const row={server_id:'9223372036854775807',local_id:'9007199254740995',sender_wxid:'self-synthetic',message_kind:'text',message_content:'same verified synthetic native message',create_time:1790769600,timestamp:'2026-09-30T14:00:00+02:00'};await writeFile(path,JSON.stringify(row)+'\n');
 const provider={schema_version:1 as const,provider:'wechat',enabled:true,roots:[],account_id:'account-synthetic',options:{identity_verified:true,self_ids:['self-synthetic'],cursor_readonly_verified:true}};
 const request={lane:'live' as const,cutoff:range.to,range,budget:{max_duration_ms:1000,max_bytes:10000,max_directory_entries:10}};
 const live=parseWechatHistory(JSON.stringify({meta:{status:'ok',since_resolved:Date.parse(range.from)/1000,until_resolved:Date.parse(range.to)/1000,shards_scanned:1,shards_hit:1},rows:[row]}),provider,'chat-synthetic',request,f.config).events;
 assert.equal(live.length,1);
 const liveRaw=Buffer.from(JSON.stringify({rows:[row]})),liveFragment={schema_version:1 as const,fragment_id:'synthetic-live-fragment-'+order,locator:'/synthetic/live',bytes_base64:liveRaw.toString('base64'),sha256:hash(liveRaw)};live[0].fragment_ref=liveFragment.fragment_id;const batch={schema_version:1 as const,batch_id:'native-live-'+order,events:live,fragments:[liveFragment],coverage:[],checkpoints:[]};const service=createMigrationService(f.store,f.config);
 const imported=()=>service.importManifest(manifest([importEntry(path,{time_source:'timestamp'})]));
 if(order==='import-first'){await imported();await f.store.saveCollection(batch);}else{await f.store.saveCollection(batch);await imported();}
 assert.equal((await f.store.status()).events,1);assert.equal((await f.store.listWork('event_conflict')).length,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM fragments').get()!.count,2);
 const events=await f.store.listEvents({range,include_context:true});assert.equal(events[0].source.message_id,row.server_id);assert(events[0].fragment_ref);
 const conflicting={...live[0],body:'changed real body'};await f.store.saveCollection({...batch,batch_id:'native-real-conflict-'+order,events:[conflicting]});assert.equal((await f.store.listWork('event_conflict')).length,1);assert.equal((await f.store.status()).events,1);
 const localPath=join(f.root,'local.jsonl');await writeFile(localPath,JSON.stringify({...row,server_id:'0',local_id:'9223372036854775805'})+'\n');await service.importManifest(manifest([importEntry(localPath,{time_source:'create_time',source_file_id:'sealed:local'})]));assert((await f.store.listEvents({range,include_context:true})).some(e=>e.source.message_id==='local:9223372036854775805'));
 }finally{f.store.close();await rm(f.root,{recursive:true,force:true});}
 }
});

test('collection failure cannot leave imported fragments/events or advance import checkpoint',async()=>{
 const f=await fixture();try{
 const path=join(f.root,'failure.jsonl');await writeFile(path,JSON.stringify({id:'atomic',sender:'self-synthetic',timestamp:'2026-09-30T12:00:00Z',text:'synthetic transactional row'})+'\n');f.store.close();
 const {SqliteStore}=await import('../src/store/index.ts');let fail=true;const store=new SqliteStore(join(f.config.data_dir,'bookkeeping.sqlite'),{onTransactionStep(step){if(fail&&step==='collection_events')throw new Error('synthetic injected failure');}});
 try{const service=createMigrationService(store,f.config);const first=await service.importManifest(manifest([importEntry(path)]));assert(first.entries[0].pending.includes('record_persistence_or_mapping_conflict'));assert.equal((await store.status()).events,0);assert.equal((await store.getCheckpoints('migration','history')).length,0);assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM fragments').get()!.count,0);fail=false;await service.importManifest(manifest([importEntry(path)]));assert.equal((await store.status()).events,1);assert.equal((await store.getCheckpoints('migration','history')).length,1);}finally{store.close();}
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('relocated immutable archive keeps fact IDs and duplicate/unsupported old lines do not block valid records',async()=>{
 const f=await fixture();try{
 const path=join(f.root,'daily_2026.jsonl'),moved=join(f.root,'moved.jsonl');const valid={schema_version:'daily-journal-jsonl-v1',id:'daily:2026-09-29',date:'2026-09-29',sections:{activity:['synthetic']}};await writeFile(path,JSON.stringify({...valid,date:'2026-02-30',id:'daily:2026-02-30'})+'\n'+JSON.stringify(valid)+'\n');const entry={kind:'daily_journal',format:'jsonl',path,source_file_id:'sha256:sealed-moved-test',recorded_at:at};const service=createMigrationService(f.store,f.config);const r=await service.migrateManifest(manifest([entry],'migration'));assert(r.entries[0].pending.includes('unsupported_daily_archive_record'));assert.equal((await f.store.readEffectiveFacts({range})).length,1);await writeFile(moved,await readFile(path));const movedReport=await service.migrateManifest(manifest([{...entry,path:moved}],'migration'));assert(!movedReport.entries[0].pending.includes('record_persistence_or_mapping_conflict'));assert.equal((await f.store.readEffectiveFacts({range})).length,1);
 }finally{f.store.close();await rm(f.root,{recursive:true,force:true});}
});

test('JSON streaming detects missing separators and malformed outer tail rather than certifying EOF',async()=>{const dir=await mkdtemp(join(tmpdir(),'bookkeeping-migration-syntax-test-'));try{for(const [name,bytes]of [['comma','[{"id":"a"}{"id":"b"}]'],['tail','{"messages":[{"id":"a"}]']]){const path=join(dir,name+'.json');await writeFile(path,bytes);const reader=new DataReader(path,'json',{max_bytes:10000,max_record_bytes:1000,max_records:10,max_duration_ms:1000});let n=0;for await(const frame of reader.frames())n++;assert.equal(n,1);assert.equal(reader.finished,false);assert(reader.pending.includes('invalid_truncated_or_unavailable_input'));}}finally{await rm(dir,{recursive:true,force:true});}});

test('group export never treats all other participants as activity and explicit unknown group keeps pending',async()=>{
 const f=await fixture();try{
 const path=join(f.root,'group.jsonl');const messages=[{id:'outside',sender_wxid:'other-synthetic',timestamp:'2026-09-30T10:00:00Z',message_kind:'text',message_content:'outside participation'},{id:'before',sender_wxid:'other-synthetic',timestamp:'2026-09-30T11:50:00Z',message_kind:'text',message_content:'near preceding context'},{id:'anchor',sender_wxid:'self-synthetic',timestamp:'2026-09-30T12:00:00Z',message_kind:'text',message_content:'self participation'},{id:'after',sender_wxid:'other-synthetic',timestamp:'2026-09-30T12:10:00Z',message_kind:'text',message_content:'near following context'}];await writeFile(path,messages.map(v=>JSON.stringify(v)).join('\n')+'\n');
 const report=await createMigrationService(f.store,f.config).importManifest(manifest([importEntry(path,{conversation_id:'synthetic@chatroom',source_file_id:'sealed:group'})]));assert(report.entries[0].pending.includes('import_group_participation_window_pending'));const active=await f.store.listEvents({range});assert.deepEqual(active.map(v=>v.source.message_id),['anchor']);const all=await f.store.listEvents({range,include_context:true});assert.equal(all.length,4);assert(all.filter(v=>v.source.message_id!=='anchor').every(v=>v.context.context_only===true));
 const context=f.store.getContextEvents(active[0]);assert(!context.some(v=>v.source.message_id==='outside'));assert(context.some(v=>v.source.message_id==='before'));assert(context.some(v=>v.source.message_id==='after'));
 const unknown=await createMigrationService(f.store,f.config).importManifest(manifest([importEntry(path,{conversation_id:'explicit-unknown-group',conversation_type:'unknown',source_file_id:'sealed:unknown-group',identity_verified:false})]));assert(unknown.entries[0].pending.includes('import_self_identity_unverified'));assert.equal((await f.store.listEvents({range})).length,1);
 }finally{f.store.close();await rm(f.root,{recursive:true,force:true});}
});

test('source events outside requested live range are context until explicit in-range parser evidence releases them',async()=>{
 const {parseWechatHistory}=await import('../src/adapters/wechat.ts');const {parseChatExport}=await import('../src/adapters/imports.ts');const f=await fixture();try{
 const row={server_id:'known-context-id',sender_wxid:'self-synthetic',message_kind:'text',message_content:'synthetic context later in requested range',create_time:1790769600};const provider={schema_version:1 as const,provider:'wechat',enabled:true,roots:[],account_id:'account-synthetic',options:{identity_verified:true,self_ids:['self-synthetic']}};
 const narrow={schema_version:1 as const,from:'2026-09-30T12:01:00Z',to:'2026-09-30T13:00:00Z'};const imported=parseChatExport(JSON.stringify({...row,timestamp:'2026-09-30T14:00:00+02:00'})+'\n','legacy-jsonl',{account_id:'account-synthetic',conversation_id:'chat-synthetic',owner_id:'self-synthetic',identity_verified:true,source_timezone:'Europe/Amsterdam',known_range:narrow,locator:'/synthetic/export'},f.config).events;
 assert.equal(imported[0].context.context_only,true);await f.store.saveCollection({schema_version:1,batch_id:'outside-context',events:imported,fragments:[],coverage:[],checkpoints:[]});assert.equal((await f.store.listEvents({range})).length,0);
 const live=parseWechatHistory(JSON.stringify({meta:{status:'ok',since_resolved:Date.parse(range.from)/1000,until_resolved:Date.parse(range.to)/1000},rows:[row]}),provider,'chat-synthetic',{lane:'live',cutoff:range.to,range,budget:{max_duration_ms:1000,max_bytes:10000,max_directory_entries:10}},f.config).events;assert.equal(live[0].context.context_only,false);await f.store.saveCollection({schema_version:1,batch_id:'in-range-context-release',events:live,fragments:[],coverage:[],checkpoints:[]});assert.equal((await f.store.listWork('event_conflict')).length,0);assert.equal((await f.store.listEvents({range})).length,1);
 }finally{f.store.close();await rm(f.root,{recursive:true,force:true});}
});
