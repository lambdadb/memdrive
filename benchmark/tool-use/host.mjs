import { createFileTools, fileToolError, fileToolGuide, fileToolGuideTopics } from '@functional-systems/memdrive';

export const guideURI = 'memdrive://docs/file-tools';
const guideResources = [
    { uri: guideURI, name: 'MemDrive file tool guide', document: fileToolGuide },
    ...Object.entries(fileToolGuideTopics).map(([topic, document]) =>
        ({ uri: `memdrive://docs/${topic}`, name: document.title, document })),
];
const reads = ['list', 'read', 'search', 'findText', 'listForks', 'listCheckpoints'];
const writes = ['fork', 'checkpoint', 'deleteFork', 'deleteCheckpoint', 'write', 'rollback'];
const viewKey = at => at === undefined || at?.kind === 'main' ? 'main' : `${at?.kind}:${at?.name}`;

// A protocol-shaped, in-process host. It is not an MCP server or wire implementation.
// It connects one authorized drive with a fixed allowlist. The model selects
// views with `at`; the host accepts main, the task's starting view, existing
// views the task names (`available`) and views returned by this conversation's
// successful fork or checkpoint calls.
export function createHost({ drive, writable, guide, start = { kind: 'main' }, available = [] }) {
    const events = [];
    const tools = createFileTools({ drive, tools: [...(guide === 'tool' ? ['guide'] : []), ...reads, ...(writable ? writes : [])] });
    const authorized = new Set(['main', viewKey(start), ...available.map(viewKey)]);
    return {
        events,
        start: structuredClone(start),
        toolsList() { return { tools: structuredClone(tools.definitions) }; },
        resourcesList() { return { resources: guide === 'resource'
            ? guideResources.map(({ uri, name }) => ({ uri, name, mimeType: 'text/markdown' })) : [] }; },
        resourcesRead(uri) {
            const resource = guideResources.find(item => item.uri === uri);
            if (guide !== 'resource' || !resource) throw new Error('Resource unavailable');
            const { document } = resource;
            events.push({ kind: 'resource_read', actor: 'host', uri, version: document.version });
            return { contents: [{ uri, mimeType: 'text/markdown', text: document.content }], version: document.version };
        },
        async toolsCall(name, args, { signal } = {}) {
            let result;
            // Evaluation policy, not hosted authentication. The SDK validates at.
            if (['at', 'to'].some(key => args?.[key] !== undefined && !authorized.has(viewKey(args[key]))))
                result = { ok: false, error: { code: 'TARGET_NOT_AUTHORIZED', message: 'The host has not authorized this view for the task.' } };
            else {
                try {
                    result = await tools.execute(name, args, { signal });
                    if ((name === 'fork' || name === 'checkpoint') && result?.at) authorized.add(viewKey(result.at));
                } catch (error) { result = fileToolError(error); }
            }
            events.push({ kind: 'tool', name, args: structuredClone(args), result: structuredClone(result) });
            return result;
        },
    };
}
