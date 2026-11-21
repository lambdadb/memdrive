// In-memory transport for the historical LongMemEval memory tools tests.
export function memoryBaselineClient() {
    const collections = new Map();
    const fixture = { search: () => [] };
    return Object.assign(fixture, {
        client: {
            async createCollection(request) {
                collections.set(request.collectionName, {
                    metadata: structuredClone({ ...request, snapshotRetentionInDays: 30, defaultBranchName: 'main' }),
                    docs: new Map(),
                });
            },
            collection(name) {
                const state = () => collections.get(name);
                const hit = doc => ({ collection: name, doc: structuredClone(doc) });
                return {
                    async get() { return { collection: structuredClone(state().metadata) }; },
                    async query(request) {
                        const searchable = [...state().docs.values()].filter(doc => doc.content?.trim());
                        const docs = fixture.search(request, searchable).map(doc => ({ ...hit(doc), score: 0.8 }));
                        return { isDocsInline: true, docs, ...(request.rerank ? { rerank: {
                            provider: request.rerank.provider, model: request.rerank.model,
                            status: docs.length ? 'applied' : 'skipped', ...(docs.length ? {} : { reason: 'noCandidates' }),
                            candidateCount: docs.length, scoredCount: docs.length,
                        } } : {}) };
                    },
                    docs: {
                        async fetch({ ids }) {
                            const docs = state().docs;
                            return { isDocsInline: true, docs: ids.filter(id => docs.has(id)).map(id => hit(docs.get(id))) };
                        },
                        async upsert({ docs }) {
                            for (const doc of docs) state().docs.set(doc.id, structuredClone(doc));
                        },
                    },
                };
            },
        },
    });
}
