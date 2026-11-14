import { create } from '@functional-systems/memdrive';
import { createTools, type MemoryTools, type ToolDefinition, type ToolResult } from '@functional-systems/memdrive/tools';
import { LambdaDBClient } from '@functional-systems/lambdadb';

const client = new LambdaDBClient({ baseUrl: 'https://example.invalid', projectName: 'sample', projectApiKey: 'synthetic' });
const drive = await create({ client, name: 'sample', metadataSchema: {} });
const tools: MemoryTools = await createTools({ drive, branch: 'main', writable: true });
const definitions: ToolDefinition[] = tools.definitions;
const compact: MemoryTools = await createTools({ drive, shortIds: true });
const canonicalId: string = compact.resolveId('m1');
void canonicalId;
const result: ToolResult = await tools.execute('memdrive_recall', { requests: [{ query: 'A question' }] });
if (result.ok) {
    const value: Record<string, unknown> = result.value;
    void value;
} else {
    const code: string = result.error.code;
    const uncertain: string[] | undefined = result.error.details?.uncertainIds;
    void [code, uncertain];
}
const definition = definitions[0];
const readonly: boolean = definition.annotations.readOnlyHint;
void readonly;
// @ts-expect-error Write exposure requires a boolean choice.
await createTools({ drive, writable: 'yes' });
// @ts-expect-error The bound branch is a name, not a model argument or arbitrary ref.
await createTools({ drive, branch: { name: 'main' } });
// @ts-expect-error The common tool layer does not configure model clients.
await createTools({ drive, model: {} });
// @ts-expect-error Session IDs are an explicit boolean option.
await createTools({ drive, shortIds: 'true' });
// @ts-expect-error Resolving an ID accepts a string, not a tool response.
compact.resolveId({ memId: 'm1' });
