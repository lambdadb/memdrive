// Models the file SDK's native requests with immediate visibility.
// Like LambdaDB, a recreated ref gets a later creation time and a new snapshot ID.
let lastCreated = 0;
const createdAt = () => new Date(lastCreated = Math.max(Date.now(), lastCreated + 1));
// Collection creation times are unique in a process, so every fixture store is a separate generation.
let generation = 0;
// Keyword order of LambdaDB: Unicode code points, so surrogate pairs sort after U+E000–U+FFFF.
const codePoints = (a, b) => {
    const [x, y] = [a, b].map(value => [...value].map(char => char.codePointAt(0)));
    for (let index = 0; index < Math.min(x.length, y.length); index++) if (x[index] !== y[index]) return x[index] - y[index];
    return x.length - y.length;
};
// The filter clauses the SDK sends to listing and tree queries.
function matches(doc, { bool, queryString }) {
    if (bool) return bool[0]?.occur === 'should' ? bool.some(clause => matches(doc, clause)) : bool.every(clause => matches(doc, clause));
    const { query, defaultField, skipSyntax } = queryString;
    if (defaultField === 'kind') return doc.kind === JSON.parse(query);
    if (defaultField === 'id') return skipSyntax ? doc.id === query : doc.id > /^\{(.+) TO \*\}$/.exec(query)[1];
    if (defaultField === 'ancestorPaths') return doc.ancestorPaths?.includes(JSON.parse(query));
    if (defaultField === 'fileName') return doc.fileName?.includes(/^\/\.\*(.*)\.\*\/$/.exec(query)[1]);
    if (defaultField === 'path') return doc.path === JSON.parse(query);
    throw new Error('Unexpected faceted or path-sorted query filter');
}

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
                    createdAt: new Date(++generation) }),
                branches: new Map([['main', { docs: new Map() }]]), tags: new Map(), aliases: new Map(),
            });
            return collectionResult(collections.get(request.collectionName));
        },
        collection(name) {
            const state = () => collections.get(name) ?? fail(404, 'Collection missing');
            const docsAt = branch => (state().branches.get(branch) ?? fail(404, 'Branch missing')).docs;
            const sourceDocs = ref => ref.kind === 'tag'
                ? (state().tags.get(ref.name) ?? fail(404, 'Checkpoint missing')).docs : docsAt(ref.name);
            const copyView = ref => new Map(structuredClone([...sourceDocs(ref)]));
            // One native page of sorted ref details, with numeric page tokens.
            const refPage = (entries, { size = 10, pageToken } = {}) => {
                const sorted = [...entries].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
                const start = Number(pageToken ?? 0), end = Math.min(sorted.length, start + size);
                return { page: sorted.slice(start, end), ...(end < sorted.length ? { nextPageToken: String(end) } : {}) };
            };
            const aliasResult = alias => ({ alias: { ...structuredClone(alias), createdAt: new Date(alias.createdAt),
                dangling: alias.targetKind === 'TAG' && !state().tags.has(alias.targetName) } });
            const aliasTarget = target => {
                if (target?.kind !== 'tag' && target?.kind !== 'branch') fail(400, 'Invalid alias target');
                if (!(target.kind === 'tag' ? state().tags : state().branches).has(target.name)) fail(404, `Reference not found: ${target.name}`);
                return { targetKind: target.kind.toUpperCase(), targetName: target.name };
            };
            const response = (docs, fields) => ({ isDocsInline: true, total: docs.length, docs: docs.map(doc => ({
                collection: name, score: 0.8, doc: structuredClone(fields?.include
                    ? Object.fromEntries(fields.include.filter(key => Object.hasOwn(doc, key)).map(key => [key, doc[key]]))
                    : doc),
            })) });
            return {
                collectionName: name,
                async get() { return await fixture.getCollection?.(name) ?? collectionResult(state()); },
                async update(request, options) {
                    calls.push({ kind: 'collection-update', collection: name, request: structuredClone(request), retries: options?.retries });
                    await fixture.beforeCollectionUpdate?.(name, request);
                    Object.assign(state().metadata, structuredClone(request));
                    await fixture.afterCollectionUpdate?.(name, request);
                    return collectionResult(state());
                },
                async delete(options) {
                    calls.push({ kind: 'collection-delete', collection: name, retries: options?.retries });
                    await fixture.beforeCollectionDelete?.(name);
                    state();
                    collections.delete(name);
                    await fixture.afterCollectionDelete?.(name);
                    return { message: 'Deleted' };
                },
                branches: {
                    async create({ branchName, source }, options) {
                        calls.push({ kind: 'branch-create', request: { branchName, source }, retries: options?.retries });
                        await fixture.beforeBranchCreate?.(branchName, source);
                        if (state().branches.has(branchName)) fail(409, 'Branch already exists');
                        state().branches.set(branchName, { docs: copyView(source), createdAt: createdAt() });
                        return { branch: { name: branchName } };
                    },
                    async get(branchName) {
                        if (!state().branches.has(branchName)) fail(404, 'Branch missing');
                        return { branch: { name: branchName, createdAt: state().branches.get(branchName).createdAt } };
                    },
                    async list() {
                        return fixture.listBranches?.() ?? { branches: [...state().branches.keys()].map(name => ({ name })) };
                    },
                    async listPage(params, options) {
                        calls.push({ kind: 'branch-list', params: structuredClone(params), signal: options?.signal });
                        const override = await fixture.listBranches?.(params);
                        if (override) return override;
                        const { page, ...next } = refPage([...state().branches].map(([name, branch]) => ({ name, createdAt: branch.createdAt })), params);
                        return { branches: page, ...next };
                    },
                    // Restores the branch to the tag's documents. `fixture.beforeRollback` may throw, for
                    // example the definite 400 of a tag whose snapshot is not yet published.
                    // Like the native client, rollback is never retried.
                    async rollback(branchName, { tag }, options) {
                        calls.push({ kind: 'branch-rollback', name: branchName, tag, retries: options?.retries });
                        await fixture.beforeRollback?.(branchName, tag);
                        const source = state().tags.get(tag) ?? fail(404, `Reference not found: ${tag}`);
                        const branch = state().branches.get(branchName) ?? fail(404, 'Branch missing');
                        branch.docs = new Map(structuredClone([...source.docs]));
                        return { branchId: branchName, headSnapshot: { snapshotId: globalThis.crypto.randomUUID() } };
                    },
                    async delete(branchName, options) {
                        calls.push({ kind: 'branch-delete', name: branchName, retries: options?.retries });
                        await fixture.beforeRefDelete?.('fork', branchName);
                        if (branchName === 'main') fail(400, 'Cannot delete main');
                        if (!state().branches.delete(branchName)) fail(404, 'Branch missing');
                        await fixture.afterRefDelete?.('fork', branchName);
                        return { message: 'Deleted' };
                    },
                },
                tags: {
                    async list() {
                        return fixture.listTags?.() ?? { tags: [...state().tags.keys()].map(name => ({ name })) };
                    },
                    async listPage(params, options) {
                        calls.push({ kind: 'tag-list', params: structuredClone(params), signal: options?.signal });
                        const override = await fixture.listTags?.(params);
                        if (override) return override;
                        const { page, ...next } = refPage([...state().tags.values()].map(({ tag }) => ({ ...tag })), params);
                        return { tags: page, ...next };
                    },
                    async delete(tagName, options) {
                        calls.push({ kind: 'tag-delete', name: tagName, retries: options?.retries });
                        await fixture.beforeRefDelete?.('checkpoint', tagName);
                        // Like LambdaDB, a tag that an alias targets cannot be deleted.
                        if ([...state().aliases.values()].some(alias => alias.targetKind === 'TAG' && alias.targetName === tagName))
                            fail(409, 'Tag is targeted by an alias');
                        if (!state().tags.delete(tagName)) fail(404, 'Checkpoint missing');
                        await fixture.afterRefDelete?.('checkpoint', tagName);
                        return { message: 'Deleted' };
                    },
                    async create({ tagName, source }, options) {
                        calls.push({ kind: 'tag-create', request: { tagName, source }, retries: options?.retries });
                        await fixture.beforeTagCreate?.(tagName, source);
                        if (state().tags.has(tagName)) fail(409, 'Tag already exists');
                        const tag = { name: tagName, snapshotId: globalThis.crypto.randomUUID(), snapshotCommittedAt: new Date(), createdAt: createdAt() };
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
                // Aliases name a tag or branch; `fixture.before*`/`after*` hooks may throw
                // to inject failures before or after the native change.
                aliases: {
                    async create({ aliasName, target }, options) {
                        calls.push({ kind: 'alias-create', request: { aliasName, target }, retries: options?.retries });
                        await fixture.beforeAliasCreate?.(aliasName, target);
                        if (state().aliases.has(aliasName)) fail(409, 'Alias already exists');
                        const alias = { aliasId: globalThis.crypto.randomUUID(), aliasName, ...aliasTarget(target), aliasRevision: 1, createdAt: Date.now() };
                        state().aliases.set(aliasName, alias);
                        await fixture.afterAliasCreate?.(aliasName, target);
                        return aliasResult(alias);
                    },
                    async retarget(aliasName, { target }, options) {
                        calls.push({ kind: 'alias-retarget', name: aliasName, target, retries: options?.retries });
                        await fixture.beforeAliasRetarget?.(aliasName, target);
                        const alias = state().aliases.get(aliasName) ?? fail(404, 'Alias missing');
                        Object.assign(alias, aliasTarget(target), { aliasRevision: alias.aliasRevision + 1 });
                        await fixture.afterAliasRetarget?.(aliasName, target);
                        return aliasResult(alias);
                    },
                    async get(aliasName) {
                        calls.push({ kind: 'alias-get', name: aliasName });
                        await fixture.beforeAliasGet?.(aliasName);
                        return aliasResult(state().aliases.get(aliasName) ?? fail(404, 'Alias missing'));
                    },
                    async delete(aliasName, options) {
                        calls.push({ kind: 'alias-delete', name: aliasName, retries: options?.retries });
                        await fixture.beforeAliasDelete?.(aliasName);
                        if (!state().aliases.delete(aliasName)) fail(404, 'Alias missing');
                        return { message: 'Deleted' };
                    },
                    async listPage(params) {
                        calls.push({ kind: 'alias-list', params: structuredClone(params) });
                        const { page, ...next } = refPage([...state().aliases.values()].map(alias => ({ ...alias, name: alias.aliasName })), params);
                        return { aliases: page.map(({ name: _name, ...alias }) => aliasResult(alias).alias), ...next };
                    },
                },
                async query(request, options) {
                    calls.push({ kind: 'query', request: structuredClone(request) });
                    const source = [...sourceDocs(request.ref).values()];
                    // Listing and tree queries: keyword sort and facets with LambdaDB's semantics.
                    if (request.facets !== undefined || request.sort?.some(key => Object.hasOwn(key, 'path'))) {
                        const facets = Object.entries(request.facets ?? {});
                        if (!Number.isInteger(request.size) || request.size < 0 || request.size > 1000 || (request.size === 0 && !facets.length)
                            || facets.length > 5 || facets.some(([, facet]) => facet.size !== undefined && (facet.size < 1 || facet.size > 100)))
                            fail(400, 'Invalid query size or facets');
                        if (request.consistentRead && request.ref?.kind === 'tag') fail(400, 'consistentRead requires a branch');
                        const override = await fixture.facetQuery?.(request, options);
                        if (override !== undefined) return override;
                        const selected = source.filter(doc => matches(doc, request.query)).sort((a, b) => {
                            for (const key of request.sort ?? []) {
                                const [[field, direction]] = Object.entries(key);
                                const order = codePoints(a[field], b[field]);
                                if (order) return direction === 'asc' ? order : -order;
                            }
                            return 0;
                        });
                        const native = response(selected.slice(0, request.size), request.fields);
                        if (!facets.length) return native;
                        // A document counts once per distinct value of an array field. The budget
                        // covers distinct (field, value) pairs and their bytes across all fields.
                        const budget = { buckets: 10_000, bytes: 256 * 1024, ...fixture.facetBudget };
                        let buckets = 0, bytes = 0;
                        native.facets = Object.fromEntries(facets.map(([field, { size = 10 }]) => {
                            const counts = new Map();
                            for (const doc of selected) for (const value of new Set([doc[field]].flat().filter(value => typeof value === 'string')))
                                counts.set(value, (counts.get(value) ?? 0) + 1);
                            buckets += counts.size;
                            for (const value of counts.keys()) bytes += new TextEncoder().encode(value).length;
                            return [field, { buckets: [...counts].map(([value, count]) => ({ value, count }))
                                .sort((a, b) => b.count - a.count || codePoints(a.value, b.value)).slice(0, size) }];
                        }));
                        if (buckets > budget.buckets || bytes > budget.bytes) fail(400, 'Facet aggregation budget exceeded');
                        return native;
                    }
                    if (request.query.bayesian || request.query.knn?.queryText !== undefined
                        || request.query.bool?.some(clause => clause.queryString?.defaultField === 'content')) {
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
                    if (request.query.knn) {
                        const candidates = source.filter(doc => doc.kind === 'file');
                        const docs = fixture.rank?.(candidates, request) ?? candidates;
                        return response(docs.slice(0, request.size), request.fields);
                    }
                    const direct = request.query.queryString;
                    if (direct?.defaultField === 'id' && direct.query === '/.*/')
                        return response(source.slice(0, request.size), request.fields);
                    if (direct?.defaultField === 'id' && direct.skipSyntax)
                        return response(source.filter(doc => doc.id === direct.query).slice(0, request.size), request.fields);
                    if (request.query.queryString?.defaultField === 'id' && request.query.queryString.skipSyntax)
                        return response(source.filter(doc => doc.id === request.query.queryString.query).slice(0, request.size), request.fields);
                    const [kind, path, exclude] = request.query.bool;
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
                    // findText scans: ID-ordered original batches with bodies, and the size-1 descending upper bound.
                    if (request.sort?.[0]?.id && request.fields?.include?.includes('modifiedAt')
                        && (request.sort[0].id === 'desc' || request.fields.include.includes('body'))) {
                        const override = await fixture.findTextQuery?.(request, options);
                        if (override !== undefined) return override;
                        function matches(doc, { bool, queryString }) {
                            if (bool) return bool[0].occur === 'should'
                                ? bool.some(clause => matches(doc, clause)) : bool.every(clause => matches(doc, clause));
                            const { query, defaultField, skipSyntax } = queryString;
                            if (defaultField === 'kind') return doc.kind === JSON.parse(query);
                            if (defaultField === 'id') return skipSyntax ? doc.id === query : doc.id > /^\{(.+) TO \*\}$/.exec(query)[1];
                            if (defaultField === 'ancestorPaths') return doc.ancestorPaths?.includes(JSON.parse(query));
                            if (defaultField.startsWith('metadata.')) return doc.metadata?.[defaultField.slice(9)] === JSON.parse(query);
                            throw new Error('Unexpected literal scan filter');
                        }
                        const direction = request.sort[0].id === 'asc' ? 1 : -1;
                        const docs = source.filter(doc => request.query.bool.every(clause => matches(doc, clause)))
                            .sort((a, b) => a.id < b.id ? -direction : a.id > b.id ? direction : 0);
                        return response(docs.slice(0, request.size), request.fields);
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
                    async fetch(request) {
                        calls.push({ kind: 'fetch', request: structuredClone(request) });
                        const docs = sourceDocs(request.ref);
                        const override = await fixture.beforeFetch?.(request, docs);
                        const selected = request.ids.map(id => docs.get(id)).filter(Boolean);
                        return override ?? response(request.includeVectors ? selected.map(doc => doc.kind === 'chunk' && !doc.embedding
                            ? { ...doc, embedding: new Array(1536).fill(1) } : doc) : selected, request.fields);
                    },
                    async upsert(request, options) {
                        calls.push({ kind: 'upsert', collection: name, request: structuredClone(request), retries: options?.retries });
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
                        calls.push({ kind: 'delete', collection: name, request: structuredClone(request), retries: options?.retries });
                        const docs = docsAt(request.branch);
                        await fixture.beforeDelete?.(request, docs);
                        for (const id of request.ids) docs.delete(id);
                        await fixture.afterDelete?.(request, docs);
                    },
                },
            };
        },
    };
    // Store file originals directly, without chunks or SDK calls: for listings of many files.
    fixture.seedFiles = (collection, branch, paths) => {
        const docs = collections.get(collection).branches.get(branch).docs;
        return paths.map(path => {
            const fileId = globalThis.crypto.randomUUID();
            const parts = path.slice(1).split('/');
            const fileName = parts.pop();
            const ancestorPaths = parts.reduce((list, part) => [...list, `${list.at(-1)}${part}/`], ['/']);
            const doc = { id: `file:${fileId}`, kind: 'file', fileId, path, fileName, ancestorPaths, modifiedAt: new Date().toISOString(), body: '' };
            docs.set(doc.id, doc);
            return { fileId, path, modifiedAt: doc.modifiedAt };
        });
    };
    return Object.assign(fixture, { client });
}
