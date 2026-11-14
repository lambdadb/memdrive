// Scripted native HTTP responses, not a search engine emulator.
export function nativeFixture() {
    const collections = new Map(), requests = [];
    const fetcher = async (url, options) => {
        const pathname = new URL(url).pathname, body = options.body ? JSON.parse(options.body) : undefined;
        requests.push({ pathname, method: options.method, body });
        const name = /\/collections\/([^/]+)/.exec(pathname)?.[1], existing = collections.get(name);
        let result, status = 200;
        if (pathname.endsWith('/collections') && options.method === 'POST') {
            if (collections.has(body.collectionName)) return new Response('{}', { status: 409 });
            const metadata = { ...body, projectName: 'test', snapshotRetentionInDays: 30, defaultBranchName: 'main',
                numDocs: 0, numPartitions: 1, createdAt: 0, updatedAt: 0 };
            collections.set(body.collectionName, { metadata, docs: new Map() });
            result = { collection: metadata }; status = 201;
        } else if (!existing) { result = { message: 'not found' }; status = 404; }
        else {
            const { metadata: collection, docs } = existing;
            if (options.method === 'DELETE') { collections.delete(name); result = { message: 'deleted' }; }
            else if (pathname.endsWith('/docs/upsert')) { for (const doc of body.docs) docs.set(doc.id, doc); result = { message: 'accepted' }; status = 202; }
            else if (pathname.endsWith('/docs/fetch')) result = { isDocsInline: true, docs: body.ids.filter(id => docs.has(id)).map(id => ({ doc: docs.get(id), collection: name })), total: 1, took: 1 };
            else if (pathname.endsWith('/query')) {
                const matches = [...docs.values()].filter(doc => doc.content).slice(0, body.size);
                result = { isDocsInline: true, docs: matches.map(doc => ({ doc, collection: name, score: 0.9 })), total: matches.length, took: 1,
                    rerank: { provider: 'typesafe', model: 'jev-1.13.0', status: 'applied', took: 1, candidateCount: matches.length, scoredCount: matches.length } };
                if (body.facets) result.facets = Object.fromEntries(Object.keys(body.facets).map(field => [field, { buckets: [{ value: 'user', count: 1 }, { value: 'assistant', count: 1 }] }]));
            } else result = { collection };
        }
        return new Response(JSON.stringify(result), { status, headers: { 'content-type': 'application/json' } });
    };
    return { fetcher, requests, collections, get collection() { return collections.values().next().value?.metadata; } };
}

export const row = () => ({ question_id: 'synthetic', question_type: 'single-session-user', question: 'Where is the key?', answer: 'cedar',
    question_date: '2023/01/03 (Tue) 10:00', haystack_dates: ['2023/01/02 (Mon) 10:00'], haystack_session_ids: ['s1'],
    answer_session_ids: ['s1'], haystack_sessions: [[{ role: 'user', content: 'The 🧭 key is under cedar. {{literal}} <USER>', has_answer: true },
        { role: 'assistant', content: 'Understood.' }, { role: 'user', content: 'Recent one' },
        { role: 'assistant', content: 'Recent reply one' }, { role: 'user', content: 'Recent two' }, { role: 'assistant', content: 'Recent reply two' }]] });
export const keys = { database: 'https://memory.invalid', project: 'test', databaseKey: 'synthetic-database-key', modelKey: 'synthetic-model-key', judgeKey: 'synthetic-judge-key' };
