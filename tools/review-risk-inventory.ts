/** Coordinator metadata audit only. Opens explicit existing SQLite read-only; no source/Wiki hydration. */
import {DatabaseSync} from 'node:sqlite';
import {lstat,realpath,readFile} from 'node:fs/promises';
import {isAbsolute,resolve,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateReviewRiskInventoryRequest} from '../src/journal-cli.ts';
import type {ReviewRiskInventory,ReviewRiskInventoryRequest} from '../src/contracts/types.ts';

export async function readReviewRiskInventory(databasePath:string,input:unknown):Promise<ReviewRiskInventory>{
 if(!isAbsolute(databasePath)||!['.sqlite','.db'].includes(extname(databasePath)))throw new Error('Explicit absolute existing SQLite path required');
 const supplied=await lstat(databasePath);if(!supplied.isFile()||supplied.isSymbolicLink())throw new Error('Regular database required');
 const path=await realpath(databasePath),request=validateReviewRiskInventoryRequest(input);
 const db=new DatabaseSync(path,{readOnly:true});
 try {
  if((db.prepare("SELECT value FROM metadata WHERE key='schema'").get() as {value?:string}|undefined)?.value!=='1')throw new Error('Unsupported current Bookkeeping schema');
  const moduleURL=new URL('../src/store/review-risk-inventory.ts',import.meta.url).href;
  const module=await import(moduleURL) as {inventoryReviewRisks:(db:DatabaseSync,request:ReviewRiskInventoryRequest)=>ReviewRiskInventory};
  return module.inventoryReviewRisks(db,request);
 }finally{db.close();}
}
async function main(){const flags:Record<string,string>={},args=process.argv.slice(2);for(let i=0;i<args.length;i+=2){if(!['--database','--input'].includes(args[i])||!args[i+1]||flags[args[i]])throw new Error('Invalid flags');flags[args[i]]=args[i+1];}if(!flags['--database']||!flags['--input']||!isAbsolute(flags['--input']))throw new Error('Explicit database/input required');process.stdout.write(JSON.stringify(await readReviewRiskInventory(flags['--database'],JSON.parse(await readFile(flags['--input'],'utf8'))))+'\n');}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{process.stderr.write('Metadata risk audit failed; no source content was emitted.\n');process.exitCode=1;});
