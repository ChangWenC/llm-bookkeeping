/** Coordinator installation inventory. Reads code bytes only; never installs or runs candidates. */
import { readFile, lstat, readdir, mkdir, open, rename, unlink } from 'node:fs/promises';
import { resolve, isAbsolute, join, dirname, relative } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const roots = new Set(['.gitignore','.nvmrc','AGENTS.md','LICENSE','README.md','SPEC.md','package.json','package-lock.json','tsconfig.json']);
const directories = new Set(['src','scripts','tools','test','tests','docs','schemas','agents']);
function safe(path: string): void {
  const parts = path.split('/');
  if (!path || isAbsolute(path) || parts.some(p=>!p || p==='.' || p==='..') || path.includes('\\') || path.includes('\0') || (parts.length===1 ? !roots.has(path) : !directories.has(parts[0]))) throw new Error('Unsafe code inventory path');
  if (/\.(?:sqlite|db|log|pem|key)(?:$|\.)/i.test(path)) throw new Error('Runtime/private material is not a deployment candidate');
}
async function bytes(root: string, path: string): Promise<Buffer | null> {
  safe(path);
  let current = root;
  for (const part of path.split('/')) {
    current=join(current,part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('Symlink code path rejected'); }
    catch(error) { if ((error as NodeJS.ErrnoException).code==='ENOENT') return null; throw error; }
  }
  if (!(await lstat(current)).isFile()) throw new Error('Nonregular code path rejected');
  return readFile(current);
}
const digest = (value: Buffer | null) => value===null ? null : createHash('sha256').update(value).digest('hex');
interface FileRecord { path: string; sha256: string|null; bytes?:number; mode?:number }
export interface DeploymentManifest {
  schema_version: 1; baseline_sha256: string; candidate_root: string;
  changes: {path:string;original_sha256:string|null;candidate_sha256:string|null;bytes:number|null}[];
}
export async function createDeploymentManifest(baselinePath:string,candidateRoot:string):Promise<DeploymentManifest> {
  if(!isAbsolute(baselinePath)||!isAbsolute(candidateRoot)) throw new Error('Absolute paths required');
  const raw=await readFile(baselinePath), baseline=JSON.parse(raw.toString()) as {schema_version:number;files:FileRecord[]};
  if(baseline.schema_version!==1 || !Array.isArray(baseline.files)) throw new Error('Invalid baseline');
  const originals=new Map<string,string|null>();
  for(const item of baseline.files){safe(item.path);if(originals.has(item.path)||!(item.sha256===null || /^[a-f0-9]{64}$/.test(item.sha256)))throw new Error('Invalid/duplicate baseline identity');originals.set(item.path,item.sha256);}
  const candidates=new Set<string>();
  async function walk(folder:string) {
    for(const entry of await readdir(join(candidateRoot,folder),{withFileTypes:true})) {
      const path=folder ? `${folder}/${entry.name}`:entry.name;
      if(!folder && !roots.has(path) && !directories.has(path)) continue;
      if (!(entry.isDirectory() && !folder && directories.has(path))) safe(path);
      if(entry.isSymbolicLink())throw new Error('Symlink code entry rejected');
      if(entry.isDirectory())await walk(path);else if(entry.isFile())candidates.add(path);else throw new Error('Nonregular candidate entry');
    }
  }
  await walk('');
  const changes:DeploymentManifest['changes']=[];
  for(const path of [...new Set([...originals.keys(),...candidates])].sort()) {
    const content=await bytes(candidateRoot,path),sha=digest(content),before=originals.get(path)??null;
    if(before!==sha)changes.push({path,original_sha256:before,candidate_sha256:sha,bytes:content?.length??null});
  }
  return {schema_version:1,baseline_sha256:digest(raw)!,candidate_root:resolve(candidateRoot),changes};
}
export async function verifyDeploymentManifest(manifest:DeploymentManifest,currentRoot:string):Promise<void> {
  if(!isAbsolute(currentRoot))throw new Error('Absolute verification root required');
  for(const item of manifest.changes){if(digest(await bytes(currentRoot,item.path))!==item.original_sha256)throw new Error(`Baseline precondition changed: ${item.path}`);if(digest(await bytes(manifest.candidate_root,item.path))!==item.candidate_sha256)throw new Error(`Candidate changed: ${item.path}`);}
}
async function main() {
  const args=process.argv.slice(2),options:Record<string,string>={};
  for(let i=0;i<args.length;i+=2){if(!['--baseline','--candidate','--output','--verify-root'].includes(args[i])||!args[i+1]||options[args[i]])throw new Error('Invalid options');options[args[i]]=args[i+1];}
  const manifest=await createDeploymentManifest(options['--baseline'],options['--candidate']);
  if(options['--verify-root'])await verifyDeploymentManifest(manifest,options['--verify-root']);
  const output=options['--output'];if(!output||!isAbsolute(output))throw new Error('Absolute output required');
  if(relative(resolve(manifest.candidate_root),resolve(output)).split('/')[0]!=='..')throw new Error('Manifest output must be outside candidate code');
  await mkdir(dirname(output),{recursive:true,mode:0o700});
  const temp=`${output}.${randomUUID()}.tmp`,handle=await open(temp,'wx',0o600);
  try {await handle.writeFile(JSON.stringify(manifest,null,2)+'\n');await handle.sync();} finally {await handle.close();}
  try {const existing=await open(output,'wx',0o600);await existing.close();await rename(temp,output);}catch(error){await unlink(temp);throw error;}
  process.stdout.write(JSON.stringify({schema_version:1,changes:manifest.changes.length,output,verified_current:!!options['--verify-root']})+'\n');
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
