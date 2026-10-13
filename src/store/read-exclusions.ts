import type { DatabaseSync } from 'node:sqlite';
import type { BookkeepingConfig, SourceEvent } from '../contracts/types.ts';

/** Exact metadata identities only: never inspect a body to establish a read exclusion. */
export class ReviewReadExclusions {
    readonly reasons = new Map<string, string>();
    constructor(config?: BookkeepingConfig) {
        const value = config?.review_read_exclusions;
        if (value === undefined) return;
        if (!value || typeof value !== 'object' || Object.keys(value).some(key => !['schema_version','events'].includes(key)) || value.schema_version !== 1 || !Array.isArray(value.events) || value.events.length > 100) throw new Error('Invalid review_read_exclusions');
        for (const item of value.events) {
            if (!item || typeof item !== 'object' || Object.keys(item).some(key => !['schema_version','event_id','reason'].includes(key)) || item.schema_version !== 1 || typeof item.event_id !== 'string' || !item.event_id.trim() || Buffer.byteLength(item.event_id) > 256 || /[\s\u007f*?\[\]]/.test(item.event_id) || typeof item.reason !== 'string' || !item.reason.trim() || Buffer.byteLength(item.reason) > 512 || /[\u0000-\u001f\u007f]/.test(item.reason) || this.reasons.has(item.event_id)) throw new Error('Invalid exact review read exclusion');
            this.reasons.set(item.event_id, item.reason);
        }
    }
    validateExists(db: DatabaseSync): void {
        for (const id of this.reasons.keys()) if (!db.prepare('SELECT 1 FROM events WHERE id=?').get(id)) throw new Error('Review read exclusion references nonexistent event');
    }
    fragmentBlocked(db: DatabaseSync, fragmentId: string | null): boolean {
        if (!fragmentId || !this.reasons.size) return false;
        // At most 100 exact primary-key lookups; never scan source history.
        return !!db.prepare("SELECT 1 FROM events WHERE id IN (SELECT value FROM json_each(?)) AND json_extract(json,'$.fragment_ref')=? LIMIT 1").get(JSON.stringify([...this.reasons.keys()]), fragmentId);
    }
    allowed(id: unknown): boolean { return typeof id === 'string' && !this.reasons.has(id); }
    eventAllowed(event: SourceEvent): boolean { return this.allowed(event.event_id) && this.allowed((event.context.review_slice as { source_event_id?: string } | undefined)?.source_event_id ?? event.event_id); }
}

export const readAllowedSql = (alias = 'events') => `review_read_allowed(${alias}.id)=1`;
// SQL projects identity metadata only before the containing bundle/chunk is decoded in JavaScript.
export const materialReadAllowedSql = (json: string) => `review_read_allowed(json_extract(${json},'$.event_id'))=1 AND review_read_allowed(COALESCE(json_extract(${json},'$.context.review_slice.source_event_id'),json_extract(${json},'$.event_id')))=1`;
