import assert from 'node:assert/strict';
import test from 'node:test';
import * as native from '@functional-systems/lambdadb';
import { HTTPClient, LambdaDBClient } from '@functional-systems/memdrive';

test('the SDK re-exports the pinned LambdaDB client classes themselves', () => {
    assert.equal(LambdaDBClient, native.LambdaDBClient);
    assert.equal(HTTPClient, native.HTTPClient);
});

test('the re-exported client accepts a rollback whose snapshot head is null', async () => {
    const requests = [];
    const httpClient = new HTTPClient({ fetcher: async request => {
        requests.push({ path: new URL(request.url).pathname, method: request.method, body: await request.json() });
        return Response.json({ branchId: 'main', headSnapshot: null });
    } });
    const client = new LambdaDBClient({ baseUrl: 'https://lambdadb.example', projectName: 'fixture', projectApiKey: 'synthetic-key', httpClient });
    assert.deepEqual(await client.collection('workspace').branches.rollback('main', { tag: 'checkpoint-saved' }),
        { branchId: 'main', headSnapshot: null });
    assert.deepEqual(requests, [{ path: '/projects/fixture/collections/workspace/branches/main/rollback', method: 'POST',
        body: { tag: 'checkpoint-saved' } }]);
});
