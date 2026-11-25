import { createFileTools, fileToolError, fileToolGuide, fileToolGuideTopics } from '@functional-systems/memdrive';

export const guideURI = 'memdrive://docs/file-tools';
const guideResources = [
    { uri: guideURI, name: 'MemDrive file tool guide', document: fileToolGuide },
    ...Object.entries(fileToolGuideTopics).map(([topic, document]) =>
        ({ uri: `memdrive://docs/${topic}`, name: document.title, document })),
];
const reads = ['read', 'list', 'search', 'findText'];

// A protocol-shaped, in-process host. It is not an MCP server or wire implementation.
// It connects main of one authorized drive with a fixed allowlist. In writable
// tasks the host, not the model, makes every write a checkpointed write named
// turn-<n>, so a failed write leaves main at its latest checkpoint. A counter is
// unique here only because every conversation gets a fresh store; a real host
// needs names unique across restarts. `afterCall`
// lets a scenario act as a concurrent writer between tool calls.
export function createHost({ drive, writable, guide, afterCall }) {
    const events = [];
    let turn = 0;
    const tools = createFileTools({ drive, tools: [...(guide === 'tool' ? ['guide'] : []), ...reads, ...(writable ? ['write'] : [])],
        ...(writable ? { checkpoint: () => ({ name: `turn-${++turn}` }) } : {}) });
    return {
        events,
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
            try { result = await tools.execute(name, args, { signal }); }
            catch (error) { result = fileToolError(error); }
            const event = { kind: 'tool', name, args: structuredClone(args), result: structuredClone(result) };
            events.push(event);
            await afterCall?.(event);
            return result;
        },
    };
}
