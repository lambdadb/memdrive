import { MemDrive, createFileTools, fileToolError, fileToolGuide } from '@functional-systems/memdrive';

export const guideURI = 'memdrive://docs/file-tools';
const reads = ['status', 'history', 'list', 'read', 'search', 'findText'];
const writes = ['fork', 'checkpoint', 'diff', 'write', 'merge'];

// A protocol-shaped, in-process host. It is not an MCP server or wire implementation.
export function createHost({ drive, client, writable, guide, rebindFork = false }) {
    let bound = drive, generation = 0;
    const events = [];
    const catalog = () => createFileTools({ drive: bound, tools: [
        ...(guide === 'tool' ? ['guide'] : []), ...reads,
        ...(writable ? writes.filter(name => !['diff', 'write', 'merge'].includes(name) || bound.at.kind === 'fork') : []),
    ] });
    return {
        events,
        get binding() { return { name: bound.name, at: bound.at, generation }; },
        toolsList() { return { tools: structuredClone(catalog().definitions) }; },
        resourcesList() { return { resources: guide === 'resource'
            ? [{ uri: guideURI, name: 'MemDrive file tool guide', mimeType: 'text/markdown' }] : [] }; },
        resourcesRead(uri) {
            if (guide !== 'resource' || uri !== guideURI) throw new Error('Resource unavailable');
            events.push({ kind: 'resource_read', actor: 'host', uri, version: fileToolGuide.version });
            return { contents: [{ uri, mimeType: 'text/markdown', text: fileToolGuide.content }], version: fileToolGuide.version };
        },
        async toolsCall(name, args, { signal, expectedGeneration = generation } = {}) {
            const before = this.binding;
            if (expectedGeneration !== generation) {
                const result = { ok: false, error: { code: 'BINDING_CHANGED', message: 'The host changed the binding. Use the newly offered tools on the next turn.' } };
                events.push({ kind: 'tool', name, args, before, result });
                return result;
            }
            let result;
            try {
                result = await catalog().execute(name, args, { signal });
            } catch (error) { result = fileToolError(error); }
            // The scenario authorizes only a newly created fork in this store.
            // Never take a store/ref selector directly from model arguments.
            let handoff;
            if (name === 'fork' && rebindFork && before.at.kind === 'main' && result?.at?.kind === 'fork' && result.name === bound.name) {
                bound = await MemDrive.open({ client, name: bound.name, at: { fork: result.at.name } }, { signal });
                generation++;
                handoff = { kind: 'binding_changed', binding: this.binding };
                events.push({ kind: 'host_handoff', ...handoff });
            }
            events.push({ kind: 'tool', name, args: structuredClone(args), before, result: structuredClone(result), ...(handoff ? { handoff } : {}) });
            return result;
        },
    };
}
