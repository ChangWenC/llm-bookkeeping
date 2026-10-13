import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,appendFile,readFile,rm} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {runCli} from '../../src/cli.ts';
import {createStore} from '../../src/store/index.ts';
import {createReviewer} from '../../src/review/index.ts';
import {parseCapturedLines} from '../../src/adapters/file-reader.ts';
import {config as cfg,event,collection} from '../store/fixtures.ts';
import type {BookkeepingConfig,ReviewBundle} from '../../src/contracts/types.ts';
const cutoff='2026-10-06T12:00:00.000Z';
async function fixture(t:test.TestContext,provider:string){const config=await cfg(),root=dirname(config.wiki_root);t.after(()=>rm(root,{recursive:true,force:true}));config.providers=[{schema_version:1,provider,enabled:true,account_id:'9007199254740993',roots:[],options:{}}];config.journal_timezone_timeline=[{schema_version:1,effective_from:'1970-01-01T00:00:00Z',timezone:'Europe/Amsterdam',basis:'synthetic'}];return {config,root};}
async function cli(config:BookkeepingConfig,path:string,args:string[],expected=0){let out='',err='';await writeFile(path,JSON.stringify(config));const code=await runCli([...args,'--config',path],{now:()=>cutoff,stdout:s=>out+=s,stderr:s=>err+=s});assert.equal(code,expected,err);return JSON.parse(out);}
const claudeRow=(stop:string|null)=>({type:'assistant',sessionId:'synthetic-main',uuid:'synthetic-row',timestamp:'2026-10-05T09:00:00Z',message:{id:'same-native-message',role:'assistant',content:[{type:'text',text:'Synthetic immutable professional verification'}],stop_reason:stop}});
test('actual CLI captures appended Claude completion without another event and exposes it for semantic review',async t=>{
 const {config,root}=await fixture(t,'claude'),source=join(root,'source');await mkdir(source);config.providers[0].roots=[source];const path=join(source,'session.jsonl'),configPath=join(root,'config.json');
 await writeFile(path,JSON.stringify(claudeRow(null))+'\n');await cli(config,configPath,['collect','--lane','live','--cutoff',cutoff]);
 const first=await cli(config,configPath,['prepare','--kind','daily','--lane','live','--source','claude','--cutoff',cutoff,'--output',join(root,'before')]);assert.equal(first.bundles.length,0);
 await appendFile(path,JSON.stringify(claudeRow('end_turn'))+'\n');await cli(config,configPath,['collect','--lane','live','--cutoff',cutoff]);
 const prepared=await cli(config,configPath,['prepare','--kind','daily','--lane','live','--source','claude','--cutoff',cutoff,'--output',join(root,'after')]);assert.equal(prepared.bundles.length,1);
 const b:ReviewBundle=JSON.parse(await readFile(join(prepared.output_dir,prepared.bundles[0]),'utf8'));assert.equal(b.chunks.flatMap(c=>c.events).length,1);assert.equal(b.chunks[0].events[0].context.turn_complete,true);
 const store=await createStore(config);try{assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM events').get()!.n,1);assert.ok(Number(store.db.prepare('SELECT COUNT(*) AS n FROM fragments').get()!.n)>1);}finally{store.close();}
});
test('event-time explicit history scope reaches live-only old event while omitted legacy basis retains lane filtering',async t=>{
 const {config,root}=await fixture(t,'codex'),e=event('live-only-old','Synthetic old material','2026-10-03T09:00:00.000Z');e.source.provider='codex';const store=await createStore(config);await store.saveCollection({...collection([e],'live','live-only'),coverage:[],checkpoints:[]});store.close();const configPath=join(root,'config.json');
 const args=['prepare','--kind','daily','--lane','history','--source','codex','--from','2026-10-02T22:00:00Z','--to','2026-10-03T22:00:00Z','--cutoff',cutoff];
 const legacy=await cli(config,configPath,[...args,'--output',join(root,'legacy')]);assert.equal(legacy.selection_basis,'capture_lane');assert.equal(legacy.bundles.length,0);
 const selected=await cli(config,configPath,[...args,'--selection-basis','event_time','--output',join(root,'by-time')]);assert.equal(selected.selection_basis,'event_time');assert.equal(selected.bundles.length,1);const b:ReviewBundle=JSON.parse(await readFile(join(selected.output_dir,selected.bundles[0]),'utf8'));assert.equal(b.chunks[0].events[0].event_id,e.event_id);
});
test('oversized metadata prefix and a finite automation page do not exhaust healthy suffixes in actual SQLite preparation',async t=>{
 const {config}=await fixture(t,'codex');config.limits.chunk_events=1;const store=await createStore(config);t.after(()=>store.close());
 const big=event('oversized','Synthetic body','2026-10-05T08:00:00Z');big.source.provider='codex';big.context={synthetic:'m'.repeat(200*1024)};await store.saveCollection({...collection([big],'live','large'),coverage:[],checkpoints:[]});
 const packet='<heartbeat><automation_id>synthetic-repair</automation_id><current_time_iso>2026-10-05T09:00:00Z</current_time_iso><instructions>Synthetic</instructions></heartbeat>';
 const rows=[...Array.from({length:321},(_,i)=>({type:'response_item',timestamp:'2026-10-05T09:00:00Z',payload:{type:'message',id:`automation:${i}`,role:'user',content:[{type:'input_text',text:packet}],turn_id:`turn:${i}`}})),{type:'response_item',timestamp:'2026-10-05T10:00:00Z',payload:{type:'message',id:'human-suffix',role:'user',content:[{type:'input_text',text:'Synthetic human after finite filtered prefix'}],turn_id:'human'}}];
 const bytes=Buffer.from(rows.map(row=>JSON.stringify(row)+'\n').join(''));
 const parsed=parseCapturedLines({provider:'codex',account:config.providers[0].account_id,identity:{id:'synthetic-main',classification:'main',cwd:null,metadata:{}},locator:'/synthetic/session.jsonl',generation:'one',buffer:bytes,read_start:0,slice_start:0,consumed:bytes.length,state:{},known_events:new Set(),config});
 // Synthetic current-schema fixture emulates pre-reconciliation metadata only.
 await store.saveCollection({...collection(parsed.events.map(source=>{const context={...source.context};delete context.automation_origin;return {...source,classification:'main' as const,context};}),'live','prefix'),fragments:parsed.fragments,coverage:[],checkpoints:[]});
 const reviewer=createReviewer(store,config);let continuation;let found=false;
 for(let i=0;i<4&&!found;i++){
  const prepared=await reviewer.prepareWithOutcomes!({kind:'daily',lane:'live',source:'codex',cutoff,max_bundles:1,candidate_continuation:continuation});
  const state=prepared.providers[0].preparation!;assert.ok(state.scanned.pages<=5);assert.ok(state.scanned.rows<=1600);
  found=prepared.bundles.some(b=>b.chunks.some(c=>c.events.some(e=>e.source.message_id==='human-suffix')));
  if(!found)assert.equal(state.state,'more');continuation=state.continuation??undefined;
 }
 assert.equal(found,true);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM reviewed_sources').get()!.n,0,'Scanning is not semantic completion');assert.ok(Number(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE classification='automation'").get()!.n)>=321);
});
