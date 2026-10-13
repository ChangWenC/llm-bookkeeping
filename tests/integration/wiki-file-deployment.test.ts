import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { applyWikiFiles } from '../../tools/apply-wiki-files.ts';
import { createStore } from '../../src/store/index.ts';
import { digestBytes, acquireWikiLock } from '../../src/publish/index.ts';
import { config as fixtureConfig } from '../store/fixtures.ts';

test('coordinator Wiki deployment uses shared lock, exact full backup/noop/conflict and only file intents/index',async t=>{
 const config=await fixtureConfig(),store=await createStore(config),path='schemas/daily_bookkeeping.md',original=Buffer.from('# Synthetic original\n\n完整旧正文。\n'),desired=Buffer.from('# Synthetic new rule\n\n完整新正文。\n');
 t.after(async()=>{store.close();await rm(dirname(config.wiki_root),{recursive:true,force:true});});await mkdir(dirname(join(config.wiki_root,path)),{recursive:true});await writeFile(join(config.wiki_root,path),original);
 const input={schema_version:1,files:[{schema_version:1,operation_id:'deploy:synthetic-rule:v1',path,baseline_digest:digestBytes(original),desired_bytes_base64:desired.toString('base64')},{schema_version:1,operation_id:'deploy:synthetic-version:v1',path:'VERSION',baseline_digest:'absent',desired_bytes_base64:Buffer.from('synthetic-version\n').toString('base64')}]};
 const semantic=()=>['facts','results','outbox','reviewed_units','reviewed_spans','reviewed_sources'].map(table=>store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);const before=semantic();
 const busy=await acquireWikiLock(config.wiki_root);assert.ok(busy);try{const pending=await applyWikiFiles(input,store,config);assert.ok(pending.files.every(file=>file.status==='pending'));assert.equal((await store.listFileIntents()).length,0);}finally{await busy.release();}
 const applied=await applyWikiFiles(input,store,config,()=>new Date('2026-10-06T12:00:00Z'));assert.ok(applied.files.every(file=>file.status==='applied'));assert.deepEqual(await readFile(join(config.wiki_root,path)),desired);
 const intent=await store.getFileIntent(input.files[0].operation_id);assert.deepEqual(Buffer.from(intent!.backup_bytes_base64!,'base64'),original);assert.deepEqual(intent!.fact_refs,[]);assert.deepEqual(semantic(),before);assert.equal((await store.listWork('index','pending')).length,2);
 assert.ok((await applyWikiFiles(input,store,config)).files.every(file=>file.status==='noop'));
 await writeFile(join(config.wiki_root,path),'Manual later edit\n');const conflict=await applyWikiFiles({...input,files:[{...input.files[0],operation_id:'deploy:synthetic-rule:v2'}]},store,config);assert.equal(conflict.files[0].status,'conflict');assert.equal(await readFile(join(config.wiki_root,path),'utf8'),'Manual later edit\n');assert.deepEqual(semantic(),before);
 const draft=join(dirname(config.wiki_root),'full-private-draft.md');await writeFile(draft,desired);const fileInput={schema_version:1,files:[{schema_version:1,operation_id:'deploy:synthetic-file-input',path:'schemas/deployment-log.md',baseline_digest:'absent',desired_file:draft}]};assert.equal((await applyWikiFiles(fileInput,store,config)).files[0].status,'applied');assert.deepEqual(await readFile(join(config.wiki_root,'schemas/deployment-log.md')),desired);assert.deepEqual(semantic(),before);
});
