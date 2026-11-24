// Store lifecycle for the session replay's live LambdaDB backend: connection,
// the ownership ledger written before create, and explicit, verified cleanup.
// Never records credentials, headers or response bodies.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { HTTPClient, LambdaDBClient, MemDrive } from '@functional-systems/memdrive';

export const storeProtocol = 'memdrive-beam-session-replay-store-v1';
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
 * endpoint and project, checks the name and ownership labels, destroys the store with
 * its owned journal, confirms absence and marks the ledger cleaned. Idempotent.
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
