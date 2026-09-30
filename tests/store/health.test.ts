import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../src/store/index.ts';
import { validateStore } from '../../src/store/health.ts';
import { config, collection, bundle, result } from './fixtures.ts';
test('consistency health distinguishes ordinary export/file pending work from damaged accepted transaction', async () => { const c = await config(), s = await createStore(c), b = bundle(); try {
    await s.saveCollection(collection());
    await s.saveBundle(b);
    const commit = await s.commitReview(result(b));
    await s.markPatchStatus(commit.patches[0].operation_id, 'conflict', 'synthetic human changed target');
    const healthy = await validateStore(s, 'all');
    assert.equal(healthy.status, 'valid');
    assert(healthy.pending.some(item => item.includes('conflict')));
    assert(healthy.pending.some(item => item.startsWith('export:')));
    s.db.prepare('DELETE FROM facts WHERE id=?').run(commit.facts[0].fact_id);
    const damaged = await validateStore(s, 'changed');
    assert.equal(damaged.status, 'invalid');
    assert(damaged.errors.some(error => error.includes('missing fact revision')));
}
finally {
    s.close();
} });
