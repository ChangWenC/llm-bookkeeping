import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inspectReviewMaterialV2, encodeInspectionCursor, decodeInspectionCursor, MAX_INSPECTION_PAGE_BYTES } from '../../src/review-material-inspection.ts';
import { bundle,event,collection } from '../store/fixtures.ts';
import type { MaterialSection, InspectionCursorV2 } from '../../src/review-material-inspection.ts';
function reconstruct(value:unknown,section:MaterialSection){
 const rows:string[]=[];let cursor:InspectionCursorV2|undefined, pages=0;
 do {const page=inspectReviewMaterialV2(value,section,cursor);assert.ok(Buffer.byteLength(JSON.stringify(page)+'\n')<=MAX_INSPECTION_PAGE_BYTES);
  for(const fragment of page.fragments){rows[fragment.item_index]=(rows[fragment.item_index]??'')+fragment.json_fragment;assert.equal(Buffer.byteLength(rows[fragment.item_index]),fragment.byte_end);assert.ok(!fragment.json_fragment.includes('�'));
   if(fragment.byte_end===fragment.total_bytes)assert.equal(createHash('sha256').update(rows[fragment.item_index]).digest('hex'),fragment.item_sha256);}
  cursor=page.next_cursor??undefined;pages++;assert.ok(pages<10000);
 }while(cursor);return {rows:rows.map(row=>JSON.parse(row)),pages};
}
test('under128KiB bundle summary is small directory and every long coverage/unfinished record remains independently readable',()=>{
 const saved=bundle([event('only-primary')],'coverage-summary');
 saved.coverage=Array.from({length:100},(_,i)=>({...collection([]).coverage[0],coverage_id:`coverage:${i}`,gaps:[{schema_version:1,range:null,reason:`Synthetic ${i} `+'x'.repeat(450),locator:null,resumable:true}]}));
 saved.unfinished=[{schema_version:1,range:null,reason:'Explicit independent debt',locator:null,resumable:true}];
 assert.ok(Buffer.byteLength(JSON.stringify(saved))<131072);
 const summary=reconstruct(saved,'summary');assert.equal(summary.rows[0].read_state,'summary_only');assert.equal(summary.rows[0].review_complete,false);assert.equal(summary.rows[0].sections.find((item:any)=>item.section==='coverage').total_items,100);assert.equal('coverage' in summary.rows[0],false);
 assert.deepEqual(reconstruct(saved,'coverage').rows,saved.coverage);assert.deepEqual(reconstruct(saved,'unfinished').rows,saved.unfinished);
});
test('UTF8 escaped giant events/facts/baselines fragment with exact stable identities/hashes and full tail reconstruction',()=>{
 const body='🧪中文\n"\\'.repeat(16000)+'EXACT_TAIL',saved=bundle([event('stable-event',body)],'giant-items');
 saved.baselines=[{schema_version:1,path:'synthetic.md',digest:'full-original-digest',content:body}];
 const events=reconstruct(saved,'events');assert.ok(events.pages>1);assert.equal(events.rows[0].body,body);assert.equal(events.rows[0].event_id,'stable-event');
 const baseline=reconstruct(saved,'baselines');assert.ok(baseline.pages>1);assert.equal(baseline.rows[0].content,body);assert.equal(baseline.rows[0].digest,'full-original-digest');
 const first=inspectReviewMaterialV2(saved,'events');assert.deepEqual(first,inspectReviewMaterialV2(saved,'events'));assert.deepEqual(decodeInspectionCursor(encodeInspectionCursor(first.next_cursor!)),first.next_cursor);
});
test('cursor rejects changed material, wrong section and partial UTF8 offset without changing permanent IDs',()=>{
 const saved=bundle([event('fixed','🧪'.repeat(9000))],'cursor-scope'),first=inspectReviewMaterialV2(saved,'events');assert.ok(first.next_cursor);
 assert.throws(()=>inspectReviewMaterialV2(saved,'baselines',first.next_cursor!),/match/);
 const changed=structuredClone(saved);changed.chunks[0].events[0].body+='new';assert.throws(()=>inspectReviewMaterialV2(changed,'events',first.next_cursor!),/match/);
 const json=JSON.stringify((reconstruct(saved,'events').rows[0]));const bytes=Buffer.from(json),continuationByte=bytes.indexOf(Buffer.from('🧪'))+1;
 assert.throws(()=>inspectReviewMaterialV2(saved,'events',{...first.next_cursor!,item_index:0,byte_offset:continuationByte}),/UTF-8/);assert.equal(saved.chunks[0].events[0].event_id,'fixed');
});

