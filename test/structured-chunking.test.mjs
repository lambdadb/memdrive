import assert from 'node:assert/strict';
import test from 'node:test';
import { create, open, destroy } from '@functional-systems/memdrive';
import { createDoclingChunker } from '@functional-systems/memdrive/docling';
import { fileClient } from './helpers/file-client.mjs';

const mock = chunks => ({ id: 'synthetic-docling-v1', async chunk() { return chunks; } });
const options = { chunking: { strategy: 'docling' }, chunker: mock([{ text: 'Hello world.', contextualized: 'Heading\nHello world.' }]) };
const at = { kind: 'fork', name: 'draft' };
const createFile = content => ({ at, op: 'create', path: '/notes.md', content });

test('auto selects per-file structure while explicit boundary and none ignore the adapter', async () => {
    for (const strategy of ['auto', 'boundary', 'none']) {
        const fixture = fileClient();
        let parses = 0;
        const chunker = { id: 'selection-fixture', async chunk() {
            parses++;
            return [{ text: 'Body.', contextualized: 'Heading\nBody.' }];
        } };
        const main = await create({ client: fixture.client, name: 'selection', chunking: { strategy }, chunker });
        await main.fork({ name: 'draft' });
        await main.write(createFile('# Heading\n\nBody.'));
        await main.write({ at, op: 'create', path: '/plain.txt', content: 'Plain text. '.repeat(200) });
        await main.write({ at, op: 'create', path: '/ambiguous.json', content: '{"text":"Body."}' });
        assert.equal(parses, strategy === 'auto' ? 1 : 0);
        const docs = [...fixture.collections.get('selection').branches.get('fork-draft').docs.values()];
        const chunks = docs.filter(doc => doc.kind === 'chunk' && doc.path === '/plain.txt');
        assert.equal(chunks.length === 1, strategy === 'none');
        assert(chunks.every(doc => doc.embeddingText === doc.content));
        assert.equal(docs.find(doc => doc.kind === 'file' && doc.path === '/plain.txt').chunking.strategy,
            strategy === 'none' ? 'none' : 'boundary');
    }
});

test('parser failures and cancellation do not publish a partial file or silently fall back', async () => {
    const fixture = fileClient();
    const controller = new AbortController();
    let cancel = false;
    const chunker = { id: 'failing-fixture', async chunk() {
        if (!cancel) throw new Error('Parser failure');
        controller.abort();
        return [{ text: 'Body.', contextualized: 'Body.' }];
    } };
    const main = await create({ client: fixture.client, name: 'failure', chunker });
    await main.fork({ name: 'draft' });
    await assert.rejects(main.write(createFile('Body.')), /Parser failure/);
    cancel = true;
    await assert.rejects(main.write(createFile('Body.'), { signal: controller.signal }), { code: 'ABORTED' });
    assert.equal(fixture.collections.get('failure').branches.get('fork-draft').docs.size, 0);
});

test('structured chunks retain exact originals and distinguish preview bodies from embedding text', async () => {
    const { client, collections } = fileClient();
    const main = await create({ client, name: 'structured', ...options });
    await main.fork({ name: 'draft' });
    const file = await main.write(createFile('# Heading\n\nHello world.'));
    assert.deepEqual(await main.read({ at, fileId: file.fileId }), file);
    const docs = [...collections.get('structured').branches.get('fork-draft').docs.values()];
    const chunk = docs.find(doc => doc.kind === 'chunk');
    const original = docs.find(doc => doc.kind === 'file');
    assert.equal(chunk.content, 'Hello world.');
    assert.equal(chunk.embeddingText, 'Heading\nHello world.');
    assert.deepEqual(original.chunking, { strategy: 'docling', version: 'synthetic-docling-v1' });
    assert.deepEqual((await main.search({ at, query: 'Heading', rerank: false })).hits[0].range, { start: 11, end: 23 });
    const fresh = await open({ client: { ...client }, name: 'structured' });
    assert.deepEqual(await fresh.read({ at, fileId: file.fileId }), file);
    await assert.rejects(fresh.write(createFile('new content')), { code: 'CHUNKER_UNAVAILABLE' });
});

test('moves reuse stored rendered chunks and a fresh client reads without invoking the parser again', async () => {
    const fixture = fileClient();
    let parses = 0;
    const chunker = { id: 'table-fixture-v1', async chunk() {
        parses++;
        if (parses > 1) throw new Error('Parser must not run again');
        return [{ text: 'Mira, Age = 30', contextualized: 'Data\nMira, Age = 30' }];
    } };
    const main = await create({ client: fixture.client, name: 'table-store', chunking: { strategy: 'docling' }, chunker });
    await main.fork({ name: 'draft' });
    const file = await main.write(createFile('# Data\n\n| Name | Age |\n| --- | --- |\n| Mira | 30 |'));
    const reader = await open({ client: { ...fixture.client }, name: 'table-store' });
    const hit = (await reader.search({ at, query: 'Mira', rerank: false })).hits[0];
    assert.equal(hit.content, 'Mira, Age = 30');
    assert.equal(hit.range, undefined);
    assert.equal((await reader.read({ at, fileId: file.fileId })).content, file.content);
    await main.write({ at, op: 'update', fileId: file.fileId, newPath: '/moved.md' });
    const { at: saved } = await main.checkpoint({ at, name: 'saved' });
    await main.rollback({ at: { kind: 'main' }, to: saved });
    assert.equal((await reader.search({ query: 'Mira', rerank: false })).hits[0].path, '/moved.md');
    assert.equal(parses, 1);
    await destroy({ client: { ...fixture.client }, name: 'table-store' });
});

