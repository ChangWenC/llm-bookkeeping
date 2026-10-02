import type { DatabaseSync } from 'node:sqlite';
import type { SemanticReplayRequest, SemanticReplayScope, SourceEvent, WorkItem, TimeRange } from '../contracts/types.ts';
import { canonical, digest } from '../analytics/serialization.ts';
import { scopeSql, senderSql } from './wechat-scope.ts';
import { normalized, rangeCheck, utc, version } from './domain.ts';

/** One explicit review job freezes source identities, never copies raw bodies. */
export class SemanticReplayRepository {
    private readonly db: DatabaseSync;
    private readonly validateWechat: () => void;
    private readonly hasPendingScope: (range: TimeRange, source: string, eventIds?: string[]) => boolean;
    constructor(db: DatabaseSync, validateWechat: () => void = () => {}, hasPendingScope: (range: TimeRange, source: string, eventIds?: string[]) => boolean = () => false) { this.db = db; this.validateWechat = validateWechat; this.hasPendingScope = hasPendingScope; }
    validateSource(): void { this.validateWechat(); }
    get(id: string): WorkItem | null {
        const row = this.db.prepare("SELECT json FROM work WHERE id=? AND kind='semantic_replay'").get(id) as any;
        return row ? JSON.parse(row.json) : null;
    }
    request(request: SemanticReplayRequest): WorkItem {
        if (request.source === 'wechat') this.validateSource();
        version(request); rangeCheck(request.range); utc(request.cutoff);
        if (!request.replay_key?.trim() || request.replay_key.length > 512 || !request.source?.trim())
            throw new Error('Replay requires a bounded nonempty key and source');
        if (request.event_ids !== undefined && !Array.isArray(request.event_ids)) throw new Error('Replay event_ids requires an array');
        const selected = request.event_ids === undefined ? undefined : [...request.event_ids].sort();
        if (selected !== undefined && (!Array.isArray(request.event_ids) || selected.length > 64 || selected.some(id => typeof id !== 'string' || !id.trim()) || new Set(selected).size !== selected.length)) throw new Error('Replay event_ids requires at most 64 unique nonempty IDs');
        const range = { ...request.range, from: normalized(request.range.from), to: normalized(request.range.to) };
        const id = 'semantic-replay:' + digest(request.replay_key), previous = this.get(id);
        if (previous) {
            if (previous.payload.source !== request.source || canonical(previous.payload.range) !== canonical(range) || canonical(previous.payload.event_ids ?? null) !== canonical(selected ?? null))
                throw new Error('Semantic replay key scope conflict');
            return previous; // A retry's clock never changes the first cutoff or state.
        }
        const selection = selected === undefined ? '' : ' AND id IN (SELECT value FROM json_each(?))';
        const selectionArgs: any[] = selected === undefined ? [] : [canonical(selected)];
        const eligible = `json_extract(json,'$.source.provider')=? AND time>=? AND time<? AND classification IN ('main','unknown') AND COALESCE(json_extract(json,'$.context.context_only'),0)!=1 AND ${scopeSql()}${selection}`;
        if (selected !== undefined) {
            const count = (this.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE ${eligible}`).get(request.source, range.from, range.to, ...selectionArgs) as any).n;
            if (count !== selected.length) throw new Error('Replay selected event missing, excluded or outside source/range scope');
        }
        const item: WorkItem = { schema_version: 1, work_id: id, kind: 'semantic_replay', lane: 'history', state: 'pending',
            payload: { replay_key: request.replay_key, source: request.source, range, cutoff: request.cutoff, ...(selected === undefined ? {} : { event_ids: selected }) },
            reason: 'Explicit semantic review of original events and current effective facts', migration_key: null, updated_at: request.cutoff };
        this.db.prepare('INSERT INTO work VALUES(?,?,?,?,NULL)').run(id, canonical(item), item.kind, item.state);
        this.db.prepare(`INSERT INTO semantic_replay_events SELECT ?,id FROM events WHERE ${eligible}`)
            .run(id, request.source, range.from, range.to, ...selectionArgs);
        const count = (this.db.prepare('SELECT COUNT(*) AS n FROM semantic_replay_events WHERE work_id=?').get(id) as any).n;
        item.payload.event_count = count;
        this.db.prepare('UPDATE work SET json=? WHERE id=?').run(canonical(item), id);
        return item;
    }
    events(id: string, limit: number): SourceEvent[] {
        if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid semantic replay event limit');
        return this.db.prepare(`SELECT e.json FROM semantic_replay_events p JOIN events e ON e.id=p.event_id WHERE p.work_id=? AND e.classification='main' AND NOT EXISTS(SELECT 1 FROM reviewed_sources r WHERE r.source_id=e.id AND r.kind=? AND r.lane='history') AND ${scopeSql('e')} AND ${senderSql('e')} ORDER BY e.time,e.ordering,e.id LIMIT ?`)
            .all(id, 'replay:' + id, limit).map((row: any) => JSON.parse(row.json));
    }
    contains(id: string, eventId: string): boolean {
        return Boolean(this.db.prepare('SELECT 1 FROM semantic_replay_events WHERE work_id=? AND event_id=?').get(id, eventId));
    }
    validate(scope: SemanticReplayScope, cutoff: string): void {
        version(scope); const item = this.get(scope.work_id);
        if (!item || item.state !== 'pending' || item.payload.source !== scope.source
            || canonical(item.payload.range) !== canonical(scope.range) || item.payload.cutoff !== cutoff)
            throw new Error('Semantic replay scope is stale or outside the prepared request');
    }
    finish(id: string, at: string): void {
        const item = this.get(id)!;
        if (this.hasPendingScope(item.payload.range as TimeRange, item.payload.source as string, item.payload.event_ids as string[] | undefined)) return;
        const remaining = this.db.prepare("SELECT 1 FROM semantic_replay_events p JOIN events e ON e.id=p.event_id WHERE p.work_id=? AND e.classification IN ('main','unknown') AND NOT EXISTS(SELECT 1 FROM reviewed_sources r WHERE r.source_id=e.id AND r.kind=? AND r.lane='history') LIMIT 1")
            .get(id, 'replay:' + id);
        if (remaining) return;
        this.db.prepare("UPDATE work SET state='complete',json=? WHERE id=?").run(canonical({ ...item, state: 'complete', updated_at: at }), id);
    }
}
