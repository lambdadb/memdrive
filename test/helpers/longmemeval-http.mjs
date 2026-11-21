// Scripted native HTTP responses for the benchmark SDK call sequence.
export function nativeFixture() {
    const collections = new Map(), requests = [];
    const fetcher = async (url, options) => {
        const pathname = new URL(url).pathname, body = options.body ? JSON.parse(options.body) : undefined;
        requests.push({ pathname, method: options.method, body });
        const name = /\/collections\/([^/]+)/.exec(pathname)?.[1], existing = collections.get(name);
        const response = (value, status = 200) => new Response(JSON.stringify(value), {
            status, headers: { 'content-type': 'application/json' },
        });
        if (pathname.endsWith('/collections') && options.method === 'POST') {
            if (collections.has(body.collectionName)) return response({}, 409);
            const metadata = { description: '', ...body, projectName: 'test', snapshotRetentionInDays: 30, defaultBranchName: 'main',
                numDocs: 0, numPartitions: 1, createdAt: 0, updatedAt: 0 };
            collections.set(body.collectionName, { metadata, branches: new Map([['main', { docs: new Map() }]]) });
            return response({ collection: metadata }, 201);
        }
        if (!existing) return response({ message: 'not found' }, 404);
        const { metadata: collection, branches } = existing;
        if (options.method === 'DELETE' && pathname.endsWith('/' + name)) {
            collections.delete(name);
            return response({ message: 'deleted' });
        }
        const branch = name => {
            const numDocs = branches.get(name).docs.size;
            return { name, parentBranch: null, headSnapshot: numDocs ? { snapshotId: 'synthetic', snapshotCommittedAt: 0 } : null,
                parentSnapshot: null, createdAt: 0, dataUpdatedAt: numDocs ? 0 : null, numDocs, indexConfigs: collection.indexConfigs };
        };
        const branchName = /\/branches\/([^/]+)$/.exec(pathname)?.[1];
        if (branchName && options.method === 'GET')
            return branches.has(branchName) ? response({ branch: branch(branchName) }) : response({ message: 'not found' }, 404);
        if (pathname.endsWith('/branches')) {
            if (options.method === 'GET') return response({ branches: [...branches.keys()].map(branch) });
            const { branchName, source } = body;
            branches.set(branchName, { docs: new Map(branches.get(source.name).docs) });
            return response({ branch: branch(branchName) }, 201);
        }
        if (options.method === 'GET' && pathname.endsWith('/' + name)) return response({ collection });
        const docs = branches.get(body.branch ?? body.ref.name).docs;
        if (pathname.endsWith('/docs/upsert')) {
            for (const doc of body.docs) docs.set(doc.id, doc);
            return response({ message: 'accepted' }, 202);
        }
        const hits = matches => ({ isDocsInline: true, docs: matches.map(doc => ({ doc: project(doc), collection: name, score: 0.9 })),
            total: matches.length, took: 1 });
        const project = doc => body.fields?.include
            ? Object.fromEntries(body.fields.include.filter(field => Object.hasOwn(doc, field)).map(field => [field, doc[field]]))
            : doc;
        if (pathname.endsWith('/docs/fetch')) return response(hits(body.ids.map(id => docs.get(id)).filter(Boolean)));
        if (pathname.endsWith('/query')) {
            if (body.query.bool) {
                const [kindClause, pathClause] = body.query.bool;
                const kind = JSON.parse(kindClause.queryString.query);
                const paths = (pathClause.bool ?? [pathClause]).map(item => JSON.parse(item.queryString.query));
                return response(hits([...docs.values()].filter(doc => doc.kind === kind && paths.includes(doc.path)).slice(0, body.size)));
            }
            const matches = [...docs.values()].filter(doc => doc.kind === 'chunk').slice(0, body.size);
            return response({ ...hits(matches), ...(body.rerank ? { rerank: {
                provider: 'typesafe', model: 'jev-1.13.0', status: 'applied', took: 1,
                candidateCount: matches.length, scoredCount: matches.length,
            } } : {}) });
        }
        throw new Error('Unexpected native request: ' + pathname);
    };
    return { fetcher, requests, collections };
}
export const row = () => ({ question_id: 'synthetic', question_type: 'single-session-user', question: 'Where is the key?', answer: 'cedar',
    question_date: '2023/01/03 (Tue) 10:00', haystack_dates: ['2023/01/02 (Mon) 10:00'], haystack_session_ids: ['s1'],
    answer_session_ids: ['s1'], haystack_sessions: [[{ role: 'user', content: 'The 🧭 key is under cedar. {{literal}} <USER>', has_answer: true },
        { role: 'assistant', content: 'Understood.' }, { role: 'user', content: 'Recent one' },
        { role: 'assistant', content: 'Recent reply one' }, { role: 'user', content: 'Recent two' }, { role: 'assistant', content: 'Recent reply two' }]] });
export const keys = { database: 'https://memory.invalid', project: 'test', databaseKey: 'synthetic-database-key', modelKey: 'synthetic-model-key', judgeKey: 'synthetic-judge-key' };
