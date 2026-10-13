import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { absolutePath } from './config.ts';
import { InputError, parseJsonPreservingIntegers, validateReviewBundle, version, array } from './contracts/validation.ts';
import type { ReviewBundle, SourceEvent, JournalWorkBundle, AcceptedDailyInventory, JournalConfirmationProposal } from './contracts/types.ts';

export type MaterialSection = 'events' | 'facts' | 'baselines' | 'summary' | 'work' | 'conflicts' | 'accepted' | 'targets' | 'results' | 'patches' | 'archive_contexts' | 'coverage' | 'unfinished' | 'metadata';
export const MATERIAL_SECTIONS: MaterialSection[] = ['events','facts','baselines','summary','work','conflicts','accepted','targets','results','patches','archive_contexts','coverage','unfinished','metadata'];
export const MAX_MATERIAL_INPUT_BYTES = 16 * 1024 * 1024;

/** Reads only one explicitly supplied saved bundle; never opens sources, Wiki or SQLite. */
export async function readReviewMaterial(path: string): Promise<ReviewBundle | JournalWorkBundle | AcceptedDailyInventory | JournalConfirmationProposal> {
  absolutePath(path, 'input');
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new InputError('Review material must be a regular file');
    if (stat.size > MAX_MATERIAL_INPUT_BYTES) throw new InputError('Review material exceeds the explicit 16 MiB input bound');
    const bytes = Buffer.alloc(MAX_MATERIAL_INPUT_BYTES + 1);
    let count = 0;
    while (count < bytes.length) {
      const page = await handle.read(bytes, count, bytes.length - count, count);
      if (!page.bytesRead) break;
      count += page.bytesRead;
    }
    if (count > MAX_MATERIAL_INPUT_BYTES) throw new InputError('Review material exceeds the explicit 16 MiB input bound');
    const value = version(parseJsonPreservingIntegers(bytes.subarray(0, count).toString('utf8')));
    if(value.proposal_id){array(value.fact_refs,'fact_refs');array(value.work_ids,'work_ids');return value as JournalConfirmationProposal;}
    if (value.journal_bundle_id) { for (const key of ['work','facts','existing_facts','baselines','conflicts']) array(value[key], key); return value as JournalWorkBundle; }
    if (Array.isArray(value.items) && 'next_result_id' in value) return value as AcceptedDailyInventory;
    return validateReviewBundle(value);
  } finally { await handle.close(); }
}

function renderEvent(event: SourceEvent, chunkId: string, materialRole: 'primary' | 'context', index: number) {
  return {
    index, chunk_id: chunkId, material_role: materialRole,
    event_id: event.event_id, source: event.source, role: event.role, kind: event.kind, channel: event.channel,
    source_slice: event.context.review_slice ?? null,
    evidence_offset_basis: 'immutable_original_body_utf8',
    supplied_review_unit: materialRole==='primary' ? (event.context.review_slice ? {schema_version:1,event_id:(event.context.review_slice as Record<string,unknown>).source_event_id,start_byte:(event.context.review_slice as Record<string,unknown>).start_byte,end_byte:(event.context.review_slice as Record<string,unknown>).end_byte} : {schema_version:1,event_id:event.event_id,start_byte:0,end_byte:Buffer.byteLength(event.body??'')}) : null,
    original_time: event.original_time, utc_time: event.utc_time, time_precision: event.time_precision,
    wire_timezone: event.wire_timezone, journal_timezone: event.journal_timezone,
    journal_timezone_basis: event.journal_timezone_basis, journal_date: event.journal_date,
    classification: event.classification, physical_order: event.physical_order,
    body: event.body, body_bytes: event.body === null ? null : Buffer.byteLength(event.body),
    body_unavailable_reason: event.body === null ? 'Full body is absent from this saved bundle; inspect its fragment through a separately authorized source reader.' : null,
    fragment_ref: event.fragment_ref, locator: event.locator, generation: event.generation, context: event.context,
  };
}

