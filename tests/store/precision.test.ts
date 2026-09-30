import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runCli, parseArgs } from '../../src/cli.ts';
import { validateCoverage, validateSourceEvent } from '../../src/contracts/validation.ts';
import { createStore } from '../../src/store/index.ts';
import { createReviewer } from '../../src/review/index.ts';
import { createPublisher } from '../../src/publish/index.ts';
import { config, event, collection, result, value } from './fixtures.ts';

test('nanosecond source and coverage survive actual prepare, semantic export and CLI half-open facts ranges', async () => {
 const c=await config();c.journal_timezone_timeline=[{schema_version:1,effective_from:'1970-01-01T00:00:00Z',timezone:c.journal_timezone,basis:'synthetic'}];
 const from='2026-09-30T09:00:00.123456789Z',to='2026-09-30T09:00:00.123456790Z';
 const e=event('nano-native','Synthetic precision verification',from);e.time_precision='nanosecond';validateSourceEvent(e);
 const batch=collection([e]);batch.coverage[0].query_range={schema_version:1,from,to};batch.coverage[0].read_ranges=[batch.coverage[0].query_range];validateCoverage(batch.coverage[0]);
 assert.throws(()=>validateCoverage({...batch.coverage[0],query_range:{schema_version:1,from:to,to:from}}),/half-open/);
 assert.throws(()=>parseArgs(['facts','--from',from,'--to','2026-09-30T09:00:00.1234567890Z']),/timestamp/);
 assert.throws(()=>parseArgs(['facts','--from','2026-09-30T09:00:00.123Z','--to','2026-09-30T09:00:00.123000000Z']),/precede/);
 const s=await createStore(c);
 try {
  await s.saveCollection(batch);
  const bundles=await createReviewer(s,c).prepare({schema_version:1,kind:'daily',lane:'live',period:'2026-09-30',cutoff:'2026-10-01T00:00:00Z'});
  assert.equal(bundles[0].chunks[0].events[0].utc_time.value,from);
  const review=result(bundles[0]);review.pages=[];review.candidates[0].occurred_at=value(from);
  const published=await createPublisher(s,c).publish(review);assert.equal(published.export_status,'ready');
  const artifact=(await s.listOutbox())[0].artifact;assert.equal(artifact.facts[0].occurred_at.value,from);assert.equal(artifact.coverage[0].query_range.from,from);
  const path=join(dirname(c.wiki_root),'precision-config.json');await writeFile(path,JSON.stringify(c));
  const facts=async(a:string,b:string)=>{let out='',err='';const code=await runCli(['facts','--from',a,'--to',b,'--config',path],{stdout:v=>out+=v,stderr:v=>err+=v});assert.equal(code,0,err);return JSON.parse(out);};
  assert.equal((await facts(from,to)).facts.length,1);
  assert.equal((await facts('2026-09-30T09:00:00.123456788Z',from)).facts.length,0);
  assert.equal((await facts(to,'2026-09-30T09:00:00.123456791Z')).facts.length,0);
 } finally {s.close();await rm(dirname(c.wiki_root),{recursive:true,force:true});}
});
