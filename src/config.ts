import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { InputError, record, string, version, array, zone, utc, parseJsonPreservingIntegers } from './contracts/validation.ts';
import type { BookkeepingConfig } from './contracts/types.ts';
export const DEFAULT_LIMITS = Object.freeze({ chunk_events:80, chunk_body_bytes:32*1024, bundle_bytes:128*1024, bundles_per_round:4 });
export function absolutePath(value:unknown, name:string):string { const s=string(value,name);if(!isAbsolute(s))throw new InputError(`${name}: absolute path required`);return resolve(s); }
export function validateConfig(value:unknown): BookkeepingConfig {
  const r=version(value,'config');absolutePath(r.wiki_root,'wiki_root');absolutePath(r.data_dir,'data_dir');
  zone(r.journal_timezone,'journal_timezone');if(r.analysis_timezone!=='Europe/Amsterdam')throw new InputError('analysis_timezone: expected Europe/Amsterdam');
  utc(r.cutover_at,'cutover_at');utc(r.live_start,'live_start');if(Date.parse(r.live_start)>Date.parse(r.cutover_at))throw new InputError('live_start must not follow cutover_at');
  const timeline=array(r.journal_timezone_timeline,'journal_timezone_timeline');let previous=-Infinity;
  for(const entry of timeline){version(entry,'timezone entry');utc(entry.effective_from,'effective_from');zone(entry.timezone,'timezone');string(entry.basis,'basis');const t=Date.parse(entry.effective_from);if(t<=previous)throw new InputError('journal_timezone_timeline must be strictly increasing');previous=t;}
  if(!timeline.length)throw new InputError('journal_timezone_timeline: at least one explicit entry required');
  const providers=array(r.providers,'providers');const names=new Set<string>();
  for(const p of providers){version(p,'provider');string(p.provider,'provider');string(p.account_id,'account_id');if(names.has(`${p.provider}:${p.account_id}`))throw new InputError('duplicate provider/account');names.add(`${p.provider}:${p.account_id}`);if(typeof p.enabled!=='boolean')throw new InputError('provider.enabled: expected boolean');array(p.roots,'roots').forEach(root=>absolutePath(root,'provider.root'));record(p.options,'options');}
  const limits=record(r.limits,'limits');for(const key of Object.keys(DEFAULT_LIMITS)){if(!Number.isSafeInteger(limits[key])||limits[key]<1||limits[key]>DEFAULT_LIMITS[key as keyof typeof DEFAULT_LIMITS])throw new InputError(`limits.${key}: must be between 1 and ${DEFAULT_LIMITS[key as keyof typeof DEFAULT_LIMITS]}`);}
  for(const key of ['project_whitelist','goal_whitelist'])array(r[key],key).forEach(item=>string(item,key));
  return r as BookkeepingConfig;
}
export async function loadConfig(path?:string):Promise<BookkeepingConfig>{
  const target=absolutePath(path??process.env.BOOKKEEPING_CONFIG??resolve(homedir(),'.config/llm-bookkeeping/config.json'),'config');
  let text:string;try{text=await readFile(target,'utf8');}catch(e){throw new Error(`Cannot read config ${target}: ${(e as Error).message}`);}
  return validateConfig(parseJsonPreservingIntegers(text));
}