/** Whole records only. Offset/limit never truncate text or imply reviewed/completed progress. */
export function inspectReviewMaterial(value: unknown, section: MaterialSection = 'events', offset = 0, limit = 20) {
  const supplied = version(value);
  if (!MATERIAL_SECTIONS.includes(section)) throw new InputError('Unknown inspection section');
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 80) throw new InputError('offset must be nonnegative; limit must be1–80');
  if (supplied.journal_bundle_id || (Array.isArray(supplied.items) && 'next_result_id' in supplied)) return inspectJournalMaterial(supplied, section, offset, limit);
  const bundle = validateReviewBundle(value);
  if (!['events', 'facts', 'baselines', 'summary', 'archive_contexts'].includes(section)) throw new InputError('section must be events|facts|baselines|summary|archive_contexts');
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 80) throw new InputError('offset must be nonnegative; limit must be 1–80');
  const events = bundle.chunks.flatMap(chunk => [
    ...chunk.events.map(event => ({ event, chunkId: chunk.chunk_id, materialRole: 'primary' as const })),
    ...chunk.context_events.map(event => ({ event, chunkId: chunk.chunk_id, materialRole: 'context' as const })),
  ]);
  const facts=[...new Map([...bundle.existing_facts,...(bundle.monthly_context?.facts??[]),...(bundle.analysis_context?.facts??[])].map(fact=>{
    const ref='fact_ref' in fact?fact.fact_ref:{schema_version:1,fact_id:fact.fact_id,revision:fact.revision};return [ref.fact_id+':'+ref.revision,{...fact,fact_ref:ref}];
  })).values()];
  const archives=bundle.monthly_context?.archive_contexts??[];
  const {facts:_monthlyFacts,archive_contexts:_archives,...monthlyContext}=bundle.monthly_context??{};
  const {facts:_weeklyFacts,...analysisContext}=bundle.analysis_context??{};
  const counts = { facts:facts.length,archive_contexts:archives.length, chunks: bundle.chunks.length, primary_events: events.filter(item => item.materialRole === 'primary').length, context_events: events.filter(item => item.materialRole === 'context').length, existing_facts: bundle.existing_facts.length, baselines: bundle.baselines.length };
  const total = section === 'events' ? events.length : section === 'facts' ? facts.length : section==='archive_contexts'?archives.length : section === 'baselines' ? bundle.baselines.length : 1;
  if (offset > total) throw new InputError('offset exceeds supplied section record count');
  const end = Math.min(total, offset + limit);
  const items = section === 'events' ? events.slice(offset, end).map((item, index) => renderEvent(item.event, item.chunkId, item.materialRole, offset + index))
    : section === 'facts' ? facts.slice(offset,end).map((fact,index)=>({index:offset+index,...fact}))
    : section==='archive_contexts'?archives.slice(offset,end).map((record,index)=>({index:offset+index,...record,text_completeness:record.excerpt_reason===null?'complete':'excerpt',content_bytes:Buffer.byteLength(record.content_excerpt)}))
    : section === 'baselines' ? bundle.baselines.slice(offset, end).map((baseline, index) => ({ index: offset + index, ...baseline,
      text_completeness: baseline.digest === 'absent' ? 'absent' : baseline.content === null ? 'unavailable' : baseline.context_excerpt === true ? 'excerpt' : 'complete',
      content_bytes: baseline.content === null ? null : Buffer.byteLength(baseline.content),
    }))
    : offset === 0 ? [{ chunks: bundle.chunks.map(chunk => ({ chunk_id: chunk.chunk_id, primary_events: chunk.events.length, context_events: chunk.context_events.length, body_bytes: chunk.body_bytes })), coverage: bundle.coverage, unfinished: bundle.unfinished,...(bundle.monthly_context?{monthly_context:monthlyContext}:{}),...(bundle.analysis_context?{analysis_context:analysisContext}:{}) }] : [];
  return {
    schema_version: 1, inspection_only: true,
    bundle: { bundle_id: bundle.bundle_id, source: bundle.source ?? null, kind: bundle.kind, lane: bundle.lane, period: bundle.period, cutoff: bundle.cutoff, replay: bundle.replay ?? null },
    counts, page: { section, offset, limit, total, next_offset: end < total ? end : null }, items,
  };
}

