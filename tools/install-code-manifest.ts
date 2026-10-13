/** Coordinator-only code installation. Single writer required; each replacement is atomic, the whole set is not. */
import {readFile,lstat,mkdir,open,rename,unlink} from 'node:fs/promises';
import {join,dirname,resolve,isAbsolute} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {verifyDeploymentManifest} from './deployment-manifest.ts';
import type {DeploymentManifest} from './deployment-manifest.ts';
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
export async function installCodeManifest(manifest:DeploymentManifest,root:string,apply=false){
 if(!isAbsolute(root)||resolve(root)===resolve(manifest.candidate_root))throw new Error('Independent absolute installation root required');
 await verifyDeploymentManifest(manifest,root);
 if(!apply)return {schema_version:1,status:'verified',changed_files:manifest.changes.length};
 if(manifest.changes.some(item=>item.candidate_sha256===null))throw new Error('Deletion requires a separately reviewed installation; nothing installed');
 const staged:{path:string;temp:string;bytes:Buffer;mode:number;before:Buffer|null}[]=[];
 const installed:typeof staged=[];
 try {
  for(const item of manifest.changes){
   const path=join(root,item.path),content=await readFile(join(manifest.candidate_root,item.path));
   if(sha(content)!==item.candidate_sha256)throw new Error('Candidate changed while staging');
   let before:Buffer|null=null,mode=0o644;
   try{before=await readFile(path);mode=(await lstat(path)).mode&0o777;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
   await mkdir(dirname(path),{recursive:true});
   const temp=join(dirname(path),`.bookkeeping-code-${randomUUID()}.tmp`),handle=await open(temp,'wx',mode);
   try{await handle.writeFile(content);await handle.sync();}finally{await handle.close();}
   staged.push({path,temp,bytes:content,mode,before});
  }
  // Recheck all original and candidate bytes after staging; this is not a cross-writer CAS.
  await verifyDeploymentManifest(manifest,root);
  for(const item of staged){await rename(item.temp,item.path);installed.push(item);}
  for(const item of installed)if(sha(await readFile(item.path))!==sha(item.bytes))throw new Error('Installed bytes mismatch');
  return {schema_version:1,status:'installed',changed_files:installed.length,atomicity:'per_file',single_writer_required:true};
 }catch(error){
  const unresolved:string[]=[];
  for(const item of installed.reverse()){
   try{
    if(sha(await readFile(item.path))!==sha(item.bytes)){unresolved.push(item.path);continue;}
    if(item.before===null){await unlink(item.path);continue;}
    const temp=join(dirname(item.path),`.bookkeeping-rollback-${randomUUID()}.tmp`),handle=await open(temp,'wx',item.mode);
    try{await handle.writeFile(item.before);await handle.sync();}finally{await handle.close();}
    await rename(temp,item.path);
   }catch{unresolved.push(item.path);}
  }
  if(unresolved.length)throw new Error(`Installation failed; rollback requires coordinator inspection: ${unresolved.join(',')}`,{cause:error});
  throw error;
 }finally{for(const item of staged)try{await unlink(item.temp);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
}
async function main(){
 const options:Record<string,string|boolean>={};const args=process.argv.slice(2);
 for(let i=0;i<args.length;i++){const key=args[i];if(!['--manifest','--root','--apply','--single-writer-confirmed'].includes(key)||key in options)throw new Error('Unknown/duplicate option');if(key==='--apply'||key==='--single-writer-confirmed')options[key]=true;else{const value=args[++i];if(!value||!isAbsolute(value))throw new Error('Absolute path required');options[key]=value;}}
 if(!options['--manifest']||!options['--root'])throw new Error('--manifest and --root required');
 if(options['--apply']&&!options['--single-writer-confirmed'])throw new Error('Coordinator single-writer confirmation required');
 const manifest=JSON.parse(await readFile(options['--manifest'] as string,'utf8')) as DeploymentManifest;
 if(manifest.schema_version!==1||!Array.isArray(manifest.changes))throw new Error('Invalid manifest');
 process.stdout.write(JSON.stringify(await installCodeManifest(manifest,options['--root'] as string,options['--apply']===true))+'\n');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
