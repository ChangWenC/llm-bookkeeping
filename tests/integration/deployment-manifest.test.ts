import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createDeploymentManifest, verifyDeploymentManifest } from '../../tools/deployment-manifest.ts';
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
test('deployment manifest retains current dirty baseline and rejects stale install/candidate', async()=>{
  const root=await mkdtemp(join(tmpdir(),'deploy-fixture-'));
  try {
    const current=join(root,'current'),candidate=join(root,'candidate');
    for(const dir of [current,candidate])await mkdir(join(dir,'src'),{recursive:true});
    await writeFile(join(current,'src','cli.ts'),'dirty existing');
    await writeFile(join(candidate,'src','cli.ts'),'new candidate');
    await writeFile(join(candidate,'src','added.ts'),'new file');
    const base=join(root,'BASE.json');await writeFile(base,JSON.stringify({schema_version:1,files:[{path:'src/cli.ts',sha256:hash('dirty existing')},{path:'src/removed.ts',sha256:null}]}));
    const manifest=await createDeploymentManifest(base,candidate);assert.equal(manifest.changes.length,2);
    await verifyDeploymentManifest(manifest,current);
    await writeFile(join(current,'src','cli.ts'),'subsequent maintenance');
    await assert.rejects(verifyDeploymentManifest(manifest,current),/Baseline precondition changed/);
    assert.equal(await readFile(join(current,'src','cli.ts'),'utf8'),'subsequent maintenance');
    await writeFile(join(current,'src','cli.ts'),'dirty existing');
    await writeFile(join(candidate,'src','cli.ts'),'candidate edited');
    await assert.rejects(verifyDeploymentManifest(manifest,current),/Candidate changed/);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('deployment inventory never follows symlinks or private runtime entries',async()=>{
  const root=await mkdtemp(join(tmpdir(),'deploy-safety-'));
  try {
    const base=join(root,'BASE.json'),candidate=join(root,'candidate');await mkdir(join(candidate,'src'),{recursive:true});await writeFile(base,JSON.stringify({schema_version:1,files:[]}));
    await symlink(base,join(candidate,'src','linked.ts'));
    await assert.rejects(createDeploymentManifest(base,candidate),/Symlink/);
    await rm(join(candidate,'src','linked.ts'));await writeFile(join(candidate,'src','private.sqlite'),'synthetic');
    await assert.rejects(createDeploymentManifest(base,candidate),/Runtime\/private/);
  }finally{await rm(root,{recursive:true,force:true});}
});