function inspectJournalMaterial(value: Record<string,any>, section: MaterialSection, offset: number, limit: number) {
  const journal = typeof value.journal_bundle_id === 'string';
  if (section === 'events') section = journal ? 'work' : 'accepted';
  const rows: Record<string,unknown[]> = {};
  if (journal) {
    for (const key of ['work','facts','existing_facts','baselines','conflicts']) array(value[key], key);
    rows.work = value.work; rows.conflicts = value.conflicts; rows.baselines = value.baselines;
    rows.facts = [...value.facts.map((f:any) => ({ material_role: 'accepted', ...f })), ...value.existing_facts.map((f:any) => ({ material_role: 'context', ...f }))];
    rows.targets = value.existing_facts;
    rows.summary = [{ journal_bundle_id: value.journal_bundle_id, cutoff: value.cutoff, counts: { work: rows.work.length, facts: value.facts.length, related_facts: value.existing_facts.length, baselines: rows.baselines.length, conflicts: rows.conflicts.length } }];
  } else {
    const items = array(value.items, 'items'); rows.accepted = items;
    for (const key of ['facts','targets','conflicts','patches']) rows[key] = items.flatMap((item:any) => array(item[key], key).map(row => ({ result_id: item.result_id, ...row })));
    rows.results = items.map((item:any) => ({ result_id: item.result_id, accepted_at: item.accepted_at, result_created_at: item.result_created_at, acceptance_time_basis: item.acceptance_time_basis, window_membership: item.window_membership, result: item.result }));
    rows.baselines = items.flatMap((item:any) => array(item.bundle.baselines, 'baselines').map(baseline => ({ result_id: item.result_id, ...baseline })));
    rows.summary = [{ items: items.length, unknown_acceptance: items.filter((item:any) => item.window_membership === 'unknown').length, next_result_id: value.next_result_id }];
  }
  if (!rows[section]) throw new InputError(`Section ${section} is unavailable for this material; choose ${Object.keys(rows).join('|')}`);
  const total = rows[section].length;
  if (offset > total) throw new InputError('offset exceeds supplied section record count');
  const end = Math.min(total, offset + limit);
  const items = rows[section].slice(offset, end).map((row:any,index) => ({ index: offset + index, ...row,
    ...(section === 'baselines' ? { text_completeness: row.digest === 'absent' ? 'absent' : row.content === null ? 'unavailable' : row.context_excerpt ? 'excerpt' : 'complete', content_bytes: row.content === null ? null : Buffer.byteLength(row.content) } : {}) }));
  return { schema_version: 1, inspection_only: true, material_kind: journal ? 'journal_work' : 'accepted_daily_inventory',
    journal_bundle_id: value.journal_bundle_id ?? null, cutoff: value.cutoff ?? null,
    page: { section, offset, limit, total, next_offset: end < total ? end : null }, items };
}


