import {readFile,writeFile,realpath,mkdir} from 'node:fs/promises';
import {resolve,join,dirname,isAbsolute,relative} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {canonicalLocation} from '../../src/config.ts';
import {installPreparationTimingProbe} from '../../src/review/timing-probe.ts';
const flags=new Map<string,string>();
const allowed=new Set(['config','continuation','output','implementation-root','source','lane','from','to','cutoff','selection-basis','max-bundles']);
let store:any,probe:ReturnType<typeof installPreparationTimingProbe>|undefined,output:string|undefined;
try {
 for(let index=2;index<process.argv.length;index+=2){const name=process.argv[index]?.replace(/^--/,''),value=process.argv[index+1];if(!process.argv[index]?.startsWith('--')||!allowed.has(name)||!value||flags.has(name))throw new Error('Invalid flags');flags.set(name,value);}
 const required=(key:string)=>{const value=flags.get(key);if(!value)throw new Error('Missing flag');return value;};
 const tempRoots=[...new Set(await Promise.all([tmpdir(),...(process.platform==='win32'?[]:['/tmp'])].map(path=>realpath(path))))];
 const contained=(root:string,path:string)=>{const r=relative(root,path);return r===''||(!r.startsWith('..')&&!isAbsolute(r));};
 const tmpPath=(value:string)=>{const path=resolve(value);if(!isAbsolute(value))throw new Error('Clone-only absolute path required');return path;};
 const assertTemporary=async(value:string)=>{const path=await realpath(value);if(!tempRoots.some(root=>contained(root,path)))throw new Error('Clone-only temporary path required');return path;};
 const configPath=tmpPath(required('config')),continuationPath=tmpPath(required('continuation'));output=tmpPath(required('output'));const outputLocation=await canonicalLocation(output);if(!tempRoots.some(root=>contained(root,outputLocation)))throw new Error('Unsafe output location');await mkdir(dirname(output),{recursive:true,mode:0o700});await assertTemporary(dirname(output));
 await assertTemporary(configPath);await assertTemporary(continuationPath);
 const implementationRoot=await realpath(fileURLToPath(new URL('../../',import.meta.url)));
 if(flags.has('implementation-root')&&await realpath(required('implementation-root'))!==implementationRoot)throw new Error('Implementation root must match this reader');
 const load=(path:string)=>import(pathToFileURL(join(implementationRoot,path)).href);
 const [{loadConfig},{createStore},{createReviewer}]=await Promise.all([load('src/config.ts'),load('src/store/index.ts'),load('src/review/index.ts')]);
 const config=await loadConfig(configPath),data=tmpPath(config.data_dir);await assertTemporary(data);
 const database=await realpath(join(data,'bookkeeping.sqlite'));if(!contained(await realpath(data),database))throw new Error('Unsafe clone database');await assertTemporary(database);
 const source=required('source'),lane=required('lane'),basis=required('selection-basis'),from=required('from'),to=required('to'),cutoff=required('cutoff');if(!['live','history'].includes(lane)||!['event_time','capture_lane'].includes(basis))throw new Error('Invalid frozen selection');
 const value=JSON.parse(await readFile(continuationPath,'utf8'));const continuation=value.cursor?value:value.preparation?.continuation??value.providers?.find((item:any)=>item.provider===source)?.preparation?.continuation;
 if(!continuation||continuation.scope?.source!==source||continuation.scope.lane!==lane||continuation.scope.range?.from!==from||continuation.scope.range.to!==to||continuation.scope.cutoff!==cutoff||continuation.scope.selection_basis!==basis)throw new Error('Frozen scope mismatch');
 const max=flags.get('max-bundles');if(max!==undefined&&(!/^\d+$/.test(max)||Number(max)<1))throw new Error('Invalid bundle count');
 const request={kind:'daily',source,lane,selection_basis:basis,range:{schema_version:1,from,to},cutoff,candidate_continuation:continuation,...(max?{max_bundles:Number(max)}:{})};
 const createStarted=performance.now();store=await createStore(config);const createElapsed=performance.now()-createStarted;probe=installPreparationTimingProbe(store);
 let prepared:any,failed=false;try{prepared=await createReviewer(store,config).prepareWithOutcomes(request);}catch{failed=true;}
 const timing=probe.stop();probe=undefined;
 const preparation=prepared?.providers?.find((item:any)=>item.provider===source)?.preparation;
 const report={schema_version:1,clone_store_created_ms:createElapsed,failed,bundle_count:prepared?.bundles?.length??0,preparation:preparation?{state:preparation.state,rows:preparation.scanned.rows,pages:preparation.scanned.pages,elapsed_ms:preparation.scanned.elapsed_ms,phase:preparation.progress?.phase??null,advanced:preparation.progress?.advanced??null,frontier:preparation.progress?.frontier??null,continuation:preparation.continuation??null}:null,timing};
 await writeFile(output,JSON.stringify(report)+'\n',{mode:0o600,flag:'wx'});if(failed)process.exitCode=1;
} catch {
 probe?.stop();process.stderr.write('Timing probe failed; no source values were emitted.\n');process.exitCode=1;
} finally {store?.close();}
