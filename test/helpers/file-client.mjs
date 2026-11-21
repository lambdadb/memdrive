import { memdriveClient } from './memdrive-client.mjs';

export const fileClient = () => {
    const fixture = memdriveClient();
    const { client } = fixture;
    const collection = client.collection;
    client.collection = name => {
        const handle = collection(name);
        const query = handle.query;
        handle.query = (request, options) => {
            const [kind, path] = request.query.bool;
            // Log the query through the existing fixture, then model exact keyword lookup.
            return query(request, options).then(() => {
                const branch = fixture.collections.get(name).branches.get(request.ref.name);
                const docs = [...branch.docs.values()].filter(doc =>
                    doc.kind === JSON.parse(kind.queryString.query) && doc.path === JSON.parse(path.queryString.query))
                    .slice(0, request.size).map(doc => ({ collection: name, doc: structuredClone(doc) }));
                return { isDocsInline: true, docs };
            });
        };
        return handle;
    };
    return fixture;
};