export const MAX_INSPECTION_PAGE_BYTES = 16 * 1024;
export interface InspectionCursorV2 { schema_version: 2; material_digest: string; section: MaterialSection; item_index: number; byte_offset: number }
export interface InspectionFragmentV2 {
  item_id: string; item_sha256: string; item_index: number;
  byte_start: number; byte_end: number; total_bytes: number; json_fragment: string;
}
export interface InspectionPageV2 {
  schema_version: 2; inspection_only: true; material_digest: string;
  section: MaterialSection; total_items: number; fragments: InspectionFragmentV2[];
  next_cursor: InspectionCursorV2 | null;
}
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
function inspectionRows(value: unknown, section: MaterialSection): unknown[] {
  const supplied = version(value), journal = Boolean(supplied.journal_bundle_id), inventory = Array.isArray(supplied.items) && 'next_result_id' in supplied;
  if (!MATERIAL_SECTIONS.includes(section)) throw new InputError('Unknown inspection section');
  if(section==='metadata'&&(journal||inventory||supplied.proposal_id)){
    const {work,facts,existing_facts,baselines,conflicts,items,old_text,new_text,...metadata}=supplied;
    return [{...metadata,...(journal?{work_ids:work.map((item:any)=>item.work_id),fact_refs:facts.map((item:any)=>({fact_id:item.fact_id,revision:item.revision})),existing_fact_refs:existing_facts.map((item:any)=>({fact_id:item.fact_id,revision:item.revision}))}:{}),...(inventory?{result_ids:items.map((item:any)=>item.result_id)}:{})}];
  }
  if(section==='metadata'&&!journal&&!inventory&&!supplied.proposal_id){
    const b=validateReviewBundle(value),{chunks,existing_facts,baselines,coverage,unfinished,monthly_context,analysis_context,...rest}=b;
    const ref=(fact:any)=>'fact_ref' in fact?fact.fact_ref:{schema_version:1,fact_id:fact.fact_id,revision:fact.revision};
    const monthly=monthly_context?(({facts,archive_contexts,...context})=>({...context,fact_refs:facts.map(ref),archive_context_ids:(archive_contexts??[]).map(item=>item.work_id)}))(monthly_context):undefined;
    const analysis=analysis_context?(({facts,...context})=>({...context,fact_refs:facts.map(ref)}))(analysis_context):undefined;
    return [{...rest,chunk_metadata:chunks.map(({events,context_events,...chunk})=>chunk),existing_fact_refs:existing_facts.map(ref),...(monthly?{monthly_context:monthly}:{}),...(analysis?{analysis_context:analysis}:{})}];
  }
  if(supplied.proposal_id){
    if(section==='summary')return [{proposal_id:supplied.proposal_id,proposal_digest:supplied.proposal_digest,state:supplied.state,path:supplied.path,read_state:'summary_only',sections:[{section:'metadata',total_items:1,read_state:'unread'},{section:'patches',total_items:1,read_state:'unread'},{section:'facts',total_items:supplied.fact_refs.length,read_state:'unread'},{section:'work',total_items:supplied.work_ids.length,read_state:'unread'}]}];
    if(section==='patches')return [supplied];if(section==='facts')return supplied.fact_refs;if(section==='work')return supplied.work_ids.map((work_id:string)=>({work_id}));throw new InputError('Proposal supports summary|patches|facts|work');
  }
  if (!journal && !inventory && (section === 'coverage' || section === 'unfinished')) {
    const bundle = validateReviewBundle(value); return section === 'coverage' ? bundle.coverage : bundle.unfinished;
  }
  if (section === 'summary') {
    const first = inspectReviewMaterial(value, 'summary', 0, 1) as Record<string,any>;
    const available: MaterialSection[] = journal ? ['work','facts','baselines','conflicts','targets','metadata'] : inventory ? ['accepted','facts','targets','conflicts','patches','results','baselines','metadata'] : ['events','facts','baselines','archive_contexts','coverage','unfinished','metadata'];
    const directory = available.map(name => ({ section: name, total_items: name==='metadata'?1:name === 'coverage' ? supplied.coverage.length : name === 'unfinished' ? supplied.unfinished.length : inspectReviewMaterial(value,name,0,1).page.total, read_state: 'unread' }));
    return [{ material_identity: first.bundle ?? { journal_bundle_id:first.journal_bundle_id ?? null, material_kind:first.material_kind }, counts:first.counts ?? first.items[0]?.counts ?? {accepted_items:supplied.items?.length ?? 0}, sections:directory, read_state:'summary_only', review_complete:false }];
  }
  const first = inspectReviewMaterial(value, section, 0, 1);
  const rows: unknown[] = [];
  for (let offset = 0; offset < first.page.total; offset += 80) rows.push(...inspectReviewMaterial(value,section,offset,80).items);
  return rows;
}
/** Actual compact stdout bytes (including newline) are bounded; fragments reconstruct one exact JSON item. */
export function inspectReviewMaterialV2(value: unknown, section: MaterialSection = 'summary', cursor?: InspectionCursorV2, offset = 0, limit = 80): InspectionPageV2 {
  const materialDigest = digest(JSON.stringify(value));
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 80) throw new InputError('Invalid inspection offset/limit');
  if (cursor && (cursor.schema_version !== 2 || cursor.material_digest !== materialDigest || cursor.section !== section || !Number.isSafeInteger(cursor.item_index) || cursor.item_index < 0 || !Number.isSafeInteger(cursor.byte_offset) || cursor.byte_offset < 0)) throw new InputError('Inspection cursor does not match exact material/section');
  const rows = inspectionRows(value, section);
  let index = cursor?.item_index ?? offset, start = cursor?.byte_offset ?? 0;
  if (index > rows.length || (index === rows.length && start !== 0)) throw new InputError('Inspection cursor exceeds section');
  const page: InspectionPageV2 = { schema_version:2, inspection_only:true, material_digest:materialDigest, section, total_items:rows.length, fragments:[], next_cursor:null };
  const next = (item: number, byte: number): InspectionCursorV2 | null => item < rows.length ? {schema_version:2,material_digest:materialDigest,section,item_index:item,byte_offset:byte} : null;
  while (index < rows.length && page.fragments.length < limit) {
    const bytes = Buffer.from(JSON.stringify(rows[index])), itemHash = digest(bytes);
    if (start >= bytes.length || (start > 0 && (bytes[start] & 0xc0) === 0x80)) throw new InputError('Inspection cursor is not an item UTF-8 boundary');
    const make = (end: number): InspectionPageV2 => ({ ...page,
      fragments:[...page.fragments,{item_id:digest(`${materialDigest}:${section}:${index}`),item_sha256:itemHash,item_index:index,byte_start:start,byte_end:end,total_bytes:bytes.length,json_fragment:bytes.subarray(start,end).toString('utf8')}],
      next_cursor:end < bytes.length ? next(index,end) : next(index+1,0) });
    const fits = (end:number) => Buffer.byteLength(JSON.stringify(make(end))+'\n') <= MAX_INSPECTION_PAGE_BYTES;
    if (fits(bytes.length)) {
      const full=make(bytes.length); page.fragments=full.fragments;page.next_cursor=full.next_cursor;index++;start=0;continue;
    }
    const boundary = (end:number) => { while(end>start && end<bytes.length && (bytes[end]&0xc0)===0x80)end--;return end; };
    let low=start, high=Math.min(bytes.length,start+MAX_INSPECTION_PAGE_BYTES);
    while(low<high){const middle=Math.ceil((low+high)/2),end=boundary(middle);if(end===start){low=middle;continue;}if(fits(end))low=middle;else high=middle-1;}
    const end=boundary(low);
    if(end<=start){if(page.fragments.length){page.next_cursor=next(index,start);break;}throw new InputError('Inspection envelope cannot contain one complete codepoint');}
    const partial=make(end);page.fragments=partial.fragments;page.next_cursor=partial.next_cursor;break;
  }
  if(Buffer.byteLength(JSON.stringify(page)+'\n')>MAX_INSPECTION_PAGE_BYTES)throw new InputError('Inspection byte bound violated');
  return page;
}
export function encodeInspectionCursor(cursor: InspectionCursorV2): string { return Buffer.from(JSON.stringify(cursor)).toString('base64url'); }
export function decodeInspectionCursor(value: string): InspectionCursorV2 {
  if(value.startsWith('{')&&value.length<=2048){try{return JSON.parse(value) as InspectionCursorV2;}catch{throw new InputError('Invalid inspection cursor JSON');}}
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length>2048) throw new InputError('Invalid inspection cursor token');
  try{return JSON.parse(Buffer.from(value,'base64url').toString('utf8')) as InspectionCursorV2;}catch{throw new InputError('Invalid inspection cursor JSON');}
}
