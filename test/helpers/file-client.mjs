// Models the file SDK's native requests with immediate visibility.
export function fileClient() {
    const collections = new Map();
    const calls = [];
    const fixture = { collections, calls };
    const fail = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };
    const client = {
        async createCollection(request) {
            if (collections.has(request.collectionName)) fail(409, 'Collection already exists');
            collections.set(request.collectionName, {
                metadata: structuredClone({ ...request, defaultBranchName: 'main' }),
                branches: new Map([['main', { docs: new Map() }]]),
            });
        },
        collection(name) {
            const state = () => collections.get(name) ?? fail(404, 'Collection missing');
            const docsAt = branch => (state().branches.get(branch) ?? fail(404, 'Branch missing')).docs;
            const response = (docs, fields) => ({ isDocsInline: true, total: docs.length, docs: docs.map(doc => ({
                collection: name, score: 0.8, doc: structuredClone(fields?.include
                    ? Object.fromEntries(fields.include.filter(key => Object.hasOwn(doc, key)).map(key => [key, doc[key]]))
                    : doc),
            })) });
            return {
                async get() { return { collection: structuredClone(state().metadata) }; },
                branches: {
                    async create({ branchName, source }) {
                        if (state().branches.has(branchName)) fail(409, 'Branch already exists');
                        state().branches.set(branchName, { docs: new Map(docsAt(source.name)) });
                        return { branch: { name: branchName } };
                    },
                    async list() {
                        return { branches: [...state().branches.keys()].map(name => ({ name })) };
                    },
                },
                async query(request) {
                    calls.push({ kind: 'query', request: structuredClone(request) });
                    const source = [...docsAt(request.ref.name).values()];
                    if (request.query.bayesian) {
                        const candidates = source.filter(doc => doc.kind === 'chunk');
                        const docs = (fixture.rank?.(candidates, request) ?? candidates).slice(0, request.size);
                        const native = response(docs, request.fields);
                        if (request.rerank) native.rerank = {
                            provider: request.rerank.provider, model: request.rerank.model,
                            status: docs.length ? 'applied' : 'skipped', ...(docs.length ? {} : { reason: 'noCandidates' }),
                            candidateCount: docs.length, scoredCount: docs.length, ...fixture.rerank,
                        };
                        return native;
                    }
                    const [kind, path, exclude] = request.query.bool;
                    if (path.queryString?.defaultField === 'id') {
                        const regex = clause => new RegExp(`^${clause.queryString.query.slice(1, -1)}$`);
                        const owned = regex(path);
                        const keep = exclude?.occur === 'must_not' ? regex(exclude) : undefined;
                        const after = exclude?.occur === 'filter' ? /^\{(.+) TO \*\}$/.exec(exclude.queryString.query)?.[1] : undefined;
                        const selected = source.filter(doc => doc.kind === JSON.parse(kind.queryString.query)
                            && owned.test(doc.id) && !keep?.test(doc.id) && (after === undefined || doc.id > after));
                        if (request.sort?.[0]?.id === 'asc') selected.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
                        return response(selected.slice(0, request.size), request.fields);
                    }
                    const paths = (path.bool ?? [path]).map(clause => JSON.parse(clause.queryString.query));
                    const docs = source.filter(doc => doc.kind === JSON.parse(kind.queryString.query) && paths.includes(doc.path)).slice(0, request.size);
                    return response(docs, request.fields);
                },
                docs: {
                    async list(request, options) {
                        calls.push({ kind: 'list', request: structuredClone(request), signal: options?.signal });
                        if (fixture.listPage) return fixture.listPage(request);
                        const filters = request.filter.bool;
                        const docs = [...docsAt(request.ref.name).values()].filter(doc => filters.every(({ queryString }) => {
                            const { query, defaultField } = queryString;
                            if (defaultField === 'fileName') return doc.fileName.includes(query.slice(3, -3));
                            const expected = JSON.parse(query);
                            return defaultField === 'ancestorPaths' ? doc.ancestorPaths.includes(expected) : doc.kind === expected;
                        }));
                        const start = Number(request.pageToken ?? 0);
                        const end = Math.min(docs.length, start + (fixture.listPageSize ?? request.size));
                        return { ...response(docs.slice(start, end), request.fields),
                            ...(end < docs.length ? { nextPageToken: String(end) } : {}) };
                    },
                    async fetch(request) {
                        calls.push({ kind: 'fetch', request: structuredClone(request) });
                        const docs = docsAt(request.ref.name);
                        const override = await fixture.beforeFetch?.(request, docs);
                        return override ?? response(request.ids.map(id => docs.get(id)).filter(Boolean), request.fields);
                    },
                    async upsert(request, options) {
                        calls.push({ kind: 'upsert', request: structuredClone(request), retries: options?.retries });
                        await fixture.beforeUpsert?.(request);
                        const docs = docsAt(request.branch);
                        for (const doc of request.docs) docs.set(doc.id, structuredClone(doc));
                        await fixture.afterUpsert?.(request, docs);
                    },
                    async update(request, options) {
                        calls.push({ kind: 'update', request: structuredClone(request), retries: options?.retries });
                        const docs = docsAt(request.branch);
                        if (request.docs.some(doc => !docs.has(doc.id))) fail(400, 'Update target missing');
                        for (const doc of request.docs) docs.set(doc.id, { ...docs.get(doc.id), ...structuredClone(doc) });
                    },
                    async delete(request, options) {
                        calls.push({ kind: 'delete', request: structuredClone(request), retries: options?.retries });
                        const docs = docsAt(request.branch);
                        await fixture.beforeDelete?.(request, docs);
                        for (const id of request.ids) docs.delete(id);
                        await fixture.afterDelete?.(request, docs);
                    },
                },
            };
        },
    };
    return Object.assign(fixture, { client });
}
