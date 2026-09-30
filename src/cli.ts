#!/usr/bin/env node
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, absolutePath } from './config.ts';
import { InputError, utc, date, parseJsonPreservingIntegers, validateManifest, validateReviewResult } from './contracts/validation.ts';
import { createRuntime, UnavailableError } from './runtime.ts';
import type { BookkeepingConfig, RuntimeServices, TimeRange } from './contracts/types.ts';

export const COMMANDS = ['collect','prepare','publish','consume','archive','import','migrate','replay','facts','analytics-review','status','backup','restore','validate'] as const;
export interface ParsedCommand { command: typeof COMMANDS[number]; options: Record<string,string|boolean> }
const allowed:Record<string,string[]>={collect:['lane'],prepare:['kind','lane','period','output'],publish:['input','resume'],consume:['target'],archive:['month','report','apply'],import:['manifest'],migrate:['manifest'],replay:['source','from','to'],facts:['from','to'],'analytics-review':['input'],status:[],backup:['output'],restore:['input','data-dir'],validate:['scope']};
const booleans=new Set(['resume','report','apply']);
function required(o:Record<string,string|boolean>,k:string):string { const v=o[k];if(typeof v!=='string'||!v)throw new InputError(`--${k} is required`);return v; }
function oneOf(o:Record<string,string|boolean>,k:string,values:string[]):string {const v=required(o,k);if(!values.includes(v))throw new InputError(`--${k}: expected ${values.join('|')}`);return v;}
export function parseArgs(args:string[]):ParsedCommand {
  const [command,...rest]=args;if(!COMMANDS.includes(command as any))throw new InputError(`Expected command: ${COMMANDS.join(', ')}`);
  const options:Record<string,string|boolean>={};
  for(let i=0;i<rest.length;i++){const token=rest[i];if(!token.startsWith('--'))throw new InputError(`Unexpected positional argument: ${token}`);const eq=token.indexOf('=');const key=token.slice(2,eq<0?undefined:eq);if(![...allowed[command],'config'].includes(key))throw new InputError(`Unknown option --${key} for ${command}`);if(key in options)throw new InputError(`Duplicate option --${key}`);if(booleans.has(key)){if(eq>=0)throw new InputError(`--${key} does not take a value`);options[key]=true;}else{const value=eq>=0?token.slice(eq+1):rest[++i];if(!value||value.startsWith('--'))throw new InputError(`--${key} requires a value`);options[key]=value;}}
  if(options.config)absolutePath(options.config,'config');
  if(command==='collect')oneOf(options,'lane',['live','history']);
  if(command==='prepare'){const kind=oneOf(options,'kind',['daily','weekly','monthly']);oneOf(options,'lane',['live','history']);required(options,'output');if(options.period){const p=required(options,'period');if(kind==='monthly')month(p);else date(p,'period');}}
  if(command==='publish'){if(Boolean(options.input)===Boolean(options.resume))throw new InputError('publish requires exactly one of --input or --resume');}
  if(command==='consume')oneOf(options,'target',['analytics','monthly','index','all']);
  if(command==='archive'){month(required(options,'month'));if(Boolean(options.report)===Boolean(options.apply))throw new InputError('archive requires exactly one of --report or --apply');}
  if(command==='import'||command==='migrate')required(options,'manifest');
  if(command==='replay'||command==='facts'){const from=utc(required(options,'from'),'from'),to=utc(required(options,'to'),'to');if(Date.parse(from)>=Date.parse(to))throw new InputError('--from must precede --to');if(command==='replay')required(options,'source');}
  if(command==='analytics-review')required(options,'input');
  if(command==='backup')required(options,'output');
  if(command==='restore'){required(options,'input');absolutePath(required(options,'data-dir'),'data-dir');}
  if(command==='validate')oneOf(options,'scope',['changed','all']);
  return {command:command as ParsedCommand['command'],options};
}
function month(value:string){if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(value))throw new InputError('month: expected YYYY-MM');return value;}
async function readJson(path:string){let text:string;try{text=await readFile(resolve(path),'utf8');}catch(e){throw new Error(`Cannot read input ${path}: ${(e as Error).message}`);}return parseJsonPreservingIntegers(text);}
function unavailable(capability:string):never{throw new UnavailableError(`Not implemented: ${capability}`);}
async function adapterCheckpoints(services:RuntimeServices,provider:string){const [live,history]=await Promise.all([services.store.getCheckpoints(provider,'live'),services.store.getCheckpoints(provider,'history')]);return [...live,...history];}
export async function executeCommand(parsed:ParsedCommand, config:BookkeepingConfig, services:RuntimeServices, cutoff:string):Promise<unknown>{
  const {command,options:o}=parsed;
  const range=():TimeRange=>({schema_version:1,from:required(o,'from'),to:required(o,'to')});
  switch(command){
    case 'collect':{
      const lane=required(o,'lane') as 'live'|'history';const query:TimeRange={schema_version:1,from:lane==='live'?new Date(Math.max(Date.parse(config.live_start),Date.parse(cutoff)-48*3600000)).toISOString():config.journal_timezone_timeline[0].effective_from,to:cutoff};
      const budget=lane==='live'?{max_duration_ms:90000,max_bytes:64*1024*1024,max_directory_entries:2000}:{max_duration_ms:30000,max_bytes:32*1024*1024,max_directory_entries:2000};
      const output=[];for(const adapter of services.adapters){let batches=0,events=0;try{for await(const batch of adapter.collect({lane,cutoff,range:query,budget},{checkpoints:await adapterCheckpoints(services,adapter.provider),config})){await services.store.saveCollection(batch);batches++;events+=batch.events.length;}output.push({provider:adapter.provider,execution_status:'complete',batches,events});}catch(e){output.push({provider:adapter.provider,execution_status:'partial',batches,events,reason:(e as Error).message});}}
      if(!services.adapters.length)unavailable('enabled source adapters');return {schema_version:1,lane,cutoff,providers:output,coverage:await services.store.listCoverage(query)};
    }
    case 'prepare':{
      const outputDir=resolve(required(o,'output'));const bundles=await services.reviewer.prepare({kind:required(o,'kind') as any,lane:required(o,'lane') as any,period:o.period as string|undefined,cutoff,output_dir:outputDir});await mkdir(outputDir,{recursive:true});const files=[];for(const bundle of bundles){const name=`bundle-${encodeURIComponent(bundle.bundle_id)}.json`;await writeFile(resolve(outputDir,name),JSON.stringify(bundle,null,2)+'\n',{flag:'wx'}).catch(async(e)=>{if(e.code!=='EEXIST')throw e;const existing=await readFile(resolve(outputDir,name),'utf8');if(existing!==JSON.stringify(bundle,null,2)+'\n')throw new Error(`Existing bundle differs: ${name}`);});files.push(name);}const manifest={schema_version:1,kind:required(o,'kind'),lane:required(o,'lane'),cutoff,bundles:files};await writeFile(resolve(outputDir,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');return {output_dir:outputDir,...manifest};
    }
    case 'publish':return o.resume?services.publisher.resume():services.publisher.publish(validateReviewResult(await readJson(required(o,'input'))));
    case 'consume':{const target=required(o,'target');const consumers=services.consumers.filter(c=>target==='all'||c.target===target);if(!consumers.length)unavailable(`consumer ${target}`);return {schema_version:1,consumers:await Promise.all(consumers.map(c=>c.consume()))};}
    case 'archive':return services.archive?services.archive({month:required(o,'month'),mode:o.apply?'apply':'report'}):unavailable('archive');
    case 'import':{const manifest=validateManifest(await readJson(required(o,'manifest')));if(manifest.kind!=='import')throw new InputError('import manifest.kind must be import');return services.importManifest?services.importManifest(manifest):unavailable('import');}
    case 'migrate':{const manifest=validateManifest(await readJson(required(o,'manifest')));if(manifest.kind!=='migration')throw new InputError('migrate manifest.kind must be migration');return services.migrateManifest?services.migrateManifest(manifest):unavailable('migration');}
    case 'replay':{const adapter=services.adapters.find(a=>a.provider===required(o,'source'));if(!adapter)throw new InputError(`Unknown source ${o.source}`);if(!adapter.replay)unavailable(`replay ${o.source}`);let batches=0;for await(const batch of adapter.replay(range(),{checkpoints:await adapterCheckpoints(services,adapter.provider),config})){await services.store.saveCollection(batch);batches++;}return {schema_version:1,source:o.source,batches,range:range()};}
    case 'facts':return {schema_version:1,facts:await services.store.readEffectiveFacts({range:range()})};
    case 'analytics-review':return services.analyticsReview?services.analyticsReview(await readJson(required(o,'input'))):unavailable('analytics review');
    case 'status':return {schema_version:1,...await services.store.status()};
    case 'backup':return {schema_version:1,...await services.store.backup(resolve(required(o,'output')))};
    case 'restore':return services.restore?services.restore(resolve(required(o,'input')),required(o,'data-dir')):unavailable('restore');
    case 'validate':return services.validate?services.validate(required(o,'scope') as 'changed'|'all'):unavailable('validate');
  }
}
export interface CliDependencies { loadConfig?:(path?:string)=>Promise<BookkeepingConfig>; createRuntime?:(config:BookkeepingConfig)=>Promise<RuntimeServices>; stdout?:(text:string)=>void; stderr?:(text:string)=>void; now?:()=>string }
export async function runCli(args:string[],deps:CliDependencies={}):Promise<number>{
  const out=deps.stdout??(s=>process.stdout.write(s));const err=deps.stderr??(s=>process.stderr.write(s));let services:RuntimeServices|undefined;
  try{if(args.length===1&&(args[0]==='--help'||args[0]==='help')){out(JSON.stringify({schema_version:1,commands:COMMANDS,config:'--config ABSOLUTE_PATH',node:'25.8.0'})+'\n');return 0;}const parsed=parseArgs(args);const config=await(deps.loadConfig??loadConfig)(parsed.options.config as string|undefined);services=await(deps.createRuntime??createRuntime)(config);const result=await executeCommand(parsed,config,services,(deps.now??(()=>new Date().toISOString()))());out(JSON.stringify(result)+'\n');return 0;}catch(e){const code=e instanceof InputError?2:1;err((e as Error).message+'\n');out(JSON.stringify({schema_version:1,error:{kind:code===2?'invalid_input':'execution_failed',message:(e as Error).message}})+'\n');return code;}finally{if(services)await services.store.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)process.exitCode=await runCli(process.argv.slice(2));
