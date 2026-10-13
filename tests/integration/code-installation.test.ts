import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createDeploymentManifest} from '../../tools/deployment-manifest.ts';
import {installCodeManifest} from '../../tools/install-code-manifest.ts';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
test('single-writer installation verifies exact dirty baseline, adds files, preserves unrelated files and rejects changed originals',async()=>{
 const base=await mkdtemp(join(tmpdir(),'synthetic-code-install-')),root=join(base,'formal'),candidate=join(base,'candidate');
 try{for(const folder of [root,candidate])await mkdir(join(folder,'src'),{recursive:true});await writeFile(join(root,'src','existing.ts'),'dirty deployed bytes');await writeFile(join(root,'src','unrelated.ts'),'independent dirty bytes');await writeFile(join(candidate,'src','existing.ts'),'repaired bytes');await writeFile(join(candidate,'src','unrelated.ts'),'independent dirty bytes');await writeFile(join(candidate,'src','added.ts'),'new bytes');
 const baseline=join(base,'base.json');await writeFile(baseline,JSON.stringify({schema_version:1,files:[{path:'src/existing.ts',sha256:sha('dirty deployed bytes')},{path:'src/unrelated.ts',sha256:sha('independent dirty bytes')}]}));
 const manifest=await createDeploymentManifest(baseline,candidate);assert.equal((await installCodeManifest(manifest,root)).status,'verified');assert.equal(await readFile(join(root,'src','existing.ts'),'utf8'),'dirty deployed bytes');
 await writeFile(join(root,'src','existing.ts'),'later maintenance');await assert.rejects(installCodeManifest(manifest,root,true),/Baseline/);assert.equal(await readFile(join(root,'src','existing.ts'),'utf8'),'later maintenance');
 await writeFile(join(root,'src','existing.ts'),'dirty deployed bytes');assert.equal((await installCodeManifest(manifest,root,true)).status,'installed');assert.equal(await readFile(join(root,'src','added.ts'),'utf8'),'new bytes');assert.equal(await readFile(join(root,'src','unrelated.ts'),'utf8'),'independent dirty bytes');
 }finally{await rm(base,{recursive:true,force:true});}
});
