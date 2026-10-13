import type { EventRef,ReviewBundle,ReviewResult,ReviewUnit,SourceEvent } from '../contracts/types.ts';
import { canonical } from '../analytics/serialization.ts';
import { refKey,version,unique } from './domain.ts';
import type {DatabaseSync} from 'node:sqlite';
export function exactReviewUnit(event:SourceEvent):ReviewUnit {
    const slice=event.context.review_slice as ReviewUnit&{source_event_id:string}|undefined;
    return slice?{schema_version:1,event_id:slice.source_event_id,start_byte:slice.start_byte,end_byte:slice.end_byte}:{schema_version:1,event_id:event.event_id,start_byte:0,end_byte:Buffer.byteLength(event.body??'')};
}
export function unreadMedia(event:SourceEvent):boolean {
    return event.body===null || event.role==='unknown' || event.context.incomplete_turn===true || event.context.media_unread===true || event.context.media_transcription_disabled===true || event.context.media_transcribed!==true&&(/^(image|audio|video|media:)/i.test(event.kind) || event.source.provider==='wechat'&&event.context.media_transcribed===false&&!['text','Text','message','1'].includes(event.kind));
}
export const overlaps=(a:ReviewUnit,b:ReviewUnit)=>a.event_id===b.event_id&&(a.start_byte<b.end_byte&&b.start_byte<a.end_byte || a.start_byte===a.end_byte&&b.start_byte===b.end_byte&&a.start_byte===b.start_byte);
export function suppliedSpan(event:SourceEvent,ref:ReviewUnit|EventRef):ReviewUnit {
    version(ref);if('block_id' in ref&&ref.block_id!==undefined&&ref.block_id!==event.source.block_id)throw new Error('Evidence block differs from frozen original');const supplied=exactReviewUnit(event),bytes=Buffer.from(event.body??'');
    const start=ref.start_byte,end=ref.end_byte;
    if(ref.event_id!==supplied.event_id || !Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start!<supplied.start_byte||end!>supplied.end_byte||end!<start! || end===start&&bytes.length!==0)throw new Error('Evidence requires paired original event UTF-8 span inside its supplied slice');
    const localStart=start!-supplied.start_byte,localEnd=end!-supplied.start_byte;
    if((localStart<bytes.length&&(bytes[localStart]!&0xc0)===0x80)||(localEnd<bytes.length&&(bytes[localEnd]!&0xc0)===0x80))throw new Error('Evidence span splits UTF-8 character');
    return {schema_version:1,event_id:supplied.event_id,start_byte:start!,end_byte:end!};
}
export function evidenceEvent(bundle:ReviewBundle,chunkId:string,ref:EventRef|ReviewUnit):SourceEvent {
    const events=bundle.chunks.find(chunk=>chunk.chunk_id===chunkId)?.events.filter(event=>exactReviewUnit(event).event_id===ref.event_id&&ref.start_byte!==undefined&&ref.end_byte!==undefined&&ref.start_byte>=exactReviewUnit(event).start_byte&&ref.end_byte<=exactReviewUnit(event).end_byte)??[];
    if(events.length!==1)throw new Error('Evidence outside one exact supplied primary slice');
    suppliedSpan(events[0]!,ref);return events[0]!;
}
export interface ValidatedPrimarySpans { held:Set<string>; final:Map<string,ReviewUnit[]> }
/** Transient interval accounting over frozen primary text; no sentence/proof database. */
export function validateUnitDispositions(bundle:ReviewBundle,result:ReviewResult,db:DatabaseSync):ValidatedPrimarySpans {
    const held=new Set<string>(),final=new Map<string,ReviewUnit[]>();
    if(bundle.kind!=='daily')return {held,final};
    if(bundle.review_requirements?.unit_dispositions!==true || bundle.review_requirements.inspection_version!==2 || bundle.review_requirements.completion_policy!=='primary_spans_v1')throw new Error('Daily material requires fresh preparation with primary spans');
    const all=bundle.chunks.flatMap(chunk=>chunk.events.map(event=>({event,chunk_id:chunk.chunk_id,unit:exactReviewUnit(event)})));
    // Verify slice bytes against immutable original source where it exists. Manual synthetic bundles may omit stored originals.
    for(const {event,unit}of all){const row=db.prepare('SELECT json FROM events WHERE id=?').get(unit.event_id) as {json:string}|undefined;if(row){const original=JSON.parse(row.json) as SourceEvent,bytes=Buffer.from(original.body??'');if((event.context.review_slice as {total_bytes?:number}|undefined)?.total_bytes!==undefined&&(event.context.review_slice as {total_bytes:number}).total_bytes!==bytes.length)throw new Error('Supplied slice total differs from frozen original source');if(unit.end_byte>bytes.length||bytes.subarray(unit.start_byte,unit.end_byte).toString('utf8')!==(event.body??''))throw new Error('Supplied slice differs from frozen original source bytes');}}
    const claims=new Map<string,ReviewUnit[]>(),deferred=new Map<string,ReviewUnit[]>();
    const append=(map:Map<string,ReviewUnit[]>,id:string,unit:ReviewUnit)=>map.set(id,[...(map.get(id)??[]),unit]);
    for(const candidate of result.candidates){const review=result.chunks.find(review=>review.chunk_id===candidate.chunk_id);for(const ref of candidate.event_refs){const event=evidenceEvent(bundle,candidate.chunk_id,ref);if(!review||review.status==='deferred'||!review.reviewed_event_ids.includes(event.event_id))throw new Error('Candidate uses unreviewed/context event');const unit=suppliedSpan(event,ref);if(unreadMedia(event)){held.add(event.event_id);append(deferred,event.event_id,unit);}else{append(claims,event.event_id,unit);append(final,event.event_id,unit);}}}
    const targets=new Set(bundle.existing_facts.map(refKey));
    const dispositionSpans=new Map<string,ReviewUnit[]>();
    for(const disposition of result.unit_dispositions??[]){version(disposition);if(!['no_persistent_information','covered_by_facts','defer'].includes(disposition.disposition)||!disposition.reason?.trim()||!Array.isArray(disposition.units)||!disposition.units.length||!Array.isArray(disposition.fact_refs))throw new Error('Invalid exact unit disposition');unique(disposition.units.map(canonical),'disposition units');unique(disposition.fact_refs.map(refKey),'disposition fact refs');
        if(disposition.disposition==='covered_by_facts'&&(!disposition.fact_refs.length||disposition.fact_refs.some(ref=>!targets.has(refKey(ref))||!db.prepare(`SELECT 1 FROM facts f WHERE f.id=? AND f.revision=? AND json_extract(f.json,'$.action')!='retract' AND NOT EXISTS(SELECT 1 FROM facts later WHERE later.id=f.id AND later.revision>f.revision) AND NOT EXISTS(SELECT 1 FROM fact_targets t WHERE t.target_id=f.id AND t.target_revision>=f.revision)`).get(ref.fact_id,ref.revision))))throw new Error('Covered unit disposition requires exact current existing fact refs');
        if(disposition.disposition!=='covered_by_facts'&&disposition.fact_refs.length)throw new Error('Only covered_by_facts may supply fact refs');
        for(const input of disposition.units){const matches=all.filter(item=>item.unit.event_id===input.event_id&&input.start_byte>=item.unit.start_byte&&input.end_byte<=item.unit.end_byte);if(matches.length!==1)throw new Error('Disposition outside one exact primary supplied unit');const {event,chunk_id}=matches[0]!,unit=suppliedSpan(event,input),review=result.chunks.find(review=>review.chunk_id===chunk_id);if(!review||review.status==='deferred')throw new Error('Disposition outside reviewed primary units');if((claims.get(event.event_id)??[]).some(span=>overlaps(span,unit))||(dispositionSpans.get(event.event_id)??[]).some(span=>overlaps(span,unit)))throw new Error('Disposition overlaps candidate-final or other disposition');append(dispositionSpans,event.event_id,unit);
            if(disposition.disposition==='defer'){held.add(event.event_id);append(deferred,event.event_id,unit);}else{if(unreadMedia(event))throw new Error('Unread media/unknown evidence requires defer');if(!review.reviewed_event_ids.includes(event.event_id))throw new Error('Final disposition requires actual reviewed primary unit');append(final,event.event_id,unit);}
        }
    }
    for(const {event,chunk_id,unit}of all){const review=result.chunks.find(review=>review.chunk_id===chunk_id);if(!review||review.status==='deferred')continue;const spans=[...(final.get(event.event_id)??[]),...(deferred.get(event.event_id)??[])].sort((a,b)=>a.start_byte-b.start_byte||a.end_byte-b.end_byte);let frontier=unit.start_byte;for(const span of spans){if(span.start_byte>frontier)break;frontier=Math.max(frontier,span.end_byte);}if(frontier<unit.end_byte||!spans.length)throw new Error('Primary unit lacks candidate span or exact grouped disposition for remaining text');}
    for(const review of result.chunks)if(review.reviewed_spans!==undefined){unique(review.reviewed_spans.map(canonical),'reviewed spans');const actual=all.filter(item=>item.chunk_id===review.chunk_id).flatMap(item=>final.get(item.event.event_id)??[]);for(const span of review.reviewed_spans){const event=evidenceEvent(bundle,review.chunk_id,span);suppliedSpan(event,span);if(!(final.get(event.event_id)??[]).some(unit=>canonical(unit)===canonical(span)))throw new Error('reviewed_spans must identify only final accepted primary spans');}if(actual.some(span=>!review.reviewed_spans!.some(unit=>canonical(unit)===canonical(span))))throw new Error('reviewed_spans omits a final primary span');}
    return {held,final};
}
export function eventForSpan(event:SourceEvent,span:ReviewUnit):SourceEvent {
    const unit=exactReviewUnit(event),slice=event.context.review_slice as {total_bytes:number}|undefined;
    return {...event,event_id:span.start_byte===unit.start_byte&&span.end_byte===unit.end_byte?event.event_id:`review-span:${span.event_id}:${span.start_byte}:${span.end_byte}`,body:Buffer.from(event.body??'').subarray(span.start_byte-unit.start_byte,span.end_byte-unit.start_byte).toString('utf8'),context:{...event.context,review_slice:{source_event_id:span.event_id,start_byte:span.start_byte,end_byte:span.end_byte,total_bytes:slice?.total_bytes??unit.end_byte}}};
}
