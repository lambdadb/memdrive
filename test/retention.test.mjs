import assert from 'node:assert/strict';
import test from 'node:test';
import { create, open, destroy } from '@functional-systems/memdrive';
import { fileClient } from './helpers/file-client.mjs';

const external = { embedding: { mode: 'external', dimensions: 64, similarity: 'cosine', identity: 'fixture' } };
const settings = (mode, retentionInDays) => 'memdrive-config-v1:' + JSON.stringify({
    ...(mode === 'managed' ? { chunking: { strategy: 'auto' } } : {}), retentionInDays });
const updates = calls => calls.filter(call => call.kind === 'collection-update');

test('new stores keep native snapshot retention at one day and persist the SDK window in both embedding modes', async () => {
    for (const mode of ['managed', 'external']) {
        const { client, collections, calls } = fileClient();
        const options = mode === 'external' ? external : {};
        const connection = { client, name: 'retention-store' };
        const defaulted = await create({ ...connection, name: 'default-store', ...options });
        assert.equal(collections.get('default-store').metadata.snapshotRetentionInDays, 1);
        assert.equal(collections.get('default-store').metadata.description, settings(mode, 30));
        assert.equal((await defaulted.describe()).retentionInDays, 30);

        const main = await create({ ...connection, retentionInDays: 7, ...options });
        const metadata = collections.get(connection.name).metadata;
        assert.equal(metadata.snapshotRetentionInDays, 1);
        assert.equal(metadata.description, settings(mode, 7));
        assert.equal((await main.describe()).retentionInDays, 7);
        await main.fork({ name: 'draft' });
        assert.equal((await main.configure({ retentionInDays: 365 })).retentionInDays, 365);
        assert.equal((await main.describe()).retentionInDays, 365);
        const reopen = () => open({ ...connection, client: { ...client }, ...(mode === 'external' ? { mode } : {}) });
        assert.equal((await (await reopen()).describe()).retentionInDays, 365);
        assert.equal(updates(calls).length, 1);
        // One native update carries both the SDK window and native retention.
        assert.deepEqual(updates(calls)[0].request, { description: settings(mode, 365), snapshotRetentionInDays: 1 });
        assert.equal(updates(calls)[0].retries.strategy, 'none');
        await main.configure({ retentionInDays: 365 });
        assert.equal(updates(calls).length, 1);

        // A native value changed elsewhere is restored even when the window matches.
        metadata.snapshotRetentionInDays = 7;
        assert.equal((await (await reopen()).describe()).retentionInDays, 365);
        await main.configure({ retentionInDays: 365 });
        assert.equal(updates(calls).length, 2);
        assert.deepEqual(updates(calls)[1].request, { description: settings(mode, 365), snapshotRetentionInDays: 1 });
        assert.equal(metadata.snapshotRetentionInDays, 1);
    }
});

test('invalid retention values fail before configuration mutations', async () => {
    const { client, calls, collections } = fileClient();
    for (const days of [0, 366, 1.5, NaN, '7', null])
        await assert.rejects(create({ client, name: 'invalid-store', retentionInDays: days }), { code: 'INVALID_INPUT' });
    assert.equal(collections.size, 0);
    const main = await create({ client, name: 'retention-store', retentionInDays: 32 });
    assert.equal((await main.describe()).retentionInDays, 32);
    for (const request of [{}, { retentionInDays: 0 }, { retentionInDays: 366 }, { retentionInDays: 2.5 }, { retentionInDays: 7, force: true }])
        await assert.rejects(main.configure(request), { code: 'INVALID_INPUT' });
    await assert.rejects(main.configure({ retentionInDays: 7 }, { signal: AbortSignal.abort() }), { code: 'ABORTED' });
    assert.equal(updates(calls).length, 0);
});

test('stores without a valid SDK window are incompatible', async () => {
    for (const mode of ['managed', 'external']) {
        const { client, collections, calls } = fileClient();
        const connection = { client, name: 'retention-store' };
        await create({ ...connection, ...(mode === 'external' ? external : {}) });
        const metadata = collections.get(connection.name).metadata;
        const reopen = () => open({ ...connection, client: { ...client }, ...(mode === 'external' ? { mode } : {}) });
        const chunking = mode === 'managed' ? 'memdrive-config-v1:{"chunking":{"strategy":"auto"}}' : 'memdrive-config-v1:{}';
        for (const description of [undefined, '', chunking, settings(mode, 0), settings(mode, 366), settings(mode, 2.5), settings(mode, '7')]) {
            if (description === undefined) delete metadata.description;
            else metadata.description = description;
            await assert.rejects(reopen(), { code: 'INCOMPATIBLE_STORE' });
        }
        assert.equal(updates(calls).length, 0);
    }
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
        const metadata = fixture.collections.get(connection.name).metadata;
        assert.equal(metadata.description, settings('managed', 7));
        assert.equal(metadata.snapshotRetentionInDays, 1);
        // A lost response after the update needs only the confirming read.
        assert.equal(updates(fixture.calls).length, applied ? 1 : 2);
        await destroy(connection);
    }
});

test('configuration excludes active work and refuses a replaced store generation', async () => {
    const fixture = fileClient();
    const main = await create({ client: fixture.client, name: 'retention-store' });
    const { at } = await main.fork({ name: 'draft' });
    let release, enter;
    const entered = new Promise(resolve => { enter = resolve; });
    fixture.beforeCollectionUpdate = async () => { enter(); await new Promise(resolve => { release = resolve; }); };
    const configuring = main.configure({ retentionInDays: 7 });
    await entered;
    await assert.rejects(main.write({ at, op: 'create', path: '/file', content: '' }), { code: 'STORE_BUSY' });
    release();
    await configuring;
    fixture.collections.get('retention-store').metadata.createdAt = new Date(9000);
    await assert.rejects(main.configure({ retentionInDays: 14 }), { code: 'STORE_REPLACED' });
    assert.equal(updates(fixture.calls).length, 1);
});
