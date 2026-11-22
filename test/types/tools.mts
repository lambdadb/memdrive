import { createFileTools, fileToolError, fileToolGuide } from '@functional-systems/memdrive';
import type { FileDrive, FileToolDefinition, FileToolErrorResult, FileToolName, FileToolRefResult, FileTools } from '@functional-systems/memdrive';

export async function toolConsumer(drive: FileDrive, external: FileDrive<'external'>, name: string, input: unknown) {
    const names: readonly FileToolName[] = ['guide', 'status', 'history', 'read', 'fork', 'checkpoint'];
    const tools: FileTools = createFileTools({ drive, tools: names });
    const definitions: readonly FileToolDefinition[] = tools.definitions;
    const schemaType: 'object' = definitions[0]!.inputSchema.type;
    const guideVersion: string = fileToolGuide.version;
    const vectorTools = createFileTools({ drive: external, tools: ['search'] });
    const error: FileToolErrorResult = fileToolError(new Error('failure'));
    const ref: FileToolRefResult = { name: drive.name, at: { kind: 'fork', name: 'draft' } };
    // @ts-expect-error A host must explicitly select permitted tools.
    createFileTools({ drive });
    // @ts-expect-error Recovery is a host operation, not an agent tool.
    createFileTools({ drive, tools: ['recover'] });
    // @ts-expect-error Tool definitions are immutable.
    tools.definitions.push(definitions[0]!);
    await tools.execute(name, input, { signal: new AbortController().signal });
    return { schemaType, guideVersion, vectorTools, error, ref };
}
