import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { ArchiveReviewContext, BookkeepingConfig, CoverageGap, ReviewBundle, WorkItem } from '../contracts/types.ts';
import type { SqliteStore } from '../store/index.ts';
import { resolveWikiPath } from '../publish/files.ts';
import { canonical, digest } from '../analytics/serialization.ts';
function excerpt(bytes: Buffer, limit: number): string {
    let end = Math.min(bytes.length, limit);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80)
        end--;
    return bytes.subarray(0, end).toString('utf8');
}
/** Read exactly queued immutable archives; no directory discovery or new fact assertions. */
export async function addArchiveContexts(store: SqliteStore, config: BookkeepingConfig, bundle: ReviewBundle, offset: number): Promise<void> {
    const context = bundle.monthly_context!, limit = config.limits.bundle_bytes;
    if (!Number.isSafeInteger(offset) || offset < 0)
        throw new Error('archive_context_offset must be nonnegative');
    const all = await store.listWork('archive_context');
    const ids = store.freezeArchiveWork(context.facts_page!.snapshot_id, all.filter(item => item.payload.month === context.month && Date.parse(item.updated_at) <= Date.parse(bundle.cutoff)).map(item => item.work_id));
    if (offset > ids.length)
        throw new Error('archive_context_offset exceeds frozen context list');
    const work = new Map(all.map(item => [item.work_id, item]));
    context.archive_contexts = [];
    context.archive_context_page = { schema_version: 1, offset, next_offset: null, total: ids.length };
    let end = offset;
    for (; end < ids.length; end++) {
        const item = work.get(ids[end]);
        if (!item) {
            issue(bundle, 'Frozen archive work unavailable: ' + ids[end]);
            continue;
        }
        try {
            // Per-item budget grows with configured bundle size, so raising it makes the original tail reachable.
            const material = await readArchive(config, item, Math.max(64, Math.floor(limit / 4)), context.month);
            context.archive_contexts.push(material);
            if (Buffer.byteLength(canonical(bundle)) + 1024 > limit) {
                context.archive_contexts.pop();
                if (context.archive_contexts.length)
                    break;
                issue(bundle, `Archive material cannot fit with this fact/page context: ${item.work_id}; retry this offset with fewer --pages or a larger bundle budget`);
                continue;
            }
            if (material.excerpt_reason)
                issue(bundle, material.excerpt_reason);
        }
        catch (error) {
            issue(bundle, `Archive context pending ${item.work_id}: ${String(error)}`);
        }
    }
    context.archive_context_page.next_offset = end < ids.length ? end : null;
    if (offset || end < ids.length)
        issue(bundle, `Archive context page ${offset}..${end}/${ids.length}; continue at the next offset with the original cutoff`);
}
function issue(bundle: ReviewBundle, reason: string): void {
    const gap: CoverageGap = { schema_version: 1, range: null, reason, locator: null, resumable: true };
    bundle.unfinished.push(gap);
    bundle.monthly_context!.coverage_status = 'partial';
}
async function readArchive(config: BookkeepingConfig, item: WorkItem, maxBytes: number, month: string): Promise<ArchiveReviewContext> {
    const path = item.payload.archive_path;
    if (typeof path !== 'string' || !path.endsWith('.json'))
        throw new Error('Invalid queued archive path');
    const target = await resolveWikiPath(config.wiki_root, path);
    const handle = await open(target.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
        // V2 contains base64 and a text copy. A budget-linked cap bounds allocation without a fixed tail ceiling.
        const stat = await handle.stat();
        const cap = Math.max(4096, config.limits.bundle_bytes * 4);
        if (stat.size > cap)
            throw new Error(`Archive container ${stat.size} bytes exceeds read budget; set limits.bundle_bytes to at least ${Math.ceil(stat.size / 4)} and reread this archive_context_offset`);
        bytes = await handle.readFile();
    }
    finally {
        await handle.close();
    }
    const record = JSON.parse(bytes.toString('utf8'));
    if (record.schema_version !== 1 || record.format !== 'daily-journal-archive-v2' || record.date !== item.payload.date || typeof record.date !== 'string' || !record.date.startsWith(month + '-') || record.locator !== item.payload.locator || typeof record.source_path !== 'string' || typeof record.original_bytes_base64 !== 'string')
        throw new Error('Archive identity/date/locator mismatch');
    const original = Buffer.from(record.original_bytes_base64, 'base64');
    if (original.toString('base64') !== record.original_bytes_base64 || digest(original) !== record.original_digest)
        throw new Error('Archive original bytes/digest mismatch');
    await resolveWikiPath(config.wiki_root, record.source_path);
    const fact_refs = Array.isArray(record.fact_refs) ? record.fact_refs : [];
    if (canonical(fact_refs) !== canonical(item.payload.fact_refs ?? []))
        throw new Error('Archive known fact refs mismatch');
    return { schema_version: 1, work_id: item.work_id, source_path: record.source_path, date: record.date, original_digest: record.original_digest, content_excerpt: excerpt(original, maxBytes), excerpt_reason: original.length > maxBytes ? `Archive ${item.work_id}: first ${maxBytes} of ${original.length} original bytes; set limits.bundle_bytes to at least ${4 * original.length + 4096} and reread the same archive_context_offset for the full original` : null, fact_refs };
}
