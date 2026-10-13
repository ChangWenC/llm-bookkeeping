import {journalBodyBlocks} from '../../src/store/journal-assessment.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runCli } from '../../src/cli.ts';
import { createStore } from '../../src/store/index.ts';
import { inspectReviewMaterial, readReviewMaterial } from '../../src/review-material-inspection.ts';
import { createPublisher } from '../../src/publish/index.ts';
import { createRuntime } from '../../src/runtime.ts';
import { config as fixtureConfig, collection, bundle, result, event } from '../store/fixtures.ts';

const asOf = '2026-10-06T12:00:00Z';
const assessment=(material:any,path:string,body='')=>{
 const baseline=material.baselines.find((page:any)=>page.path===path),content=baseline.content??'',blocks=journalBodyBlocks(content),selected=body?blocks.filter(block=>block.text.includes(body)):blocks;
 const dimensions={subject:'consistent',action:'consistent',time:'not_applicable',result:'consistent',negation:'consistent'};
 return {schema_version:1,baseline_digest:baseline.digest,summary_text:content.match(/^summary:[ \t]*(.*)$/m)?.[1]??null,body_evidence_text:selected.map(block=>block.text).join('\n\n'),consistency:'consistent',summary_consistency:'consistent',body_consistency:'consistent',relation:'new',summary_dimensions:dimensions,body_evidence:selected.map(block=>({...block,dimensions})),reason:'Synthetic explicit full summary/body consistency review'};
};
async function fixture(t: test.TestContext) {
 const config = await fixtureConfig(),root=dirname(config.wiki_root),path=join(root,'config.json');
 config.providers=[];config.journal_timezone_timeline=[{schema_version:1,effective_from:'1970-01-01T00:00:00Z',timezone:'Europe/Amsterdam',basis:'synthetic'}];
 await writeFile(path,JSON.stringify(config));
 const cli=async(args:string[],expected=0)=>{let out='',err='';const code=await runCli([...args,'--config',path],{now:()=>asOf,stdout:s=>{out+=s;},stderr:s=>{err+=s;}});assert.equal(code,expected,err);return JSON.parse(out);};
 const store=await createStore(config,{now:()=>new Date(asOf)});
 const material=bundle([event('accepted-old-business','Synthetic accepted original','2026-09-15T09:00:00Z')]);material.source='synthetic';
 const review=result(material);review.created_at='2026-01-01T10:00:00Z';review.pages=[];
 review.candidates[0].journal_date.value='2026-09-15';review.candidates[0].occurred_at.value='2026-09-15T09:00:00Z';
 await store.saveCollection(collection(material.chunks[0].events));await store.saveBundle(material);await store.commitReview(review);
 t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
 return {config,root,path,store,cli,review};
}

test('journal accepted-time inventory pages full old-business revisions, includes unknown legacy acceptance and explicit recovery IDs',async t=>{
 const f=await fixture(t);
 let receipt=await f.cli(['journal-inventory','--from','2026-10-01T22:00:00Z','--to','2026-10-07T00:00:00Z','--limit','1','--output',join(f.root,'inventory')]);
 assert.deepEqual(receipt.result_ids,[f.review.result_id]);assert.equal(receipt.unknown_acceptance,0);
 const inventory:any=await readReviewMaterial(receipt.file);assert.equal(inventory.items[0].result_created_at,'2026-01-01T10:00:00Z');assert.equal(inventory.items[0].facts[0].journal_date.value,'2026-09-15');
 assert.equal(inspectReviewMaterial(inventory,'facts',0,1).items[0].content,'You verified the parser.');
 // A synthetic pre-acceptance-clock database record: unknown time is never a model timestamp filter.
 f.store.db.prepare('DELETE FROM acceptance_times WHERE result_id=?').run(f.review.result_id);
 receipt=await f.cli(['journal-inventory','--from','2026-10-01T22:00:00Z','--to','2026-10-07T00:00:00Z','--output',join(f.root,'legacy-inventory')]);assert.equal(receipt.unknown_acceptance,1);
 const recovery=join(f.root,'recovery.json');await writeFile(recovery,JSON.stringify({schema_version:1,result_ids:[f.review.result_id]}));
 const recovered=await f.cli(['journal-recover','--input',recovery]);assert.deepEqual(recovered.result_ids,[f.review.result_id]);assert.ok(recovered.work_ids.length);
 assert.deepEqual((await f.cli(['journal-recover','--input',recovery])).work_ids,recovered.work_ids);
 const status=await f.cli(['status']);assert.ok(status.journal_publication.pending>0);assert.ok('facts' in status || 'fact_count' in status || status.stages);
});

