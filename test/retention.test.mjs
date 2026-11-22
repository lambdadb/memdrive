import assert from 'node:assert/strict';
import test from 'node:test';
import { create, open, destroy } from '@functional-systems/memdrive';
import { fileClient } from './helpers/file-client.mjs';

test('native snapshot retention is configurable on create and main in both embedding modes', async () => {
    for (const external of [false, true]) {
        const { client, collections, calls } = fileClient();
        const connection = { client, name: 'retention-store' };
        const main = await create({ ...connection, retentionInDays: 7,
            ...(external ? { embedding: { mode: 'external', dimensions: 64, similarity: 'cosine', identity: 'fixture' } } : {}) });
        assert.equal(collections.get(connection.name).metadata.snapshotRetentionInDays, 7);
        assert.equal((await main.describe()).retentionInDays, 7);
        const fork = await main.fork({ name: 'draft' });
        assert.equal('configure' in fork, false);
        assert.equal((await main.configure({ retentionInDays: 31 })).retentionInDays, 31);
        assert.equal((await fork.describe()).retentionInDays, 31);
        const reopened = await open({ ...connection, client: { ...client }, ...(external ? { mode: 'external' } : {}) });
        assert.equal((await reopened.describe()).retentionInDays, 31);
        const updates = calls.filter(call => call.kind === 'collection-update');
        assert.equal(updates.length, 1);
        assert.deepEqual(updates[0].request, { snapshotRetentionInDays: 31 });
        assert.equal(updates[0].retries.strategy, 'none');
        await main.configure({ retentionInDays: 31 });
        assert.equal(calls.filter(call => call.kind === 'collection-update').length, 1);
    }
});

test('invalid retention values fail before configuration mutations', async () => {
    const { client, calls, collections } = fileClient();
    for (const days of [0, 32, 1.5, NaN, '7'])
        await assert.rejects(create({ client, name: 'invalid-store', retentionInDays: days }), { code: 'INVALID_INPUT' });
    assert.equal(collections.size, 0);
    const main = await create({ client, name: 'retention-store' });
    for (const request of [{}, { retentionInDays: 0 }, { retentionInDays: 7, force: true }])
        await assert.rejects(main.configure(request), { code: 'INVALID_INPUT' });
    await assert.rejects(main.configure({ retentionInDays: 7 }, { signal: AbortSignal.abort() }), { code: 'ABORTED' });
    assert.equal(calls.filter(call => call.kind === 'collection-update').length, 0);
});

test('unknown configuration outcomes fence conflicting changes and resource deletion until same-value recovery', async () => {
    for (const applied of [false, true]) {
        const fixture = fileClient();
        const connection = { client: fixture.client, name: 'retention-store' };
        const main = await create({ ...connection, retentionInDays: 30 });
        const hook = applied ? 'afterCollectionUpdate' : 'beforeCollectionUpdate';
        fixture[hook] = () => { throw new Error('Lost configuration response'); };
        await assert.rejects(main.configure({ retentionInDays: 7 }), { code: 'CONFIGURATION_UNCONFIRMED' });
        await assert.rejects(main.configure({ retentionInDays: 14 }), { code: 'CONFIGURATION_UNCONFIRMED' });
        await assert.rejects(destroy(connection), { code: 'CONFIGURATION_UNCONFIRMED' });
        fixture[hook] = undefined;
        assert.equal((await main.configure({ retentionInDays: 7 })).retentionInDays, 7);
        await destroy(connection);
    }
});

test('configuration excludes active work and refuses a replaced store generation', async () => {
    const fixture = fileClient();
    const main = await create({ client: fixture.client, name: 'retention-store' });
    const fork = await main.fork({ name: 'draft' });
    let release, enter;
    const entered = new Promise(resolve => { enter = resolve; });
    fixture.beforeCollectionUpdate = async () => { enter(); await new Promise(resolve => { release = resolve; }); };
    const configuring = main.configure({ retentionInDays: 7 });
    await entered;
    await assert.rejects(fork.write({ op: 'create', path: '/file', content: '' }), { code: 'STORE_BUSY' });
    release();
    await configuring;
    fixture.collections.get('retention-store').metadata.createdAt = new Date(9000);
    await assert.rejects(main.configure({ retentionInDays: 14 }), { code: 'STORE_REPLACED' });
    assert.equal(fixture.calls.filter(call => call.kind === 'collection-update').length, 1);
});
