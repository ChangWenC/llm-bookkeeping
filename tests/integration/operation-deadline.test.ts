import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createStore } from '../../src/store/index.ts';
import { createPublisher } from '../../src/publish/index.ts';
import { createIndexConsumer, runPublicCommand } from '../../src/consumers/index/index.ts';
import { config, bundle, result, collection } from '../store/fixtures.ts';

test('cooperative publication finishes started atomic file but begins no next file/export after deadline and leaves no background writer', async t=>{
 const c=await config();t.after(()=>rm(dirname(c.wiki_root),{recursive:true,force:true}));
 const store=await createStore(c);t.after(()=>store.close());
 const b=bundle(),r=result(b);r.pages=[...r.pages,{...r.pages[0],suggestion_id:'page:peer',path:'wiki/projects/项目_peer.md'}];
 b.baselines.push({schema_version:1,path:'wiki/projects/项目_peer.md',digest:'absent',content:null});
 await store.saveCollection(collection());await store.saveBundle(b);
 let remaining=100;const publisher=createPublisher(store,c,{now:()=>new Date('2026-10-06T12:00:00Z'),remaining_ms:()=>remaining,fault(stage){if(stage==='after_file_registered')remaining=0;}});
 const published=await publisher.publish(r);assert.equal(published.files[0].status,'applied');assert.equal(published.files[1].status,'pending');
 assert.equal(await store.getFileIntent((await store.listPendingPatches())[0].operation_id),null);
 await publisher.resume();await new Promise(resolve=>setTimeout(resolve,20));
 await assert.rejects(readFile(join(c.wiki_root,'wiki/projects/项目_peer.md')),/ENOENT/);
 assert.ok((await store.listPendingPatches()).length);assert.ok(published.pending.length);
});

test('index runner receives remaining timeout and stops later stages with work unacknowledged', async t=>{
 const c=await config();t.after(()=>rm(dirname(c.wiki_root),{recursive:true,force:true}));const store=await createStore(c);t.after(()=>store.close());
 await store.enqueueWork({schema_version:1,work_id:'index:deadline',kind:'index',lane:'live',state:'pending',payload:{path:'log.md'},reason:null,migration_key:null,updated_at:'2026-10-06T12:00:00Z'});
 let remaining=50,calls=0;
 const consumer=createIndexConsumer(store,c,{remaining_ms:()=>remaining,runner:async command=>{calls++;assert.equal(command.timeout_ms,50);assert.equal(command.kill_grace_ms,0);remaining=0;return{exit_code:0,stdout:JSON.stringify({report_contract_version:1,capabilities:['daily-journal-archive-target-v2'],generated_at:'2026-10-13T10:00:00Z',counts:{pages:1,errors:0,warnings:0,suggestions:0},errors:[],warnings:[],suggestions:[],disabled_checks:[],tag_source_report:{},synthesis_candidates:[]}),stderr:''};}});
 const outcome=await consumer.consume();assert.equal(outcome.status,'pending');assert.equal(calls,1);assert.equal((await store.listWork('index','pending')).length,1);
});

test('timed out public subprocess is awaited through close and is no longer alive',async t=>{
 const c=await config();t.after(()=>rm(dirname(c.wiki_root),{recursive:true,force:true}));
 const output=await runPublicCommand({executable:process.execPath,args:['-e','process.stdout.write(String(process.pid));process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],timeout_ms:1000,kill_grace_ms:0},{wiki_root:c.wiki_root,paths:[]});
 assert.notEqual(output.exit_code,0);assert.match(output.stderr,/terminated/);const pid=Number(output.stdout);assert.ok(pid>0);assert.throws(()=>process.kill(pid,0),/ESRCH/);
});