test('journal CLI resolves accepted facts on current baselines without second facts/results/outbox; inspection preserves full text',async t=>{
 const f=await fixture(t); const work=(await f.store.listWork('journal_publication')).filter(w=>w.state!=='complete');
 const selected=join(f.root,'work.json');await writeFile(selected,JSON.stringify({schema_version:1,work_ids:work.map(w=>w.work_id)}));
 const prepared=await f.cli(['journal-prepare','--work',selected,'--output',join(f.root,'journal'),'--cutoff',asOf]);
 const material:any=await readReviewMaterial(prepared.file);assert.equal(material.facts.length,1);
 const inspected=inspectReviewMaterial(material,'work',0,1);assert.equal(inspected.items[0].work_id,work[0].work_id);
 const resolution=join(f.root,'resolution.json');
 const page=material.baselines[0],item=material.work[0];
 await writeFile(resolution,JSON.stringify({schema_version:1,resolution_id:'journal-resolution:synthetic',journal_bundle_id:material.journal_bundle_id,created_at:asOf,
  dispositions:[{schema_version:1,work_id:item.work_id,disposition:'patch',suggestion_id:'page',reason:null}],
  pages:[{schema_version:1,suggestion_id:'page',work_ids:[item.work_id],date:item.payload.date,path:page.path,baseline_digest:page.digest,mode:'append',old_text:null,new_text:'# 合成既有事实日记\n\nYou verified the parser.\n'}]}));
 const counts=()=>['facts','results','outbox'].map(table=>f.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
 const before=counts();const published=await f.cli(['journal-resolve','--input',resolution]);assert.ok(published.files.every((o:any)=>['applied','noop'].includes(o.status)));assert.deepEqual(counts(),before);
 assert.match(await readFile(join(f.config.wiki_root,page.path),'utf8'),/You verified the parser/);
 await f.cli(['journal-resolve','--input',resolution]);assert.deepEqual(counts(),before);
 const status=await f.cli(['status']);assert.equal(status.journal_publication.pending,0);assert.equal(status.journal_publication.conflict,0);
});

test('already_present requires exact frozen evidence and is invalid after a current manual edit',async t=>{
 const f=await fixture(t);const work=(await f.store.listWork('journal_publication'))[0]; const path=work.payload.path as string;
 const text='# 人工页\n完整已有合成事实。\n'+ 's'.repeat(1000)+'\n尾部完整。\n';await mkdir(dirname(join(f.config.wiki_root,path)),{recursive:true});await writeFile(join(f.config.wiki_root,path),text);
 const prepared=await f.cli(['journal-prepare','--output',join(f.root,'journal'),'--cutoff',asOf]); const material:any=await readReviewMaterial(prepared.file);
 const inspected=inspectReviewMaterial(material,'baselines',0,1);assert.equal(inspected.items[0].content,text);
 const resolution=join(f.root,'evidence.json'); const value={schema_version:1,resolution_id:'present:synthetic',journal_bundle_id:material.journal_bundle_id,created_at:asOf,pages:[],dispositions:[{schema_version:1,work_id:work.work_id,disposition:'already_present',reason:'Exact existing synthetic statement',evidence_text:assessment(material,path,'完整已有合成事实。').body_evidence_text,baseline_assessment:assessment(material,path,'完整已有合成事实。')}]};
 await writeFile(resolution,JSON.stringify(value));await writeFile(join(f.config.wiki_root,path),text+'人工后来修改。\n');
 const failed=await f.cli(['journal-resolve','--input',resolution],1);assert.match(failed.error.message,/baseline changed/);assert.equal((await f.store.listWork('journal_publication'))[0].state,'pending');
 const refreshed=await f.cli(['journal-prepare','--output',join(f.root,'refreshed'),'--cutoff',asOf]);value.journal_bundle_id=refreshed.journal_bundle_id;value.dispositions[0].baseline_assessment=assessment(await readReviewMaterial(refreshed.file),path,'完整已有合成事实。');value.dispositions[0].evidence_text=value.dispositions[0].baseline_assessment.body_evidence_text;await writeFile(resolution,JSON.stringify(value));await f.cli(['journal-resolve','--input',resolution]);assert.equal((await f.store.listWork('journal_publication'))[0].state,'complete');
});

test('journal resolution closes accepted debt before compatible old monthly-display payload resume, without duplicate semantic state',async t=>{
 const f=await fixture(t);await createPublisher(f.store,f.config,{now:()=>new Date(asOf)}).exportFacts();const batch=(await f.store.listReadyBatches('monthly-display'))[0],id=`monthly_display:${batch.batch_id}:2026-09`;
 const old={schema_version:1 as const,work_id:id,kind:'monthly_display',lane:'live' as const,state:'pending' as const,payload:{month:'2026-09',batch_id:batch.batch_id},reason:null,migration_key:null,updated_at:asOf};await f.store.enqueueWork(old);
 const prepared=await f.cli(['journal-prepare','--output',join(f.root,'compat-journal'),'--cutoff',asOf]);const material:any=await readReviewMaterial(prepared.file),input=join(f.root,'compat-resolution.json');
 await writeFile(input,JSON.stringify({schema_version:1,resolution_id:'compat:terminal-resolution',journal_bundle_id:prepared.journal_bundle_id,created_at:asOf,pages:[],dispositions:material.work.map((work:any)=>({schema_version:1,work_id:work.work_id,disposition:'not_needed',baseline_assessment:assessment(material,work.payload.path as string),reason:'Explicit synthetic editorial decision: accepted activity needs no additional journal prose'}))}));
 const counts=()=>['facts','results','outbox'].map(table=>f.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n),before=counts();const receipt=await f.cli(['journal-resolve','--input',input]);assert.equal(receipt.resolution_id,'compat:terminal-resolution');assert.deepEqual(counts(),before);assert.equal((await f.store.listWork('journal_publication','pending')).length,0);assert.deepEqual((await f.store.listWork('monthly_display')).find(work=>work.work_id===id)!.payload,old.payload);
 await f.cli(['journal-resolve','--input',input]);assert.deepEqual(counts(),before);
});

test('journal continuation failure returns committed resolution and file-stage receipt instead of implying rollback',async t=>{
 const f=await fixture(t),prepared=await f.cli(['journal-prepare','--output',join(f.root,'stage-journal'),'--cutoff',asOf]);const material:any=await readReviewMaterial(prepared.file),input=join(f.root,'stage-resolution.json');
 await writeFile(input,JSON.stringify({schema_version:1,resolution_id:'stage:accepted-resolution',journal_bundle_id:prepared.journal_bundle_id,created_at:asOf,pages:[],dispositions:material.work.map((work:any)=>({schema_version:1,work_id:work.work_id,disposition:'not_needed',baseline_assessment:assessment(material,work.payload.path as string),reason:'Synthetic editorial reason'}))}));
 let out='';const code=await runCli(['journal-resolve','--input',input,'--config',f.path],{now:()=>asOf,stdout:s=>{out+=s;},stderr:()=>{},createRuntime:async(config,command,options,now)=>{const services=await createRuntime(config,command,options,now);services.publisher.resume=async()=>{throw new Error('Synthetic downstream work identity conflict');};return services;}});
 assert.equal(code,1);const failed=JSON.parse(out);assert.equal(failed.receipt.resolution_commit,'committed');assert.equal(failed.receipt.resolution_id,'stage:accepted-resolution');assert.equal(failed.receipt.continuation.stage,'resume');assert.deepEqual(failed.receipt.files,[]);assert.equal(failed.receipt.publication,null);assert.equal((await f.store.listWork('journal_publication','pending')).length,0);assert.ok(f.store.db.prepare('SELECT 1 FROM journal_resolutions WHERE id=?').get('stage:accepted-resolution'));
});
