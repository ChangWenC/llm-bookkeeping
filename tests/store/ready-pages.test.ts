import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../src/store/index.ts';
import { parseArgs, executeCommand } from '../../src/cli.ts';
import { config, event, collection, bundle, result } from './fixtures.ts';

test('ready batch pages are bounded in durable insertion order and isolate each consumer acknowledgement', async () => {
 const c=await config(),s=await createStore(c),ids:string[]=[];
 try {
  for(let i=0;i<3;i++) {
   const e=event('source:'+i),b=bundle([e],'bundle:'+i);await s.saveCollection(collection([e],'live','capture:'+i));await s.saveBundle(b);
   const accepted=await s.commitReview(result(b,'result:'+i));ids.push(accepted.batch_id);await s.markExportReady(accepted.batch_id,'/synthetic/'+accepted.batch_id);
  }
  await s.acknowledgeConsumer({schema_version:1,consumer:'evidence',batch_id:ids[1],acknowledged_at:'2026-09-30T12:00:00Z'});
  assert.deepEqual((await s.listReadyBatches('evidence',1)).map(b=>b.batch_id),[ids[0]]);
  assert.deepEqual((await s.listReadyBatches('evidence',1,ids[0])).map(b=>b.batch_id),[ids[2]]);
  assert.deepEqual(await s.listReadyBatches('evidence',1,ids[2]),[]);
  assert.deepEqual((await s.listReadyBatches('evidence',1,'missing-cursor')).map(b=>b.batch_id),[ids[0]]);
  assert.equal((await s.listReadyBatches('analytics')).length,3);
  for(const invalid of [0,-1,1.5,Infinity,Number.MAX_SAFE_INTEGER+1])await assert.rejects(s.listReadyBatches('evidence',invalid),/positive safe integer/);
 } finally {s.close();}
});

test('evidence CLI route and all dispatch reach the independent consumer after Analytics', async () => {
 const calls:string[]=[];const c=await config();
 const services:any={consumers:['analytics','monthly','index','evidence'].map(target=>({target,consume:async()=>{calls.push(target);return {schema_version:1,target,status:'complete',processed:0,pending:[]};}}))};
 await executeCommand(parseArgs(['consume','--target','evidence']),c,services,'2026-09-30T12:00:00Z');assert.deepEqual(calls,['evidence']);calls.length=0;
 await executeCommand(parseArgs(['consume','--target','all']),c,services,'2026-09-30T12:00:00Z');assert.deepEqual(calls,['analytics','monthly','index','evidence']);
});
