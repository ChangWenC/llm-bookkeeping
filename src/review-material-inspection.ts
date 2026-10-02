import { open } from 'node:fs/promises';
import { absolutePath } from './config.ts';
import { InputError, parseJsonPreservingIntegers, validateReviewBundle } from './contracts/validation.ts';
import type { ReviewBundle, SourceEvent } from './contracts/types.ts';

export type MaterialSection = 'events' | 'facts' | 'baselines' | 'summary';
export const MAX_MATERIAL_INPUT_BYTES = 16 * 1024 * 1024;

/** Reads only one explicitly supplied saved bundle; never opens sources, Wiki or SQLite. */
export async function readReviewMaterial(path: string): Promise<ReviewBundle> {
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
    return validateReviewBundle(parseJsonPreservingIntegers(bytes.subarray(0, count).toString('utf8')));
  } finally { await handle.close(); }
}

function renderEvent(event: SourceEvent, chunkId: string, materialRole: 'primary' | 'context', index: number) {
  return {
    index, chunk_id: chunkId, material_role: materialRole,
    event_id: event.event_id, source: event.source, role: event.role, kind: event.kind, channel: event.channel,
    source_slice: event.context.review_slice ?? null,
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
  const bundle = validateReviewBundle(value);
  if (!['events', 'facts', 'baselines', 'summary'].includes(section)) throw new InputError('section must be events|facts|baselines|summary');
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 80) throw new InputError('offset must be nonnegative; limit must be 1–80');
  const events = bundle.chunks.flatMap(chunk => [
    ...chunk.events.map(event => ({ event, chunkId: chunk.chunk_id, materialRole: 'primary' as const })),
    ...chunk.context_events.map(event => ({ event, chunkId: chunk.chunk_id, materialRole: 'context' as const })),
  ]);
  const counts = { chunks: bundle.chunks.length, primary_events: events.filter(item => item.materialRole === 'primary').length, context_events: events.filter(item => item.materialRole === 'context').length, existing_facts: bundle.existing_facts.length, baselines: bundle.baselines.length };
  const total = section === 'events' ? events.length : section === 'facts' ? bundle.existing_facts.length : section === 'baselines' ? bundle.baselines.length : 1;
  if (offset > total) throw new InputError('offset exceeds supplied section record count');
  const end = Math.min(total, offset + limit);
  const items = section === 'events' ? events.slice(offset, end).map((item, index) => renderEvent(item.event, item.chunkId, item.materialRole, offset + index))
    : section === 'facts' ? bundle.existing_facts.slice(offset, end).map((fact, index) => ({ index: offset + index, fact_ref: { schema_version: 1, fact_id: fact.fact_id, revision: fact.revision }, ...fact }))
    : section === 'baselines' ? bundle.baselines.slice(offset, end).map((baseline, index) => ({ index: offset + index, ...baseline,
      text_completeness: baseline.digest === 'absent' ? 'absent' : baseline.content === null ? 'unavailable' : baseline.context_excerpt === true ? 'excerpt' : 'complete',
      content_bytes: baseline.content === null ? null : Buffer.byteLength(baseline.content),
    }))
    : offset === 0 ? [{ chunks: bundle.chunks.map(chunk => ({ chunk_id: chunk.chunk_id, primary_events: chunk.events.length, context_events: chunk.context_events.length, body_bytes: chunk.body_bytes })), coverage: bundle.coverage, unfinished: bundle.unfinished }] : [];
  return {
    schema_version: 1, inspection_only: true,
    bundle: { bundle_id: bundle.bundle_id, source: bundle.source ?? null, kind: bundle.kind, lane: bundle.lane, period: bundle.period, cutoff: bundle.cutoff, replay: bundle.replay ?? null },
    counts, page: { section, offset, limit, total, next_offset: end < total ? end : null }, items,
  };
}
