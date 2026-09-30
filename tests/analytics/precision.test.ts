import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../src/store/index.ts';
import { createAnalyticsConsumer, analyticsRepository } from '../../src/consumers/analytics/index.ts';
import { coverageStatus } from '../../src/analytics/model.ts';
import { decisionActiveAt, goalActiveAt } from '../../src/analytics/contracts.ts';
import { validateAnalyticsInput } from '../../src/analytics/validation.ts';
import { config, event, collection, bundle, result } from '../store/fixtures.ts';
const ref=(logical_id:string)=>({schema_version:1 as const,logical_id,revision:1});
const before='2026-09-30T12:00:00.123456788Z',at='2026-09-30T12:00:00.123456789Z',after='2026-09-30T12:00:00.123456790Z';

test('future exact pair confirmation and its retraction remain unapplied until their distinct nanosecond asOf', async () => {
 const c=await config();c.analytics_catalog={schema_version:1,capabilities:[{schema_version:1,definition_ref:ref('capability:verify'),label:'核验',keywords:['verify'],status:'formal'}],directions:[],project_mappings:[]};
 const s=await createStore(c);
 try {
  const e=event(),b=bundle([e]);await s.saveCollection(collection([e]));await s.saveBundle(b);const r=result(b);r.pages=[];r.candidates[0].analytics_projection.value!.attribution={actor:'Roy',responsibility:'verification',capability_ids:['capability:verify']};
  const accepted=await s.commitReview(r);await s.markExportReady(accepted.batch_id,c.data_dir+'/ready.json');
  const consumer=createAnalyticsConsumer(s,c,{now:()=>new Date('2026-09-30T12:00:01Z')});await consumer.consume();const repository=analyticsRepository(s),observation=repository.observations()[0];
  const pair={schema_version:1 as const,observation_ref:observation.observation_ref,capability_ref:ref('capability:verify')};
  await consumer.review({schema_version:1,kind:'review',events:[{schema_version:1,review_id:'nano-confirm',target_ref:observation.observation_ref,action:'confirm',correction:null,evidence_refs:[],selected_pairs:[pair],created_at:at}]});
  assert.equal(repository.currentOutput('before',c,before).overlays[0].confirmed,false);
  assert.equal(repository.currentOutput('at',c,at).overlays[0].confirmed,true);
  await consumer.review({schema_version:1,kind:'review',events:[{schema_version:1,review_id:'nano-retract',target_ref:observation.observation_ref,action:'retract',correction:null,evidence_refs:[],retracts_review_id:'nano-confirm',created_at:after}]});
  assert.equal(repository.currentOutput('at',c,at).overlays[0].confirmed,true);
  assert.equal(repository.currentOutput('after',c,after).overlays[0].confirmed,false);
 } finally {s.close();}
});

test('decision validity is half-open through nanoseconds and an inclusive goal deadline remains exact', () => {
 const goal={schema_version:1 as const,contract_ref:ref('goal:test'),subject:'Roy',description:'明确目标',target_version:'v1',deadline:at,confirmed:false};
 const decision={schema_version:1 as const,contract_ref:ref('decision:test'),subject:'Roy',goal_ref:goal.contract_ref,valid_from:before,valid_to:after,trigger:{schema_version:1 as const,name:'checked',expected_value:'yes'},confirmed:false};
 validateAnalyticsInput({schema_version:1,kind:'decision_contract',contract:decision});
 const confirmation={decision_confirmed:true,goal_confirmed:true};
 assert.equal(decisionActiveAt(decision,goal,before,confirmation),true);assert.equal(decisionActiveAt(decision,goal,at,confirmation),true);
 assert.equal(goalActiveAt(goal,after,true),false);
 assert.equal(decisionActiveAt(decision,{...goal,deadline:null},after,confirmation),false);
 assert.throws(()=>validateAnalyticsInput({schema_version:1,kind:'decision_contract',contract:{...decision,valid_from:after,valid_to:before}}),/validity/);
});

test('coverage union cannot fill a missing nanosecond interval or accept a later cutoff as earlier evidence', async () => {
 const c=await config(),range={schema_version:1 as const,from:before,to:after};
 const source={...collection().coverage[0],query_range:range,read_ranges:[{...range,to:at}],cutoff:after,review_status:'complete' as const};
 assert.equal(coverageStatus(c,[source],range),'partial');
 const second={...source,coverage_id:'second',read_ranges:[{...range,from:at}]};
 assert.equal(coverageStatus(c,[source,second],range),'complete');
 const chat={...source,conversation_id:'chat',capture_status:'partial' as const,read_ranges:[],cutoff:after};
 const tooEarly={...chat,coverage_id:'earlier-chat',capture_status:'complete' as const,read_ranges:[range],cutoff:at};
 assert.equal(coverageStatus(c,[source,second,chat,tooEarly],range),'partial');
});
