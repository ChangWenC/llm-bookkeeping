/** Coordinator explicitly selects admitted stored originals; no capture/review/write paths. */
import {DatabaseSync} from 'node:sqlite';
import {readFile,lstat,realpath} from 'node:fs/promises';
import {resolve,isAbsolute,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadConfig} from '../src/config.ts';
import {version,array,string,InputError} from '../src/contracts/validation.ts';
import {readAdmittedSourceEvents} from '../src/store/selected-source-reader.ts';
export async function readSelectedSource(configPath:string,input:unknown){
 if(!isAbsolute(configPath))throw new InputError('Explicit absolute current config required');const config=await loadConfig(configPath),selection=version(input,'selected source');
 if(Object.keys(selection).some(key=>!['schema_version','event_ids','max_body_bytes'].includes(key)))throw new InputError('Unknown selected source field');const ids=array(selection.event_ids,'event_ids').map(id=>string(id,'event_id'));
 const path=join(config.data_dir,'bookkeeping.sqlite'),stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink())throw new InputError('Configured existing regular SQLite required');
 const db=new DatabaseSync(await realpath(path),{readOnly:true});try{if((db.prepare("SELECT value FROM metadata WHERE key='schema'").get() as {value?:string}|undefined)?.value!=='1')throw new Error('Unsupported database');return readAdmittedSourceEvents(db,config,ids,selection.max_body_bytes??131072);}finally{db.close();}
}
async function main(){const flags:Record<string,string>={},args=process.argv.slice(2);for(let i=0;i<args.length;i+=2){if(!['--config','--input'].includes(args[i])||!args[i+1]||flags[args[i]])throw new Error('Invalid flags');flags[args[i]]=args[i+1];}if(!flags['--config']||!flags['--input']||!isAbsolute(flags['--input']))throw new Error('Explicit config/input required');process.stdout.write(JSON.stringify(await readSelectedSource(flags['--config'],JSON.parse(await readFile(flags['--input'],'utf8'))))+'\n');}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{process.stderr.write('Selected source read failed; no source content was emitted.\n');process.exitCode=1;});
