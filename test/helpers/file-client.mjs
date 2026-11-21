// Models the file SDK's native requests with immediate visibility.
export function fileClient() {
    const collections = new Map();
    const calls = [];
    const fixture = { collections, calls };
    const fail = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };
    const collectionResult = state => {
        const collection = structuredClone(state.metadata);
        collection.createdAt = new Date(collection.createdAt);
        return { collection };
    };
    const client = {
        async createCollection(request) {
            if (collections.has(request.collectionName)) fail(409, 'Collection already exists');
            collections.set(request.collectionName, {
                metadata: structuredClone({ ...request, defaultBranchName: 'main', projectName: 'fixture',
                    createdAt: new Date(collections.size + 1) }),
                branches: new Map([['main', { docs: new Map() }]]), tags: new Map(),
            });
            return collectionResult(collections.get(request.collectionName));
        },
        collection(name) {
            const state = () => collections.get(name) ?? fail(404, 'Collection missing');
            const docsAt = branch => (state().branches.get(branch) ?? fail(404, 'Branch missing')).docs;
            const sourceDocs = ref => ref.kind === 'tag'
                ? (state().tags.get(ref.name) ?? fail(404, 'Checkpoint missing')).docs : docsAt(ref.name);
            const copyView = ref => new Map(structuredClone([...sourceDocs(ref)]));
            const response = (docs, fields) => ({ isDocsInline: true, total: docs.length, docs: docs.map(doc => ({
                collection: name, score: 0.8, doc: structuredClone(fields?.include
                    ? Object.fromEntries(fields.include.filter(key => Object.hasOwn(doc, key)).map(key => [key, doc[key]]))
                    : doc),
            })) });
            return {
                collectionName: name,
                async get() { return collectionResult(state()); },
                branches: {
                    async create({ branchName, source }, options) {
                        calls.push({ kind: 'branch-create', request: { branchName, source }, retries: options?.retries });
                        if (state().branches.has(branchName)) fail(409, 'Branch already exists');
                        state().branches.set(branchName, { docs: copyView(source) });
                        return { branch: { name: branchName } };
                    },
                    async get(branchName) {
                        if (!state().branches.has(branchName)) fail(404, 'Branch missing');
                        return { branch: { name: branchName } };
                    },
                    async list() {
                        return { branches: [...state().branches.keys()].map(name => ({ name })) };
                    },
                },
                tags: {
                    async create({ tagName, source }, options) {
                        calls.push({ kind: 'tag-create', request: { tagName, source }, retries: options?.retries });
                        await fixture.beforeTagCreate?.(tagName, source);
                        if (state().tags.has(tagName)) fail(409, 'Tag already exists');
                        const tag = { name: tagName };
                        state().tags.set(tagName, { tag, docs: copyView(source) });
                        await fixture.afterTagCreate?.(tag);
                        return { tag };
                    },
                    async get(tagName) {
                        calls.push({ kind: 'tag-get', tagName });
                        const override = await fixture.getTag?.(tagName);
                        return override ?? { tag: (state().tags.get(tagName) ?? fail(404, 'Checkpoint missing')).tag };
                    },
                },
                async query(request, options) {
                    calls.push({ kind: 'query', request: structuredClone(request) });
                    const source = [...sourceDocs(request.ref).values()];
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
                    if (path?.queryString?.defaultField === 'changed') {
                        const overridden = await fixture.diffPage?.(request, options);
                        if (overridden !== undefined) return overridden;
                        const kinds = kind.bool.map(clause => JSON.parse(clause.queryString.query));
                        const after = exclude && /^\{(.+) TO \*\}$/.exec(exclude.queryString.query)?.[1];
                        const docs = source.filter(doc => kinds.includes(doc.kind) && doc.changed === true
                            && (after === undefined || doc.id > after));
                        docs.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
                        return response(docs.slice(0, request.size), request.fields);
                    }
                    if (path?.queryString?.defaultField === 'id' && path.queryString.query.startsWith('/')) {
                        const regex = clause => new RegExp(`^${clause.queryString.query.slice(1, -1)}$`);
                        const owned = regex(path);
                        const keep = exclude?.occur === 'must_not' ? regex(exclude) : undefined;
                        const after = exclude?.occur === 'filter' ? /^\{(.+) TO \*\}$/.exec(exclude.queryString.query)?.[1] : undefined;
                        const selected = source.filter(doc => doc.kind === JSON.parse(kind.queryString.query)
                            && owned.test(doc.id) && !keep?.test(doc.id) && (after === undefined || doc.id > after));
                        if (request.sort?.[0]?.id === 'asc') selected.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
                        return response(selected.slice(0, request.size), request.fields);
                    }
                    if (request.sort?.[0]?.id === 'asc') {
                        const docs = source.filter(doc => request.query.bool.every(({ queryString }) => {
                            const { query, defaultField } = queryString;
                            if (defaultField === 'kind') return doc.kind === JSON.parse(query);
                            if (defaultField === 'id') return doc.id > /^\{(.+) TO \*\}$/.exec(query)[1];
                            if (defaultField === 'ancestorPaths') return doc.ancestorPaths?.includes(JSON.parse(query));
                            if (defaultField === 'fileName') return doc.fileName?.includes(query.slice(3, -3));
                            throw new Error('Unexpected indexed list filter');
                        })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
                        return response(docs.slice(0, request.size), request.fields);
                    }
                    const overridden = await fixture.pathLookup?.(request, options);
                    if (overridden !== undefined) return overridden;
                    const paths = (path.bool ?? [path]).map(({ queryString }) =>
                        queryString.skipSyntax ? queryString.query : JSON.parse(queryString.query));
                    const docs = source.filter(doc => doc.kind === JSON.parse(kind.queryString.query) && paths.includes(doc.path)).slice(0, request.size);
                    return response(docs, request.fields);
                },
                docs: {
                    async list(request, options) {
                        calls.push({ kind: 'list', request: structuredClone(request), signal: options?.signal });
                        if (fixture.listPage) return fixture.listPage(request);
                        const filters = request.filter.bool;
                        const docs = [...sourceDocs(request.ref).values()].filter(doc => filters.every(({ queryString }) => {
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
                        const docs = sourceDocs(request.ref);
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