test('bounded metadata retains monthly/analysis/replay/requirements contracts omitted from small summary',()=>{
 const saved=bundle([event('contract-primary')],'contract-metadata') as any;
 saved.review_requirements={schema_version:1,unit_dispositions:true,inspection_version:2};saved.replay={schema_version:1,work_id:'frozen-replay',source:'synthetic',range:collection([]).coverage[0].query_range};
 saved.monthly_context={schema_version:1,work_only:true,month:'2026-09',range:collection([]).coverage[0].query_range,facts:[],coverage:[],coverage_status:'partial',manual_baselines:[],prepared_work_ids:Array.from({length:100},(_,i)=>`exact-frozen-work:${i}`),facts_page:{schema_version:1,snapshot_id:'frozen-snapshot',cutoff:saved.cutoff,offset:32,next_offset:64,total:100}};
 saved.analysis_context={schema_version:1,analysis_ref:{schema_version:1,logical_id:'exact-week',revision:2},facts:[],confirmed_goals:[{schema_version:1,logical_id:'goal:exact',revision:3}],analytics_catalog:{schema_version:1,capabilities:[],directions:[],project_mappings:[]},custom_required:'x'.repeat(25000)};
 const metadata=reconstruct(saved,'metadata');assert.ok(metadata.pages>1);const context=metadata.rows[0];assert.deepEqual(context.review_requirements,saved.review_requirements);assert.deepEqual(context.replay,saved.replay);assert.deepEqual(context.monthly_context.prepared_work_ids,saved.monthly_context.prepared_work_ids);assert.deepEqual(context.monthly_context.facts_page,saved.monthly_context.facts_page);assert.deepEqual(context.analysis_context.confirmed_goals,saved.analysis_context.confirmed_goals);assert.equal(context.analysis_context.custom_required,saved.analysis_context.custom_required);
 const summary=reconstruct(saved,'summary').rows[0];assert.equal(summary.sections.find((section:any)=>section.section==='metadata').total_items,1);assert.equal('monthly_context' in summary,false);
});


test('byte-first packing reads80 small events in few pages and honors auxiliary row limit',()=>{
 const saved=bundle(Array.from({length:80},(_,i)=>event(`small:${i}`,'Synthetic short message')),'packed-small');
 const reconstructed=reconstruct(saved,'events');assert.equal(reconstructed.rows.length,80);assert.ok(reconstructed.pages<10);
 const first=inspectReviewMaterialV2(saved,'events',undefined,0,3);assert.equal(first.fragments.length,3);assert.equal(first.next_cursor?.item_index,3);
 const mixed=bundle([event('small-before','tiny'),event('large-after','🧪'.repeat(12000)),event('small-tail','tail')],'mixed-pack');
 const rows=reconstruct(mixed,'events').rows;assert.deepEqual(rows.map((row:any)=>row.event_id),['small-before','large-after','small-tail']);assert.equal(rows[1].body,mixed.chunks[0].events[1].body);
});

test('journal and accepted inventory metadata retain cutoff and continuation outside summary',()=>{
 const value={schema_version:1,journal_bundle_id:'journal:synthetic',cutoff:'2026-10-11T10:00:00.000Z',work:[],facts:[],existing_facts:[],baselines:[],conflicts:[],custom_required:'x'.repeat(20000)};
 const metadata=reconstruct(value,'metadata');assert.equal(metadata.rows[0].cutoff,value.cutoff);assert.equal(metadata.rows[0].custom_required,value.custom_required);assert.ok(metadata.pages>1);
 assert.ok(reconstruct(value,'summary').rows[0].sections.some((row:any)=>row.section==='metadata'));
 const inventory={schema_version:1,items:[],next_result_id:'next-exact-id',cutoff:value.cutoff};assert.equal(reconstruct(inventory,'metadata').rows[0].next_result_id,'next-exact-id');
});
