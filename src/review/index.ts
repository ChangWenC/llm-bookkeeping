import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { BookkeepingConfig, Reviewer, Store, ReviewBundle, ReviewChunk, SourceEvent, PrepareRequest, ReviewResult, TimeRange, CoverageGap, PageBaseline } from '../contracts/types.ts';
import { SqliteStore, canonical, digest } from '../store/index.ts';
import { validateReviewResult, utc, date } from '../contracts/validation.ts';

function localDate(time: string, zone: string): string { return new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(time)); }
function addDays(value: string, amount: number): string { const d = new Date(value + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate()+amount); return d.toISOString().slice(0,10); }
/** Resolve local midnight using actual IANA offsets (including DST), never the host timezone. */
function midnight(value: string, zone: string): string {
  let guess = Date.parse(value+'T00:00:00Z'); const target = guess;
  for (let n=0;n<5;n++) { const parts = new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(guess)); const p = Object.fromEntries(parts.map(x=>[x.type,x.value])); const wall = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`); const next = guess + target-wall; if (next===guess) return new Date(guess).toISOString(); guess=next; }
  throw new Error('Cannot resolve period midnight in timezone '+zone);
}
function requestRange(request: PrepareRequest, config: BookkeepingConfig): TimeRange {
  utc(request.cutoff,'cutoff'); if (!['daily','weekly','monthly'].includes(request.kind) || !['live','history'].includes(request.lane)) throw new Error('Invalid review kind/lane');
  let from: string; let to = request.cutoff;
  if (request.period) {
    const historical=request.period+'T12:00:00Z';
    const timeline=[...config.journal_timezone_timeline].sort((a,b)=>Date.parse(a.effective_from)-Date.parse(b.effective_from));
    const zone = request.kind==='daily' ? timeline.filter(entry=>Date.parse(entry.effective_from)<=Date.parse(historical)).at(-1)?.timezone??config.journal_timezone : config.analysis_timezone;
    if (request.kind==='monthly') { if (!/^\d{4}-\d\d$/.test(request.period)) throw new Error('Monthly period must be YYYY-MM'); date(request.period+'-01','period'); from=midnight(request.period+'-01',zone); const next = new Date(request.period+'-01T12:00:00Z'); next.setUTCMonth(next.getUTCMonth()+1); to=midnight(next.toISOString().slice(0,10),zone); }
    else { date(request.period,'period'); from=midnight(request.kind==='weekly' ? addDays(request.period,-6) : request.period,zone); to=midnight(addDays(request.period,1),zone); }
    if (Date.parse(to)>Date.parse(request.cutoff)) to=request.cutoff;
  } else if (request.kind==='daily') from = request.lane==='live' ? new Date(Math.max(Date.parse(config.live_start),Date.parse(request.cutoff)-48*3600_000)).toISOString() : '0001-01-01T00:00:00.000Z';
  else {
    const today=localDate(request.cutoff,config.analysis_timezone); from=request.kind==='monthly' ? midnight(today.slice(0,7)+'-01',config.analysis_timezone) : midnight(addDays(today,-(new Date(today+'T12:00:00Z').getUTCDay()+6)%7),config.analysis_timezone);
  }
  if (Date.parse(from)>=Date.parse(to)) throw new Error('Review period is beyond cutoff'); return {schema_version:1,from,to};
}
function* slices(event: SourceEvent, limit: number, reviewedSpans: {start_byte:number;end_byte:number}[]): Generator<SourceEvent> {
  const body=event.body ?? ''; const bytes=Buffer.from(body);
  if(bytes.length<=limit&&!reviewedSpans.length){yield event;return;}
  const intervals:{start:number;end:number}[]=[];let frontier=0;
  for(const span of reviewedSpans){if(span.start_byte>frontier)intervals.push({start:frontier,end:span.start_byte});frontier=Math.max(frontier,span.end_byte);}
  if(frontier<bytes.length)intervals.push({start:frontier,end:bytes.length});
  for(const interval of intervals)for (let start=interval.start;start<interval.end;) {
    let end=Math.min(interval.end,start+limit);
    while(end<bytes.length && (bytes[end]&0xc0)===0x80) end--;
    if(end<=start) throw new Error('chunk_body_bytes cannot fit a UTF-8 character');
    const context={...event.context,review_slice:{source_event_id:event.event_id,start_byte:start,end_byte:end,total_bytes:bytes.length}};
    yield {...event,event_id:'slice:'+digest(canonical([event.event_id,start,end])),body:bytes.subarray(start,end).toString('utf8'),context};start=end;
  }
}
const gap=(reason:string,range:TimeRange|null=null,locator:string|null=null):CoverageGap=>({schema_version:1,range,reason,locator,resumable:true});
async function baseline(config: BookkeepingConfig, path: string): Promise<PageBaseline> {
  const filename=join(config.wiki_root,path); try { const info=await stat(filename); if(info.size>config.limits.bundle_bytes/3) throw new Error('Page baseline exceeds bounded preparation budget'); const content=await readFile(filename,'utf8'); return {schema_version:1,path,digest:digest(content),content}; } catch(error:any) { if(error.code==='ENOENT') return {schema_version:1,path,digest:'absent',content:null}; throw error; }
}
function targetPath(kind: string, event: SourceEvent | undefined, config: BookkeepingConfig, cutoff: string, period?: string): string {
  if(kind==='weekly') return 'wiki/personal/synthesis/综合_self_analytics_current.md';
  const day=event?.journal_date.value ?? localDate(cutoff,config.journal_timezone); const current=localDate(cutoff,config.journal_timezone).slice(0,7); const previous=new Date(current+'-01T12:00:00Z'); previous.setUTCMonth(previous.getUTCMonth()-1); const keepFrom=previous.toISOString().slice(0,7);
  if(kind==='monthly' || day.slice(0,7)<keepFrom) return `wiki/personal/journals/reviews/回顾_${(kind==='monthly' ? period ?? day.slice(0,7) : day.slice(0,7)).replaceAll('-','_')}.md`;
  return 'wiki/personal/journals/日记_'+day.replaceAll('-','_')+'.md';
}

export function createReviewer(store: Store, config: BookkeepingConfig): Reviewer {
  if (!(store instanceof SqliteStore)) throw new Error('Reviewer requires transactional SQLite store');
  for(const [key,value] of Object.entries(config.limits)) if(!Number.isSafeInteger(value)||value<1) throw new Error('Invalid review limit '+key);
  return {
    async prepare(request: PrepareRequest): Promise<ReviewBundle[]> {
      const range=requestRange(request,config); const limits=config.limits; const reviewed=store.getReviewedUnits(request.kind,request.lane);
      // Each page fetch is bounded; fully reviewed sources are excluded in SQL so a historical prefix cannot starve new work.
      const events=request.kind==='daily'?await store.getReviewableEvents({range,lane:request.lane,limit:limits.chunk_events*limits.bundles_per_round*4},request.kind):[];
      const effectiveFacts=await store.readEffectiveFacts({range});
      const facts=request.kind==='daily'?effectiveFacts:effectiveFacts.flatMap(f=>{const projection=f.analytics_projection?.value;if(!projection)return [];return [{...f,content:projection.summary,scope:projection.scope,subject:projection.subject,event_refs:projection.event_refs,attribution:projection.attribution}];});
      const coverage=(await store.listCoverage(range)).filter(c=>c.lane===request.lane);
      const unfinished=coverage.flatMap(c=>c.gaps);
      if(request.kind!=='daily')unfinished.push(gap('Weekly/monthly semantic snapshot, confirmation and action payload pending explicit downstream contract',range));
      if(request.kind!=='daily'&&facts.length<effectiveFacts.length)unfinished.push(gap('Facts without an explicit professional projection excluded from analytics material',range));
      if(!coverage.length) unfinished.push(gap('No capture coverage for requested range',range));
      for(const provider of config.providers.filter(p=>p.enabled)) if(!coverage.some(c=>c.provider===provider.provider&&c.account_id===provider.account_id)) unfinished.push(gap('Provider has no capture coverage: '+provider.provider,range));
      const chunks:ReviewChunk[]=[]; let pending:SourceEvent[]=[]; let bodyBytes=0;
      const flush=()=>{
        if(!pending.length)return;
        const contextEvents:SourceEvent[]=[];
        const first=pending[0];
        for(const context of store.getContextEvents(first)) {
          if(pending.some(e=>e.event_id===context.event_id))continue;
          const bytes=Buffer.byteLength(context.body??'');
          if(bodyBytes+bytes<=limits.chunk_body_bytes){contextEvents.push(context);bodyBytes+=bytes;}
          else unfinished.push(gap('Conversation context omitted by chunk byte budget',null,context.locator));
        }
        const chunk:ReviewChunk={schema_version:1,chunk_id:'chunk:'+digest(canonical([request.kind,request.lane,pending.map(e=>e.event_id),contextEvents.map(e=>e.event_id)])),events:pending,context_events:contextEvents,body_bytes:bodyBytes};
        chunks.push(chunk);pending=[];bodyBytes=0;
      };
      // Reserve room for baselines, coverage and existing facts rather than filling the round with body bytes alone.
      const capacity=limits.bundles_per_round;
      const units=function*(){for(const event of events)for(const unit of slices(event,limits.chunk_body_bytes,store.getReviewedSpans(request.kind,request.lane,event.event_id)))if(!reviewed.has(unit.event_id))yield unit;};
      for(const unit of units()) {
        if(unit.context.turn_complete===false || unit.context.incomplete_turn===true){unfinished.push(gap('Incomplete source turn requires subsequent context',null,unit.locator));continue;}
        const bytes=Buffer.byteLength(unit.body??''); if(pending.length&&(pending.length>=limits.chunk_events||bodyBytes+bytes>limits.chunk_body_bytes||pending[0].journal_date.value!==unit.journal_date.value))flush();
        if(chunks.length>=capacity){unfinished.push(gap('Unprepared event slices remain',range,unit.locator));break;}
        pending.push(unit);bodyBytes+=bytes;
      } flush();
      if(!chunks.length) {
        if(request.kind==='daily' && !events.length && (await store.listEvents({range,lane:request.lane,limit:1})).length) return [];
        // Empty material is an explicit review decision; missing capture remains pending even if zero-facts is accepted.
        const id='empty:'+digest(canonical([request.kind,request.lane,range,coverage.map(c=>({...c,review_status:null})),facts])); if(reviewed.has(id)) return [];
        chunks.push({schema_version:1,chunk_id:id,events:[],context_events:[],body_bytes:0});
      }
      const bundles:ReviewBundle[]=[]; let current:ReviewBundle|null=null;
      const finish=async()=>{if(!current)return; current.bundle_id='bundle:'+digest(canonical({...current,bundle_id:null})); await store.saveBundle(current);bundles.push(current);current=null;};
      for(const chunk of chunks) {
        if(bundles.length>=limits.bundles_per_round)break;
        if(!current) current={schema_version:1,bundle_id:'',kind:request.kind,lane:request.lane,period:request.period??null,cutoff:request.cutoff,chunks:[],existing_facts:[],baselines:[],coverage:[],unfinished:[]};
        const path=targetPath(request.kind,chunk.events[0],config,request.cutoff,request.period); let base:PageBaseline|undefined;
        try { base=await baseline(config,path); } catch(error:any){if(!current.unfinished.some(g=>g.locator===path))current.unfinished.push(gap(error.message,null,path));}
        const proposed={...current,chunks:[...current.chunks,chunk],baselines:base&&!current.baselines.some(b=>b.path===path)?[...current.baselines,base]:current.baselines};
        if(Buffer.byteLength(canonical(proposed))+128>limits.bundle_bytes) {
          if(!current.chunks.length){unfinished.push(gap('Event metadata cannot fit bundle budget',range,chunk.events[0]?.locator??null));continue;}
          await finish(); if(bundles.length>=limits.bundles_per_round)break; current={...proposed,chunks:[chunk],baselines:base?[base]:[],existing_facts:[],coverage:[],unfinished:[]};
          if(Buffer.byteLength(canonical(current))+128>limits.bundle_bytes){current=null;continue;}
        } else current=proposed;
        // Fit evidence metadata without breaking the hard serialized bound. Omitted context is explicitly reported.
        for(const c of coverage) if(!current.coverage.some(x=>x.coverage_id===c.coverage_id)){const p={...current,coverage:[...current.coverage,c]}; if(Buffer.byteLength(canonical(p))+256<=limits.bundle_bytes)current=p;}
        for(const fact of facts) if(!current.existing_facts.some(f=>f.fact_id===fact.fact_id&&f.revision===fact.revision)){const p={...current,existing_facts:[...current.existing_facts,fact]}; if(Buffer.byteLength(canonical(p))+512<=limits.bundle_bytes)current=p;}
        for(const g of unfinished){const p={...current,unfinished:[...current.unfinished,g]}; if(Buffer.byteLength(canonical(p))+256<=limits.bundle_bytes)current=p;}
        if(current.coverage.length<coverage.length || current.existing_facts.length<facts.length){const p={...current,unfinished:[...current.unfinished,gap('Coverage or existing fact context omitted by bundle byte budget',range)]};if(Buffer.byteLength(canonical(p))+128<=limits.bundle_bytes)current=p;}
      }
      await finish(); return bundles;
    },
    async accept(result: ReviewResult) { const bundle=await store.getBundle(result.bundle_id); if(!bundle)throw new Error('Unknown review bundle'); validateReviewResult(result);return store.commitReview(result); }
  };
}
