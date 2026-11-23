import assert from 'node:assert/strict';
import test from 'node:test';
import { create } from '@functional-systems/memdrive';
import { fileLister } from '../dist/esm/list.js';
import { fileClient } from './helpers/file-client.mjs';

const name = 'list-cache-store';
const at = { kind: 'fork', name: 'draft' };
const minute = 60_000;

/** A lister over three files, with a count of how often the cache released one of its scans. */
async function setup() {
    const fixture = fileClient();
    const drive = await create({ client: fixture.client, name });
    await drive.fork({ name: 'draft' });
    await drive.write({ at, operations: [1, 2, 3].map(n => ({ op: 'create', path: `/file-${n}`, content: '' })) });
    const lister = () => {
        const counter = { released: 0 };
        return Object.assign(counter, fileLister(fixture.client.collection(name), name, { kind: 'branch', name: 'fork-draft' }, {}, at,
            () => { counter.released++; }));
    };
    return { fixture, lister };
}
const scan = async lister => (await lister.list({ limit: 1 })).next.cursor;
const mockClock = t => t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });

test('an expired scan leaves the cache and releases its owner without another list call', async t => {
    mockClock(t);
    const { fixture, lister } = await setup();
    const view = lister();
    const cursor = await scan(view);
    const lists = () => fixture.calls.filter(call => call.kind === 'list').length;
    const before = lists();
    t.mock.timers.tick(5 * minute - 1);
    assert.equal(view.released, 0);
    assert(view.holds() && view.owns(cursor));
    // A continuation inside the window is served from the cache and does not extend it.
    assert.deepEqual((await view.list({ cursor })).files.map(file => file.path), ['/file-2']);
    t.mock.timers.tick(1);
    assert.equal(view.released, 1);
    assert(!view.holds() && !view.owns(cursor));
    assert.equal(lists(), before);
    await assert.rejects(view.list({ cursor }), { code: 'LIST_CURSOR_UNAVAILABLE' });
    t.mock.timers.tick(10 * minute);
    assert.equal(view.released, 1);
});

test('the expiry timer follows the earliest scan and each later one in turn', async t => {
    mockClock(t);
    const { lister } = await setup();
    const first = lister(), second = lister();
    const early = await scan(first);
    t.mock.timers.tick(2 * minute);
    const late = await scan(second);
    const latest = await scan(second);
    t.mock.timers.tick(3 * minute);
    assert.deepEqual([first.released, second.released], [1, 0]);
    assert(!first.owns(early) && second.owns(late) && second.owns(latest));
    t.mock.timers.tick(2 * minute - 1);
    assert.equal(second.released, 0);
    t.mock.timers.tick(1);
    assert.deepEqual([first.released, second.released], [1, 2]);
    assert(!second.holds());
    // A scan cached after the cache emptied arms the timer again.
    const again = await scan(first);
    t.mock.timers.tick(5 * minute);
    assert.equal(first.released, 2);
    assert(!first.owns(again));
});

test('eviction, release and expiry each release a scan exactly once', async t => {
    mockClock(t);
    const { lister } = await setup();
    const evicted = lister(), crowd = lister(), deleted = lister();
    const oldest = await scan(evicted);
    // The shared budget holds 128 scans: the 128th new one evicts the oldest.
    for (let index = 0; index < 127; index++) await scan(crowd);
    assert.equal(evicted.released, 0);
    await scan(crowd);
    assert.equal(evicted.released, 1);
    assert(!evicted.owns(oldest) && crowd.holds());
    // Releasing a view, as a deleted fork or checkpoint does, drops all of its scans at once.
    crowd.release();
    assert.equal(crowd.released, 128);
    assert(!crowd.holds());
    const cursor = await scan(deleted);
    deleted.release();
    assert.equal(deleted.released, 1);
    assert(!deleted.owns(cursor));
    crowd.release();
    t.mock.timers.tick(10 * minute);
    assert.deepEqual([evicted.released, crowd.released, deleted.released], [1, 128, 1]);
});
