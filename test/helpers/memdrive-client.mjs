// Small native-client-shaped fixture. Search results are scripted, not a search-engine emulator.
const withoutVectors = doc => { const { embedding: _embedding, ...value } = doc; return structuredClone(value); };
export function memdriveClient() {
    const collections = new Map(), calls = [];
    const fixture = { collections, calls, search: () => [] };
    const client = {
        async createCollection(request, options) {
            calls.push({ signal: options?.signal, kind: 'create', request: structuredClone(request) });
            if (collections.has(request.collectionName)) throw Object.assign(new Error('Exists'), { statusCode: 409 });
            const docs = new Map();
            collections.set(request.collectionName, { metadata: { snapshotRetentionInDays: 30, ...structuredClone(request), defaultBranchName: 'main' }, docs,
                branches: new Map([['main', { docs, info: { name: 'main', parentBranch: null, headSnapshot: null, parentSnapshot: null, createdAt: new Date(0) } }]]) });
        },
        async listCollections(request, options) {
            calls.push({ kind: 'listCollections', signal: options?.signal, request: structuredClone(request) });
            if (fixture.listCollections) return fixture.listCollections(request, options);
            const values = [...collections.values()].map(value => structuredClone(value.metadata));
            const start = Number(request.pageToken ?? 0), end = Math.min(start + request.size, values.length);
            return { collections: values.slice(start, end), ...(end < values.length ? { nextPageToken: String(end) } : {}) };
        },
        collection(name) {
            const state = () => {
                if (!collections.has(name)) throw Object.assign(new Error('Missing'), { statusCode: 404 });
                return collections.get(name);
            };
            const branch = (name = 'main') => {
                const result = state().branches.get(name);
                if (!result) throw Object.assign(new Error('Missing branch'), { statusCode: 404 });
                return result;
            };
            return {
                branches: {
                    async create(request, options) {
                        calls.push({ signal: options?.signal, kind: 'branch_create', name, request: structuredClone(request) });
                        if (state().branches.has(request.branchName)) throw Object.assign(new Error('Exists'), { statusCode: 409 });
                        const source = branch(request.source.name);
                        const info = { name: request.branchName, parentBranch: { branchId: request.source.name, name: request.source.name },
                            headSnapshot: null, parentSnapshot: null, createdAt: new Date(0) };
                        // Fixture writes are immediate; this does not emulate native commit timing.
                        state().branches.set(request.branchName, { docs: new Map(structuredClone([...source.docs])), info });
                        return { branch: structuredClone(info) };
                    },
                    async list(options) {
                        calls.push({ signal: options?.signal, kind: 'branch_list', name });
                        return { branches: [...state().branches.values()].map(item => structuredClone(item.info)) };
                    },
                    async delete(branchName, options) {
                        calls.push({ signal: options?.signal, kind: 'branch_delete', name, branch: branchName });
                        await fixture.beforeBranchDelete?.(branchName);
                        branch(branchName); state().branches.delete(branchName);
                        return { message: 'deleted' };
                    },
                },
                async get(options) { calls.push({ signal: options?.signal, kind: 'get', name }); await fixture.beforeGet?.(name, options); return { collection: structuredClone(state().metadata) }; },
                async update(request, options) { calls.push({ signal: options?.signal, kind: 'update', name, request }); Object.assign(state().metadata, structuredClone(request)); },
                async delete(options) { calls.push({ signal: options?.signal, kind: 'delete', name }); state(); collections.delete(name); },
                async query(request, options) {
                    calls.push({ signal: options?.signal, kind: 'query', name, request: structuredClone(request) });
                    const docs = await fixture.search(request, [...branch(request.ref?.name).docs.values()].filter(doc => request.facets ? doc.kind === 'mem' : (typeof doc.content === 'string' && doc.content.trim().length > 0) || Array.isArray(doc.embedding)), name, options);
                    if (!Array.isArray(docs)) return docs;
                    return { isDocsInline: true, docs: docs.map(doc => ({ collection: name, doc: withoutVectors(doc), score: 0.8 })),
                        ...(request.rerank ? { rerank: { provider: request.rerank.provider, model: request.rerank.model,
                            status: docs.length ? 'applied' : 'skipped', ...(docs.length ? {} : { reason: 'noCandidates' }),
                            candidateCount: docs.length, scoredCount: docs.length } } : {}) };
                },
                docs: {
                    async list(request, options) {
                        calls.push({ signal: options?.signal, kind: 'list', name, request: structuredClone(request) });
                        const docs = [...branch(request.ref?.name).docs.values()];
                        if (fixture.list) return fixture.list(request, docs);
                        const start = Number(request.pageToken ?? 0), end = Math.min(start + request.size, docs.length);
                        return { isDocsInline: true, total: docs.length,
                            docs: docs.slice(start, end).map(doc => ({ collection: name, doc: withoutVectors(doc) })),
                            ...(end < docs.length ? { nextPageToken: String(end) } : {}) };
                    },
                    async fetch(request, options) {
                        calls.push({ signal: options?.signal, kind: 'fetch', name, request: structuredClone(request) });
                        return { isDocsInline: true, docs: request.ids.filter(id => branch(request.ref?.name).docs.has(id))
                            .map(id => ({ collection: name, doc: withoutVectors(branch(request.ref?.name).docs.get(id)) })) };
                    },
                    async upsert(request, options) {
                        calls.push({ signal: options?.signal, kind: 'upsert', name, request: structuredClone(request) });
                        await fixture.beforeUpsert?.(request, options);
                        for (const doc of request.docs) branch(request.branch).docs.set(doc.id, structuredClone(doc));
                        await fixture.afterUpsert?.(request, options);
                    },
                    async delete(request, options) {
                        calls.push({ signal: options?.signal, kind: 'forget', name, request: structuredClone(request) });
                        const target = branch(request.branch);
                        const ids = request.ids ?? fixture.filterDelete?.(request, [...target.docs.values()])
                            ?? (request.filter?.bool?.every(item => item.queryString?.defaultField === 'memId')
                                ? [...target.docs.values()].filter(doc => request.filter.bool.some(item => JSON.parse(item.queryString.query) === doc.memId)).map(doc => doc.id) : []);
                        for (const id of ids) target.docs.delete(id);
                    },
                },
            };
        },
    };
    return Object.assign(fixture, { client });
}
