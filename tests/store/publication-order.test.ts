import test from 'node:test';
import assert from 'node:assert/strict';
import {dirname,join} from 'node:path';
import {rm} from 'node:fs/promises';
import {createStore,restoreStore,canonical} from '../../src/store/index.ts';
import {config,event,collection,bundle,result} from './fixtures.ts';

async function accept(s:Awaited<ReturnType<typeof createStore>>,id:string) {
 const e=event('source:'+id),b=bundle([e],'bundle:'+id),r=result(b,'result:'+id);r.pages=[];
 // Every attempt deliberately has the identical model-created timestamp.
 await s.saveCollection(collection([e],'live','collection:'+id));await s.saveBundle(b);
 return {r,commit:await s.commitReview(r)};
}
test('publication acceptance order survives immutable resend, restart and actual VACUUM backup/restore',async(t)=>{
 const c=await config();t.after(()=>rm(dirname(c.wiki_root),{recursive:true,force:true}));let s=await createStore(c);
 const old=await accept(s,'old-partial'),fresh=await accept(s,'fresh-complete'),a=await s.getPublicationBatchOrder(old.commit.batch_id),b=await s.getPublicationBatchOrder(fresh.commit.batch_id);
 assert.equal(old.r.created_at,fresh.r.created_at);assert(a!==null&&b!==null&&a<b,'actual acceptance order distinguishes identical model times');
 const original=canonical(await s.getReviewResult(old.r.result_id));assert.equal((await s.commitReview(old.r)).reused,true);assert.equal(await s.getPublicationBatchOrder(old.commit.batch_id),a);assert.equal(await s.getPublicationBatchOrder('unknown'),null);
 const parse=JSON.parse;JSON.parse=()=>{throw new Error('order lookup must not decode source/bundle/result/artifact bodies');};try {assert.equal(await s.getPublicationBatchOrder(old.commit.batch_id),a);assert.equal(await s.getPublicationBatchOrder(fresh.commit.batch_id),b);}finally{JSON.parse=parse;}
 s.close();s=await createStore(c);assert.equal(await s.getPublicationBatchOrder(old.commit.batch_id),a);assert.equal(await s.getPublicationBatchOrder(fresh.commit.batch_id),b);
 s.db.exec('VACUUM');assert.equal(await s.getPublicationBatchOrder(old.commit.batch_id),a);
 const backup=await s.backup(join(c.data_dir,'backup')),restoredDir=join(c.data_dir,'restored');await restoreStore(backup.path,restoredDir);s.close();
 const restored=await createStore({...c,data_dir:restoredDir});try {assert.equal(await restored.getPublicationBatchOrder(old.commit.batch_id),a);assert.equal(await restored.getPublicationBatchOrder(fresh.commit.batch_id),b);assert.equal(canonical(await restored.getReviewResult(old.r.result_id)),original);
 assert.equal((await restored.commitReview(old.r)).reused,true);assert.equal(await restored.getPublicationBatchOrder(old.commit.batch_id),a);
 const newer=await accept(restored,'after-restore');assert((await restored.getPublicationBatchOrder(newer.commit.batch_id))!>b!);} finally {restored.close();}
});
test('one-time upgrade assigns current database order without rewriting accepted history or repeated sequence writes',async(t)=>{
 const c=await config();t.after(()=>rm(dirname(c.wiki_root),{recursive:true,force:true}));let s=await createStore(c);const a=await accept(s,'upgrade-first'),b=await accept(s,'upgrade-second');
 const before=s.db.prepare('SELECT id,json,content,commit_json FROM results ORDER BY rowid').all(),outbox=s.db.prepare('SELECT * FROM outbox ORDER BY rowid').all();
 // Synthetic pre-port schema state, retaining the actual accepted rows untouched.
 s.db.exec("DROP TABLE publication_acceptance_order;DELETE FROM metadata WHERE key='publication-acceptance-order:v1'");s.close();s=await createStore(c);
 assert((await s.getPublicationBatchOrder(a.commit.batch_id))!<(await s.getPublicationBatchOrder(b.commit.batch_id))!);assert.deepEqual(s.db.prepare('SELECT id,json,content,commit_json FROM results ORDER BY rowid').all(),before);assert.deepEqual(s.db.prepare('SELECT * FROM outbox ORDER BY rowid').all(),outbox);
 const seq=s.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='publication_acceptance_order'").get();s.close();s=await createStore(c);assert.deepEqual(s.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='publication_acceptance_order'").get(),seq,'ordinary reopen does not rerun backfill/ignored AUTOINCREMENT writes');
 s.db.prepare('INSERT INTO outbox VALUES(?,?,?,NULL)').run('orphan','not valid body','pending');assert.equal(await s.getPublicationBatchOrder('orphan'),null);s.close();s=await createStore(c);assert.equal(await s.getPublicationBatchOrder('orphan'),null);s.close();
});
test('unknown, malformed or ambiguous accepted mapping has no ordering proof; rolled-back acceptance allocates none',async(t)=>{
 const c=await config();t.after(()=>rm(dirname(c.wiki_root),{recursive:true,force:true}));let fail=false;const s=await createStore(c,{onTransactionStep:step=>{if(fail&&step==='review_result')throw new Error('Synthetic rollback after ordinal');}});t.after(()=>s.close());
 const a=await accept(s,'first'),first=await s.getPublicationBatchOrder(a.commit.batch_id);fail=true;await assert.rejects(accept(s,'rolled-back'),/Synthetic rollback/);assert.equal((s.db.prepare('SELECT COUNT(*) AS n FROM publication_acceptance_order').get() as any).n,1);fail=false;
 const b=await accept(s,'second');assert((await s.getPublicationBatchOrder(b.commit.batch_id))!>first!);
 s.db.prepare('UPDATE publication_acceptance_order SET ordinal=9007199254740992 WHERE batch_id=?').run(b.commit.batch_id);assert.equal(await s.getPublicationBatchOrder(b.commit.batch_id),null,'unsafe integers cannot be ordering proof');
 const commit=s.db.prepare('SELECT commit_json FROM results WHERE id=?').get(a.r.result_id) as {commit_json:string};const malformed=JSON.parse(commit.commit_json);malformed.schema_version=2;s.db.prepare('UPDATE results SET commit_json=? WHERE id=?').run(canonical(malformed),a.r.result_id);assert.equal(await s.getPublicationBatchOrder(a.commit.batch_id),null);
 s.db.prepare('UPDATE results SET commit_json=? WHERE id=?').run('not-json',a.r.result_id);assert.equal(await s.getPublicationBatchOrder(a.commit.batch_id),null);
 s.db.prepare('UPDATE results SET commit_json=? WHERE id=?').run(commit.commit_json,a.r.result_id);const duplicate={...JSON.parse(commit.commit_json),result_id:b.r.result_id};s.db.prepare('UPDATE results SET commit_json=? WHERE id=?').run(canonical(duplicate),b.r.result_id);assert.equal(await s.getPublicationBatchOrder(a.commit.batch_id),null);
});

test('one valid and one malformed same-batch claim returns unknown both before and after one-time upgrade',async(t)=>{
 const c=await config();t.after(()=>rm(dirname(c.wiki_root),{recursive:true,force:true}));let s=await createStore(c);const a=await accept(s,'mixed-first'),b=await accept(s,'mixed-second');
 s.db.prepare('UPDATE results SET commit_json=? WHERE id=?').run(canonical({...a.commit,schema_version:2,result_id:b.r.result_id}),b.r.result_id);
 assert.equal(await s.getPublicationBatchOrder(a.commit.batch_id),null,'an invalid peer claim cannot be silently discarded from ambiguity');
 s.db.exec("DROP TABLE publication_acceptance_order;DELETE FROM metadata WHERE key='publication-acceptance-order:v1'");s.close();s=await createStore(c);try {assert.equal(await s.getPublicationBatchOrder(a.commit.batch_id),null);assert.equal((s.db.prepare('SELECT COUNT(*) AS n FROM publication_acceptance_order').get() as any).n,0);}finally{s.close();}
});
