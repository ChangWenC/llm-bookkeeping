import type { Store } from '../contracts/types.ts';
import { SqliteStore } from './index.ts';
export async function validateStore(store: Store, scope: 'changed' | 'all' = 'all') {
    if (!(store instanceof SqliteStore))
        throw new Error('Validation requires SQLite Store');
    const errors: string[] = [];
    const pending: string[] = [];
    store.db.exec('BEGIN');
    try {
        const integrity = store.db.prepare(scope === 'all' ? 'PRAGMA integrity_check' : 'PRAGMA quick_check').all() as Record<string, string>[];
        for (const row of integrity)
            if (Object.values(row)[0] !== 'ok')
                errors.push(Object.values(row)[0]);
        if (store.db.prepare('PRAGMA foreign_key_check').all().length)
            errors.push('Foreign key violation');
        for (const row of store.db.prepare('SELECT commit_json FROM results').all() as any[]) {
            const commit = JSON.parse(row.commit_json);
            if (!store.db.prepare('SELECT id FROM outbox WHERE id=?').get(commit.batch_id))
                errors.push('Accepted review has no outbox: ' + commit.result_id);
            for (const fact of commit.facts)
                if (!store.db.prepare('SELECT id FROM facts WHERE id=? AND revision=?').get(fact.fact_id, fact.revision))
                    errors.push('Accepted review has missing fact revision');
            for (const patch of commit.patches)
                if (!store.db.prepare('SELECT id FROM patches WHERE id=?').get(patch.operation_id))
                    errors.push('Accepted review has missing durable patch');
        }
        for (const row of store.db.prepare("SELECT id,status FROM patches WHERE status IN ('pending','conflict')").all() as any[])
            pending.push(`patch:${row.id}:${row.status}`);
        for (const row of store.db.prepare("SELECT id FROM outbox WHERE status='pending'").all() as any[])
            pending.push('export:' + row.id);
        for (const row of store.db.prepare("SELECT id FROM work WHERE state!='complete'").all() as any[])
            pending.push('work:' + row.id);
        store.db.exec('COMMIT');
    }
    catch (error) {
        store.db.exec('ROLLBACK');
        throw error;
    }
    return { schema_version: 1, scope, status: errors.length ? 'invalid' : 'valid', errors, pending };
}
