import test from 'node:test';
import assert from 'node:assert/strict';
import {dailyStageOutcomes} from '../../src/daily-round-outcomes.ts';
const state=()=>({receipts:[] as Record<string,unknown>[],active:null,skip_units:[],skipped_journal_ids:[] as string[],phase:'stopped'});
test('finish with successful delivery but pending index/journal remains overall partial',()=>{
 const s=state();s.receipts=[{stage:'finish-resume',result:{fact_commit:'committed',export_status:'ready',file_status_counts:{applied:1,pending:0},consumer_outcomes:[{target:'monthly',status:'complete'}]}},{stage:'finish-consume',result:{target:'index',status:'pending',reason:'QMD failed'}}];
 const report=dailyStageOutcomes(s,{pending_exports:0,pending_patches:0,conflicting_patches:0,journal_publication:{pending:1}},['monthly','index']);
 assert.equal(report.stage_outcomes.fact_export.status,'complete');assert.equal(report.stage_outcomes.file_publication.status,'complete');assert.equal(report.stage_outcomes.index.status,'partial');assert.equal(report.stage_outcomes.journal.status,'partial');assert.equal(report.stage_outcomes.consumers.status,'complete');assert.match(report.stage_outcomes.consumers.reason,/does not prove monthly semantic/);assert.equal(report.overall_status,'partial');
});
test('deadline without time to execute or metadata does not invent completed stages',()=>{
 const report=dailyStageOutcomes(state(),null);assert.equal(report.stage_outcomes.index.status,'not_run');assert.equal(report.stage_outcomes.fact_export.status,'not_run');assert.equal(report.stage_outcomes.file_publication.status,'not_run');assert.equal(report.overall_status,'partial');
 const s=state();s.receipts=[{stage:'finish-resume',result:{export_status:'ready',file_status_counts:{applied:1}}}];assert.equal(dailyStageOutcomes(s,null).stage_outcomes.fact_export.status,'unknown');
});
test('latest real recovery receipt replaces a prior failed index outcome without changing other debt',()=>{
 const s=state();s.receipts=[{stage:'initial-consume',result:{target:'index',status:'pending',reason:'failed'}},{stage:'finish-consume',result:{target:'index',status:'complete'}}];s.skipped_journal_ids=['deferred-exact-work'];const report=dailyStageOutcomes(s,{journal_publication:{pending:0}});assert.equal(report.stage_outcomes.index.status,'complete');assert.equal(report.stage_outcomes.journal.status,'partial');
});


test('quota/deadline stop remains partial until every source-lane is actually exhausted',()=>{
 const s={...state(),sources:['synthetic'],exhausted:{live:['synthetic'],history:[]}};assert.equal(dailyStageOutcomes(s).stage_outcomes.review.status,'partial');s.exhausted.history.push('synthetic');assert.equal(dailyStageOutcomes(s).stage_outcomes.review.status,'complete');assert.equal(dailyStageOutcomes(s,{review:{eligible_pending:2}}).stage_outcomes.review.status,'partial');
});
test('one complete consumer does not stand in for missing expected consumers',()=>{
 const s=state();s.receipts=[{stage:'finish-consume',result:{target:'monthly',status:'complete'}}];const report=dailyStageOutcomes(s,null,['monthly','analytics','index']);assert.equal(report.stage_outcomes.consumers.status,'partial');assert.match(report.stage_outcomes.consumers.reason,/not run: analytics/);
});
test('awaiting, conflict and unresolved journal metadata independently keep delivery partial',()=>{
 for(const key of ['awaiting_user_confirmation','conflict','unresolved']){const s=state();s.receipts=[{stage:'journal-resolve',result:{resolution_id:'accepted'}}];assert.equal(dailyStageOutcomes(s,{journal_publication:{pending:0,[key]:1}}).stage_outcomes.journal.status,'partial');}
});
