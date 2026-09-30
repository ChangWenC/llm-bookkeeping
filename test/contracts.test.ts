import test from 'node:test';
import assert from 'node:assert/strict';
import {parseJsonPreservingIntegers,validateReviewResult,utc,InputError} from '../src/contracts/validation.ts';
import {validateConfig} from '../src/config.ts';
import {config,zeroReview} from './fixtures/basic.ts';
test('wide IDs are preserved before JSON parsing, including strings and escaped quotes',()=>{const result:any=parseJsonPreservingIntegers('{"id":9223372036854775807,"text":"id 9223372036854775807 \\\"quoted\\\"","small":8}');assert.equal(result.id,'9223372036854775807');assert.equal(result.small,8);assert.match(result.text,/quoted/);assert.throws(()=>parseJsonPreservingIntegers('{"x":01}'),InputError);});
test('review complete with zero facts must be explicit',()=>{assert.equal(validateReviewResult(zeroReview).candidates.length,0);assert.throws(()=>validateReviewResult({...zeroReview,chunks:[{...zeroReview.chunks[0],zero_facts:false}]}),/explicit/);});
test('partial review remains independently marked',()=>{const result=validateReviewResult({...zeroReview,chunks:[{...zeroReview.chunks[0],status:'partial',zero_facts:false,reason:'remaining slice'}]});assert.equal(result.chunks[0].status,'partial');});
test('config requires absolute root and explicit ordered travel timeline',()=>{assert.equal(validateConfig(config).wiki_root,'/tmp/wiki');assert.throws(()=>validateConfig({...config,wiki_root:'relative'}),/absolute/);assert.throws(()=>validateConfig({...config,journal_timezone_timeline:[]}),/explicit/);assert.equal(validateConfig({...config,limits:{...config.limits,bundle_bytes:200000}}).limits.bundle_bytes,200000);assert.throws(()=>validateConfig({...config,limits:{...config.limits,bundle_bytes:Infinity}}),/limits/);});
test('UTC validators reject offset guesses and invalid calendar rollover',()=>{assert.throws(()=>utc('2026-09-30T10:00:00+02:00','time'));assert.throws(()=>utc('2026-02-30T10:00:00Z','time'));});
test('configuration orders nanosecond cutover and timezone entries within the same millisecond',()=>{
 const early='2026-09-30T09:00:00.123456789Z',late='2026-09-30T09:00:00.123456790Z';
 const first={schema_version:1,effective_from:early,timezone:'Europe/Amsterdam',basis:'synthetic first'},second={...first,effective_from:late,basis:'synthetic next'};
 const valid={...config,live_start:early,cutover_at:late,journal_timezone_timeline:[first,second]};
 assert.equal(validateConfig(valid).journal_timezone_timeline.length,2);
 assert.throws(()=>validateConfig({...valid,live_start:late,cutover_at:early}),/live_start/);
 assert.throws(()=>validateConfig({...valid,journal_timezone_timeline:[second,first]}),/strictly increasing/);
 assert.throws(()=>validateConfig({...valid,journal_timezone_timeline:[first,{...first,effective_from:'2026-09-30T09:00:00.123456789Z'}]}),/strictly increasing/);
});
test('published zero/partial/correction fixtures satisfy runtime review contract',async()=>{const {readFile}=await import('node:fs/promises');for(const name of ['zero-facts','partial','correction'])validateReviewResult(parseJsonPreservingIntegers(await readFile(new URL(`./fixtures/${name}.json`,import.meta.url),'utf8')));});
test('model cannot choose permanent fact identity',()=>{const candidate={schema_version:1,candidate_id:'c:1',chunk_id:'chunk:zero',disposition:'add',content:'Synthetic work',subject:'owner:synthetic',occurred_at:{schema_version:1,value:null,reason:'unknown'},journal_date:{schema_version:1,value:null,reason:'unknown'},kind:'fact',analytics_projection:{schema_version:1,value:null,reason:'unreviewed'},event_refs:[],target_refs:[],scope:[],attribution:{},fact_id:'forged'};assert.throws(()=>validateReviewResult({...zeroReview,chunks:[{...zeroReview.chunks[0],zero_facts:false}],candidates:[candidate]}),/application assigns/);});
test('state paths never overlap Wiki/raw, source trees or iCloud',()=>{
  for(const data_dir of ['/tmp/wiki/data','/tmp/wiki/..state','/tmp','/Users/synthetic/Library/Mobile Documents/com~apple~CloudDocs/state'])assert.throws(()=>validateConfig({...config,data_dir}),/overlap|iCloud/);
  assert.throws(()=>validateConfig({...config,providers:[{schema_version:1,provider:'synthetic',account_id:'owner',enabled:true,roots:[config.data_dir],options:{}}]}),/raw source/);
});

test('professional catalogue validates stable revisions and mappings without expanding whitelist', () => {
  const definition = { schema_version: 1, definition_ref: { schema_version: 1, logical_id: 'cap:synthetic', revision: 1 }, label: '合成能力', keywords: ['verification'], status: 'formal' };
  const catalog = { schema_version: 1, capabilities: [definition], directions: [], project_mappings: [] };
  assert.deepEqual(validateConfig({ ...config, analytics_catalog: catalog }).project_whitelist, config.project_whitelist);
  assert.throws(() => validateConfig({ ...config, analytics_catalog: { ...catalog, capabilities: [definition, definition] } }), /Duplicate/);
  assert.throws(() => validateConfig({ ...config, analytics_catalog: { ...catalog, project_mappings: [{ schema_version: 1, id: 'project:unknown', wiki_prefix: '../private', repo_hint: null, direction_id: null }] } }), /relative/);
});
