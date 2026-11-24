import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

test('browser bundle writes and reads exact file originals without Node globals', async () => {
    const result = await build({ absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
        stdin: { resolveDir: fileURLToPath(new URL('..', import.meta.url)), contents: `
            import { MemDrive } from '@functional-systems/memdrive';
            import { fileClient } from './test/helpers/file-client.mjs';
            globalThis.smoke = async () => {
                const { client } = fileClient();
                const drive = await MemDrive.create({ client, name: 'workspace' });
                const { at } = await drive.fork({ name: 'research' });
                const created = await drive.write({ at, op: 'create', path: '/note.md', content: 'Exact\\r\\n' });
                const reopened = await MemDrive.open({ client: { ...client }, name: 'workspace' });
                const saved = await reopened.read({ at, fileId: created.fileId });
                return JSON.stringify({ created, saved, main: await drive.read({ path: '/note.md' }) });
            }; ` }, bundle: true, platform: 'browser', format: 'iife', write: false });
    // Browser globals only. The Fetch API classes are present in every browser;
    // the re-exported LambdaDB client references them when its module loads.
    const context = createContext({ crypto: webcrypto, TextEncoder, TextDecoder, AbortController, AbortSignal, Request, Response, Headers });
    runInContext('globalThis.structuredClone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));', context);
    runInContext(result.outputFiles[0].text, context);
    const { created, saved, main } = JSON.parse(await context.smoke());
    assert.deepEqual(saved, created);
    assert.equal(saved.content, 'Exact\r\n');
    assert.equal(main, null);
});
