import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

test('browser bundle executes managed and supplied-vector storage without Node globals', async () => {
    const result = await build({ absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
        stdin: { resolveDir: fileURLToPath(new URL('..', import.meta.url)), contents: `
            import { create, open } from './dist/esm/index.js';
            import { memdriveClient } from './test/helpers/memdrive-client.mjs';
            globalThis.smoke = async () => {
                const f = memdriveClient();
                const embedding = { mode: 'external', dimensions: 64, similarity: 'cosine', identity: 'test-space' };
                const drive = await create({ client: f.client, name: 'external',
                    metadataSchema: { source: { type: 'string' } }, embedding });
                const vector = Array.from({ length: 64 }, (_, i) => i + 1);
                await drive.remember({ mems: ['one', 'two'].map(id => ({ id, embedding: vector, metadata: { source: id } })) });
                const reopened = await open({ client: f.client, name: 'external' });
                f.search = (_request, docs) => docs;
                const recall = await reopened.recall({ queryVector: vector });
                const read = await reopened.read({ ids: ['one', 'two'] });
                const managed = await create({ client: f.client, name: 'managed', metadataSchema: {}, embedding: { mode: 'managed' } });
                await managed.remember({ mems: [{ id: 'short', content: 'A short original.' }, { id: 'long', content: 'x'.repeat(900) }] });
                const originals = await managed.read({ ids: ['short', 'long'] });
                f.search = (_request, docs) => docs.filter(doc => doc.memId === 'short');
                const unranked = await managed.recall({ query: 'short original', rerank: false });
                return JSON.stringify({ embedding: reopened.embedding, recall, read, originals, unranked,
                    rerankSent: Object.hasOwn(f.calls.findLast(call => call.kind === 'query').request, 'rerank'),
                    writes: f.calls.filter(call => call.kind === 'upsert').map(call => ({ name: call.name, count: call.request.docs.length })) });
            };`, loader: 'js' }, bundle: true, platform: 'browser', format: 'iife', write: false });
    const context = createContext({ crypto: webcrypto, TextEncoder, TextDecoder,
        performance, AbortController, AbortSignal, btoa, atob, setTimeout, clearTimeout });
    // This fixture uses JSON data only. Keep clones in the VM's realm, as a
    // browser does, rather than returning host-Node object prototypes.
    runInContext('globalThis.structuredClone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));', context);
    runInContext(result.outputFiles[0].text, context);
    const actual = JSON.parse(await context.smoke());
    assert.deepEqual(actual.embedding, { mode: 'external', dimensions: 64, similarity: 'cosine', identity: 'test-space' });
    assert.deepEqual(actual.recall.matches, ['one', 'two'].map(memId => ({ kind: 'mem', memId, metadata: { source: memId } })));
    assert.deepEqual(actual.read.mems, ['one', 'two'].map(id => ({ id, metadata: { source: id } })));
    assert.deepEqual(actual.originals.mems, [{ id: 'short', content: 'A short original.' }, { id: 'long', content: 'x'.repeat(900) }]);
    assert.equal(actual.rerankSent, false);
    assert.equal(actual.unranked.matches.length, 1);
    assert.equal(actual.unranked.matches[0].memId, 'short');
    assert.deepEqual(actual.writes, [{ name: 'external', count: 2 }, { name: 'managed', count: 4 }]);
});
