import { SCHEMA_VERSION } from './types.ts';
import type { BookkeepingConfig, FactArtifact, Manifest, ReviewBundle, ReviewResult, SourceEvent, SourceCoverage } from './types.ts';

export class InputError extends Error { constructor(message: string) { super(message); this.name = 'InputError'; } }
export function record(value: unknown, path = 'input'): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError(`${path}: expected object`);
  return value as Record<string, any>;
}
function fail(path: string, expected: string): never { throw new InputError(`${path}: ${expected}`); }
export function string(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.length) fail(path, 'expected nonempty string');
  return value;
}
function nullableString(value: unknown, path: string) { if (value !== null) string(value, path); }
export function version(value: unknown, path = 'input') { const r = record(value, path); if (r.schema_version !== SCHEMA_VERSION) fail(path, 'unsupported schema_version'); return r; }
export function array(value: unknown, path: string): any[] { if (!Array.isArray(value)) fail(path, 'expected array'); return value; }
function choice(value: unknown, values: readonly string[], path: string) { if (!values.includes(value as string)) fail(path, `expected ${values.join('|')}`); }
export function utc(value: unknown, path: string): string {
  const s = string(value, path);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(s) || !Number.isFinite(Date.parse(s))) fail(path, 'expected UTC ISO timestamp ending Z');
  const normalized = new Date(s).toISOString();
  if (normalized.slice(0,19) !== s.slice(0,19)) fail(path, 'invalid calendar timestamp');
  return s;
}
export function date(value: unknown, path: string): string {
  const s = string(value,path);
  if (!/^\d{4}-\d\d-\d\d$/.test(s) || !Number.isFinite(Date.parse(`${s}T00:00:00Z`)) || new Date(`${s}T00:00:00Z`).toISOString().slice(0,10) !== s) fail(path,'expected valid YYYY-MM-DD');
  return s;
}
export function zone(value: unknown, path: string): string {
  const s = string(value,path);
  try { new Intl.DateTimeFormat('en',{timeZone:s}); } catch { fail(path,'expected IANA timezone'); }
  if (!s.includes('/') && s !== 'UTC') fail(path,'expected IANA timezone');
  return s;
}
function unknownValue(value: unknown, path: string, validate = string) {
  const v=version(value,path);
  if (v.value === null) string(v.reason,`${path}.reason`);
  else { validate(v.value,`${path}.value`); if (v.reason !== null) fail(`${path}.reason`,'known value requires null reason'); }
}
function range(value: unknown,path:string) { const r=version(value,path); utc(r.from,`${path}.from`);utc(r.to,`${path}.to`);if(Date.parse(r.from)>=Date.parse(r.to))fail(path,'expected nonempty half-open range'); }
function projection(value:unknown){unknownValue(value,'analytics_projection',(v,p)=>{const r=version(v,p);string(r.summary,'projection.summary');string(r.subject,'projection.subject');array(r.scope,'projection.scope').forEach(s=>string(s,'projection.scope'));refs(r.event_refs,'projection.event_refs');record(r.attribution,'projection.attribution');return JSON.stringify(r);});}
function refs(value: unknown,path:string,fact=false) { array(value,path).forEach((v,i)=>{const r=version(v,`${path}[${i}]`);string(r[fact?'fact_id':'event_id'],path);if(fact&&(!Number.isSafeInteger(r.revision)||r.revision<1))fail(path,'expected positive fact revision');}); }
export function validateSourceEvent(value: unknown): SourceEvent {
  const r=version(value);string(r.event_id,'event_id');const s=version(r.source,'source');
  for(const key of ['provider','account_id','conversation_id'])string(s[key],`source.${key}`);
  nullableString(s.message_id,'source.message_id');nullableString(s.block_id,'source.block_id');
  for(const key of ['role','kind','physical_order','locator','generation'])string(r[key],key);
  nullableString(r.channel,'channel');nullableString(r.body,'body');nullableString(r.fragment_ref,'fragment_ref');
  if(r.body===null&&r.fragment_ref===null)fail('body','body or fragment_ref required');
  unknownValue(r.original_time,'original_time');unknownValue(r.utc_time,'utc_time',utc);
  unknownValue(r.wire_timezone,'wire_timezone');unknownValue(r.journal_timezone,'journal_timezone',zone);
  unknownValue(r.journal_date,'journal_date',date);nullableString(r.journal_timezone_basis,'journal_timezone_basis');
  choice(r.time_precision,['second','millisecond','microsecond','day','unknown'],'time_precision');
  choice(r.classification,['main','subagent','automation','unknown'],'classification');record(r.context,'context');return r as SourceEvent;
}
export function validateCoverage(value:unknown): SourceCoverage {
  const r=version(value);for(const key of ['coverage_id','provider','account_id'])string(r[key],key);nullableString(r.conversation_id,'conversation_id');
  choice(r.lane,['live','history'],'lane');range(r.query_range,'query_range');utc(r.cutoff,'cutoff');array(r.read_ranges,'read_ranges').forEach((v,i)=>range(v,`read_ranges[${i}]`));
  array(r.gaps,'gaps').forEach((v,i)=>{const g=version(v,`gaps[${i}]`);if(g.range!==null)range(g.range,'gap.range');string(g.reason,'gap.reason');nullableString(g.locator,'gap.locator');if(typeof g.resumable!=='boolean')fail('gap.resumable','expected boolean');});
  choice(r.capture_status,['complete','partial','unavailable','disabled','unknown'],'capture_status');choice(r.review_status,['complete','partial','pending','not_applicable'],'review_status');return r as SourceCoverage;
}
export function validateReviewBundle(value:unknown): ReviewBundle {
  const r=version(value);string(r.bundle_id,'bundle_id');choice(r.kind,['daily','weekly','monthly'],'kind');choice(r.lane,['live','history'],'lane');nullableString(r.period,'period');utc(r.cutoff,'cutoff');
  const seen=new Set<string>();array(r.chunks,'chunks').forEach(c=>{version(c,'chunk');string(c.chunk_id,'chunk_id');if(seen.has(c.chunk_id))fail('chunk_id','duplicate');seen.add(c.chunk_id);array(c.events,'events').forEach(validateSourceEvent);array(c.context_events,'context_events').forEach(validateSourceEvent);if(!Number.isSafeInteger(c.body_bytes)||c.body_bytes<0)fail('body_bytes','expected nonnegative integer');});
  array(r.existing_facts,'existing_facts');array(r.baselines,'baselines');array(r.coverage,'coverage').forEach(validateCoverage);array(r.unfinished,'unfinished');return r as ReviewBundle;
}
export function validateReviewResult(value: unknown, bundle?: ReviewBundle): ReviewResult {
  const r=version(value);string(r.result_id,'result_id');string(r.bundle_id,'bundle_id');utc(r.created_at,'created_at');
  if(bundle&&bundle.bundle_id!==r.bundle_id)fail('bundle_id','does not match persisted bundle');
  const chunks=new Map<string,any>();array(r.chunks,'chunks').forEach(c=>{version(c,'chunk');string(c.chunk_id,'chunk_id');if(chunks.has(c.chunk_id))fail('chunk_id','duplicate');choice(c.status,['complete','partial','deferred'],'chunk.status');array(c.reviewed_event_ids,'reviewed_event_ids').forEach(v=>string(v,'event_id'));if(typeof c.zero_facts!=='boolean')fail('zero_facts','expected boolean');nullableString(c.reason,'chunk.reason');chunks.set(c.chunk_id,c);});
  const ids=new Set<string>();array(r.candidates,'candidates').forEach(c=>{version(c,'candidate');string(c.candidate_id,'candidate_id');if(ids.has(c.candidate_id))fail('candidate_id','duplicate');ids.add(c.candidate_id);string(c.chunk_id,'chunk_id');if(!chunks.has(c.chunk_id))fail('candidate.chunk_id','missing chunk review');choice(c.disposition,['keep','add','replace','retract'],'disposition');string(c.content,'content');string(c.subject,'subject');unknownValue(c.occurred_at,'occurred_at',utc);unknownValue(c.journal_date,'journal_date',date);choice(c.kind,['fact','inference','recommendation','legacy_record'],'kind');refs(c.event_refs,'event_refs');refs(c.target_refs,'target_refs',true);array(c.scope,'scope').forEach(v=>string(v,'scope'));record(c.attribution,'attribution');projection(c.analytics_projection);if(['keep','replace','retract'].includes(c.disposition)&&!c.target_refs.length)fail('target_refs','disposition requires explicit targets');if(c.disposition==='add'&&c.target_refs.length)fail('target_refs','add must not have targets');for(const key of ['fact_id','revision','operation_id'])if(key in c)fail(key,'application assigns permanent IDs');});
  array(r.pages,'pages').forEach(p=>{version(p,'page');for(const k of ['suggestion_id','path','baseline_digest'])string(p[k],k);date(p.date,'page.date');choice(p.mode,['append','replace'],'page.mode');nullableString(p.old_text,'page.old_text');if(typeof p.new_text!=='string')fail('new_text','expected string');if(p.mode==='replace'&&(p.old_text===null||!p.old_text.length))fail('old_text','exact replacement requires nonempty old text');array(p.candidate_ids,'candidate_ids').forEach(id=>{if(!ids.has(id))fail('candidate_ids','unknown candidate');});});
  for(const [id,c] of chunks){const n=r.candidates.filter((f:any)=>f.chunk_id===id).length;if(c.zero_facts&&n)fail('zero_facts','chunk has candidates');if(c.status==='complete'&&!n&&!c.zero_facts)fail('zero_facts','complete zero-fact review must be explicit');}
  if(bundle){const known=new Map(bundle.chunks.map(c=>[c.chunk_id,c]));for(const [id,c] of chunks){const chunk=known.get(id);if(!chunk)fail('chunk_id','not in bundle');const eventIds=new Set(chunk.events.map(e=>e.event_id));for(const e of c.reviewed_event_ids)if(!eventIds.has(e))fail('reviewed_event_ids','not in chunk');if(c.status==='complete'&&new Set(c.reviewed_event_ids).size!==eventIds.size)fail('reviewed_event_ids','complete chunk must cover all events');}const allowed=new Set(bundle.chunks.flatMap(c=>[...c.events,...c.context_events].map(e=>e.event_id)));for(const c of r.candidates)for(const ref of c.event_refs)if(!allowed.has(ref.event_id))fail('event_refs','not in bundle');}
  return r as ReviewResult;
}
export function validateFactArtifact(value:unknown): FactArtifact { const r=version(value);string(r.batch_id,'batch_id');utc(r.created_at,'created_at');array(r.facts,'facts').forEach(f=>{version(f,'fact');string(f.fact_id,'fact_id');if(!Number.isSafeInteger(f.revision)||f.revision<1)fail('revision','expected positive revision');choice(f.action,['assert','replace','retract'],'action');refs(f.event_refs,'event_refs');refs(f.target_refs,'target_refs',true);});array(r.coverage,'coverage').forEach(validateCoverage);array(r.affected_dates,'affected_dates').forEach(v=>date(v,'affected_date'));array(r.affected_weeks,'affected_weeks').forEach(v=>date(v,'affected_week'));return r as FactArtifact; }
export function validateManifest(value:unknown): Manifest { const r=version(value);string(r.manifest_id,'manifest_id');choice(r.kind,['import','migration'],'kind');array(r.entries,'entries').forEach((e,i)=>record(e,`entries[${i}]`));return r as Manifest; }
/** JSON lexical pass preserves wide integers before JSON.parse can round them. */
export function parseJsonPreservingIntegers(text:string): unknown {
  let result='',inString=false,escaped=false;
  for(let i=0;i<text.length;){const ch=text[i];if(inString){result+=ch;i++;if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')inString=false;continue;}if(ch==='"'){inString=true;result+=ch;i++;continue;}if(ch==='-'||/\d/.test(ch)){const m=text.slice(i).match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);if(m){const token=m[0];if(/^-?\d+$/.test(token)&&/^(-?)(0|[1-9]\d*)$/.test(token)&&(BigInt(token)>BigInt(Number.MAX_SAFE_INTEGER)||BigInt(token)<BigInt(Number.MIN_SAFE_INTEGER)))result+=JSON.stringify(token);else result+=token;i+=token.length;continue;}}result+=ch;i++;}
  try{return JSON.parse(result);}catch(e){throw new InputError(`invalid JSON: ${(e as Error).message}`);}
}
