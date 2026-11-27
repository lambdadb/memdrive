// Store lifecycle for the session replay's live LambdaDB backend: connection,
// the ownership ledger written before create, and explicit, verified cleanup;
// and the harness's read-only inventory reads of main.
// Never records credentials, headers or response bodies.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileToolError, HTTPClient, LambdaDBClient, MemDrive } from '@functional-systems/memdrive';

// v2 stores use the SDK's single-collection `files-v1` layout. A v1 ledger names a
// `files-v0` store with a publication journal, which this SDK can neither open nor destroy.
export const storeProtocol = 'memdrive-beam-session-replay-store-v2';
const earlierStoreProtocol = 'memdrive-beam-session-replay-store-v1';
export const ledgerFile = 'store.json';
const storeName = /^beam-replay-[0-9a-f]{32}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const json = value => JSON.stringify(value, null, 2) + '\n';

/** A new store name within the SDK's 3–52 character `[A-Za-z0-9_-]` limit (44 characters). */
export const newStoreName = () => `beam-replay-${randomUUID().replaceAll('-', '')}`;
export const storeLabels = owner => ({ 'beam.application': storeProtocol, 'beam.owner': owner });

/**
 * A LambdaDB client confined to one project: HTTPS origin only, no automatic retries,
 * no external result downloads and a 30-second deadline per request.
 */
export function lambdadbConnection(env, { fetcher = fetch } = {}) {
    const { LAMBDADB_BASE_URL: baseUrl, LAMBDADB_PROJECT_NAME: projectName, LAMBDADB_PROJECT_API_KEY: projectApiKey } = env ?? {};
    assert(baseUrl?.trim() && projectName?.trim() && projectApiKey?.trim(), 'Missing LambdaDB configuration');
    const endpoint = URL.canParse(baseUrl) ? new URL(baseUrl) : null;
    assert(endpoint && endpoint.protocol === 'https:' && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash
        && endpoint.pathname === '/', 'Use an HTTPS LambdaDB origin');
    const prefix = `${endpoint.origin}/projects/${encodeURIComponent(projectName)}/`;
    const client = new LambdaDBClient({ baseUrl: endpoint.origin, projectName, projectApiKey, retryConfig: { strategy: 'none' },
        debugLogger: { log() {}, group() {}, groupEnd() {} },
        httpClient: new HTTPClient({ fetcher(request) {
            assert(request.url.startsWith(prefix), 'Database request escaped the configured project');
            return fetcher(request, { signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]), redirect: 'error' });
        } }),
        transferClient: new HTTPClient({ fetcher: async () => { throw new Error('External result downloads are disabled'); } }),
    });
    return { client, endpoint: endpoint.origin, project: projectName };
}

/** Replace the ledger atomically; the first write must create it. */
export async function writeLedger(directory, ledger, { create = false } = {}) {
    const file = path.join(directory, ledgerFile);
    if (create) return writeFile(file, json(ledger), { flag: 'wx', mode: 0o600 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, json(ledger), { flag: 'wx', mode: 0o600 });
    try { await rename(temporary, file); }
    finally { await rm(temporary, { force: true }); }
}

/** Read one run's ledger and check its format, endpoint, project and ownership receipt. */
export async function readLedger(directory, { endpoint, project }) {
    const ledger = JSON.parse(await readFile(path.join(directory, ledgerFile), 'utf8'));
    assert(ledger.protocol !== earlierStoreProtocol, 'This ledger is from an earlier replay protocol whose store this SDK cannot open or destroy; '
        + 'delete its collection and md-journal-* collection with LambdaDB directly');
    assert.equal(ledger.protocol, storeProtocol, 'Unexpected replay store ledger format');
    assert(ledger.endpoint === endpoint && ledger.project === project, 'Ledger belongs to another endpoint/project');
    assert(storeName.test(ledger.name) && uuid.test(ledger.labels?.['beam.owner'] ?? '')
        && JSON.stringify(ledger.labels) === JSON.stringify(storeLabels(ledger.labels['beam.owner'])), 'Invalid replay store ownership receipt');
    assert(['pending', 'ready', 'cleaned'].includes(ledger.status), 'Unexpected replay store ledger state');
    return ledger;
}

/** The store's labels must match the ledger's, so a ledger cannot point at a store it does not own. */
export function assertOwner(collection, ledger) {
    for (const [key, expected] of Object.entries(ledger.labels))
        assert.equal(collection.tags?.[key], expected, 'Replay store owner differs');
}

/**
 * Delete the store recorded in one run's ledger, and nothing else. Requires the same
 * endpoint and project, checks the name and ownership labels, destroys the store's
 * single collection, confirms absence and marks the ledger cleaned. Idempotent.
 */
export async function cleanupStore({ output, client, endpoint, project }) {
    const directory = path.resolve(output);
    const ledger = await readLedger(directory, { endpoint, project });
    if (ledger.status === 'cleaned') return { status: 'cleaned', name: ledger.name };
    const handle = client.collection(ledger.name);
    const inspect = async () => {
        try {
            const { collection } = await handle.get();
            assert.equal(collection.collectionName, ledger.name, 'Unexpected replay store name');
            return collection;
        } catch (error) {
            if (error.statusCode === 404) return null;
            throw error;
        }
    };
    const collection = await inspect();
    if (collection) {
        assertOwner(collection, ledger);
        await MemDrive.destroy({ client, name: ledger.name });
        for (let attempt = 0; await inspect(); attempt++) {
            assert(attempt < 8, 'Deletion is unconfirmed; retain the ledger and retry cleanup');
            await new Promise(resolve => setTimeout(resolve, 250));
        }
    }
    await writeLedger(directory, { ...ledger, status: 'cleaned' });
    return { status: 'cleaned', name: ledger.name };
}

/** Every page of a recursive listing of main, in path order. The listing is consistent. */
async function listAll(drive) {
    const files = [];
    for (let page = await drive.list({ limit: 1000 }); ; page = await drive.list(page.next)) {
        files.push(...page.files);
        if (!page.next) return files;
    }
}

/**
 * The harness's read-only view of main: its latest checkpoint, `tree` of the whole
 * drive, and an inventory from `list` with every `next` followed. `list` is
 * path-ordered and consistent, so the inventory is all of main. Each listed file is
 * read once by file ID only for `chars`, the UTF-16 length of its original, which no
 * listing reports (null if the read finds no file). A failed step is recorded by
 * step and code and leaves its value null.
 */
export async function observeStore(drive) {
    const state = { latestCheckpoint: null, tree: null, files: null, errors: [] };
    const attempt = async (step, read) => {
        try { return await read(); }
        catch (error) { state.errors.push({ step, code: fileToolError(error).error.code }); return null; }
    };
    state.latestCheckpoint = await attempt('describe', async () => (await drive.describe()).latestCheckpoint?.at.name ?? null);
    state.tree = await attempt('tree', () => drive.tree());
    const listed = await attempt('list', () => listAll(drive));
    if (listed) state.files = await attempt('read', async () => {
        const files = [];
        for (const { fileId, path: filePath, modifiedAt } of listed)
            files.push({ fileId, path: filePath, modifiedAt, chars: (await drive.read({ fileId }))?.content.length ?? null });
        return files;
    });
    return state;
}
