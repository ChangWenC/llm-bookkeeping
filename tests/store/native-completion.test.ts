import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../src/store/index.ts';
import { config, event, collection, range } from './fixtures.ts';

test('native completion survives out-of-order unfinished retries without erasing independent incomplete evidence', async () => {
    const s = await createStore(await config());
    const completed = event('native-completed');
    completed.context = { turn_complete: true, incomplete_turn: false };
    const old = structuredClone(completed); old.context = { turn_complete: false };
    await s.saveCollection(collection([completed], 'live', 'complete-first'));
    await s.saveCollection(collection([old], 'history', 'old-after'));
    assert.equal((await s.getReviewableEvents({ range }, 'daily'))[0].context.turn_complete, true);
    const incomplete = event('native-independent');
    incomplete.context = { turn_complete: false, incomplete_turn: true };
    await s.saveCollection(collection([incomplete], 'live', 'incomplete-first'));
    const ambiguous = structuredClone(incomplete); ambiguous.context = { turn_complete: true };
    await s.saveCollection(collection([ambiguous], 'live', 'ambiguous-complete'));
    assert.equal((await s.listEvents({ range })).find(e => e.event_id === incomplete.event_id)!.context.incomplete_turn, true);
    assert.deepEqual((await s.getReviewableEvents({ range }, 'daily')).map(e => e.event_id), [completed.event_id]);
    const complete = structuredClone(incomplete); complete.context = { turn_complete: true, incomplete_turn: false };
    await s.saveCollection(collection([complete], 'history', 'proved-complete'));
    await s.saveCollection(collection([old], 'live', 'old-again'));
    assert.deepEqual(new Set((await s.getReviewableEvents({ range }, 'daily')).map(e => e.event_id)), new Set([completed.event_id, complete.event_id]));
    assert.deepEqual(await s.listWork('event_conflict'), []);
    assert.equal((await s.status()).events, 2);
    s.close();
});
