import type { DatabaseSync } from 'node:sqlite';
import type { SemanticReplayRequest, SemanticReplayScope, SourceEvent, WorkItem } from '../contracts/types.ts';
import { canonical, digest } from '../analytics/serialization.ts';
import { normalized, rangeCheck, utc, version } from './domain.ts';

/** One explicit review job freezes source identities, never copies raw bodies. */
export class SemanticReplayRepository {
    private readonly db: DatabaseSync;
    constructor(db: DatabaseSync) { this.db = db; }
    get(id: string): WorkItem | null {
        const row = this.db.prepare("SELECT json FROM work WHERE id=? AND kind='semantic_replay'").get(id) as any;
        return row ? JSON.parse(row.json) : null;
    }
    request(request: SemanticReplayRequest): WorkItem {
        version(request); rangeCheck(request.range); utc(request.cutoff);
        if (!request.replay_key?.trim() || request.replay_key.length > 512 || !request.source?.trim())
            throw new Error('Replay requires a bounded nonempty key and source');
        const range = { ...request.range, from: normalized(request.range.from), to: normalized(request.range.to) };
        const id = 'semantic-replay:' + digest(request.replay_key), previous = this.get(id);
        if (previous) {
            if (previous.payload.source !== request.source || canonical(previous.payload.range) !== canonical(range))
                throw new Error('Semantic replay key scope conflict');
            return previous; // A retry's clock never changes the first cutoff or state.
        }
        const item: WorkItem = { schema_version: 1, work_id: id, kind: 'semantic_replay', lane: 'history', state: 'pending',
            payload: { replay_key: request.replay_key, source: request.source, range, cutoff: request.cutoff },
            reason: 'Explicit semantic review of original events and current effective facts', migration_key: null, updated_at: request.cutoff };
        this.db.prepare('INSERT INTO work VALUES(?,?,?,?,NULL)').run(id, canonical(item), item.kind, item.state);
        this.db.prepare("INSERT INTO semantic_replay_events SELECT ?,id FROM events WHERE json_extract(json,'$.source.provider')=? AND time>=? AND time<? AND classification IN ('main','unknown') AND COALESCE(json_extract(json,'$.context.context_only'),0)!=1")
            .run(id, request.source, range.from, range.to);
        const count = (this.db.prepare('SELECT COUNT(*) AS n FROM semantic_replay_events WHERE work_id=?').get(id) as any).n;
        item.payload.event_count = count;
        this.db.prepare('UPDATE work SET json=? WHERE id=?').run(canonical(item), id);
        return item;
    }
    events(id: string, limit: number): SourceEvent[] {
        if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid semantic replay event limit');
        return this.db.prepare("SELECT e.json FROM semantic_replay_events p JOIN events e ON e.id=p.event_id WHERE p.work_id=? AND e.classification='main' AND NOT EXISTS(SELECT 1 FROM reviewed_sources r WHERE r.source_id=e.id AND r.kind=? AND r.lane='history') ORDER BY e.time,e.ordering,e.id LIMIT ?")
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
        const remaining = this.db.prepare("SELECT 1 FROM semantic_replay_events p JOIN events e ON e.id=p.event_id WHERE p.work_id=? AND e.classification IN ('main','unknown') AND NOT EXISTS(SELECT 1 FROM reviewed_sources r WHERE r.source_id=e.id AND r.kind=? AND r.lane='history') LIMIT 1")
            .get(id, 'replay:' + id);
        if (remaining) return;
        const item = this.get(id)!;
        this.db.prepare("UPDATE work SET state='complete',json=? WHERE id=?").run(canonical({ ...item, state: 'complete', updated_at: at }), id);
    }
}