test('ambiguous passages omit ranges and exact front matter remains searchable', async () => {
    const fixture = fileClient();
    const main = await create({ client: fixture.client, name: 'ambiguous', chunking: { strategy: 'docling' },
        chunker: mock([{ text: 'Repeat.', contextualized: 'First\nRepeat.' }, { text: 'Repeat.', contextualized: 'Second\nRepeat.' }]) });
    await main.fork({ name: 'draft' });
    const content = '---\ndescription: Secret plan\n---\n# First\n\nRepeat.\n\n# Second\n\nRepeat.';
    await main.write(createFile(content));
    const hits = (await main.search({ at, query: 'plan', rerank: false })).hits;
    assert.equal(hits.length, 3);
    assert.equal(hits[0].content, '---\ndescription: Secret plan\n---\n');
    assert.equal(hits[1].range, undefined);
    assert.equal(hits[2].range, undefined);
    assert.equal(content.slice(hits[0].range.start, hits[0].range.end), hits[0].content);
});

test('configuration is persisted, unsupported explicit formats fail, and earlier store formats are rejected', async () => {
    const fixture = fileClient();
    await assert.rejects(create({ client: fixture.client, name: 'missing', chunking: { strategy: 'docling' } }), { code: 'CHUNKER_UNAVAILABLE' });
    assert.equal(fixture.collections.size, 0);
    const main = await create({ client: fixture.client, name: 'configured', ...options });
    assert.deepEqual((await main.describe()).chunking, { strategy: 'docling' });
    await main.fork({ name: 'draft' });
    await assert.rejects(main.write({ at, op: 'create', path: '/opaque.json', content: '{}' }), { code: 'UNSUPPORTED_FORMAT' });
    const state = fixture.collections.get('configured');
    const current = structuredClone(state.metadata);
    const { sources, ...embedding } = current.indexConfigs.embedding.embedding;
    assert.deepEqual(sources, [{ field: 'embeddingText', type: 'text' }]);
    // A store needs its persisted chunking configuration and the `sources` embedding form.
    for (const change of [
        metadata => { metadata.description = 'memdrive-config-v1:{"retentionInDays":30}'; },
        metadata => { metadata.indexConfigs.embedding.embedding = { ...embedding, sourceField: 'embeddingText' }; },
        metadata => {
            metadata.description = 'memdrive-config-v1:{"retentionInDays":30}';
            metadata.indexConfigs.embedding.embedding = { ...embedding, sourceField: 'content' };
        },
        metadata => { metadata.indexConfigs.embedding.embedding.sourceField = 'embeddingText'; },
        metadata => { metadata.indexConfigs.embedding.embedding.sources = [{ field: 'content', type: 'text' }]; },
        metadata => { metadata.indexConfigs.embedding.embedding.sources.push({ field: 'content', type: 'text' }); },
    ]) {
        change(state.metadata);
        await assert.rejects(open({ client: { ...fixture.client }, name: 'configured' }), { code: 'INCOMPATIBLE_STORE' });
        state.metadata = structuredClone(current);
    }
    const reopened = await open({ client: { ...fixture.client }, name: 'configured' });
    assert.deepEqual((await reopened.describe()).chunking, { strategy: 'docling' });
});

test('the optional Node adapter runs real Docling Hybrid with a local synthetic tokenizer', async () => {
    const chunker = await createDoclingChunker({ tokenizer: new URL('./fixtures/docling-tokenizer.json', import.meta.url).pathname, maxTokens: 32 });
    const { client } = fileClient();
    const main = await create({ client, name: 'native-docling', chunking: { strategy: 'docling' }, chunker });
    await main.fork({ name: 'draft' });
    const file = await main.write(createFile('# Heading\n\nHello world.'));
    assert.equal((await main.search({ at, query: 'world', rerank: false })).hits[0].content, 'Hello world.');
    const { at: saved } = await main.checkpoint({ at, name: 'native-saved' });
    assert.deepEqual(await main.read({ at: saved, fileId: file.fileId }), file);
    const heading = await main.write({ at, op: 'create', path: '/heading.md', content: '# Heading only' });
    assert.equal((await main.read({ at, fileId: heading.fileId })).content, '# Heading only');
    await assert.rejects(createDoclingChunker({ tokenizer: '/does-not-exist.json' }), { code: 'CHUNKER_UNAVAILABLE' });
});
