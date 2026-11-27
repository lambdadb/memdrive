import { createFileTools, getFileToolDefinitions, fileToolError, fileToolInstructions, fileToolGuide, fileToolGuideTopics } from '@functional-systems/memdrive';
import type { FileActor, FileToolCheckpoint, FileToolGuideTopic, FileDrive, FileToolDefinition, FileToolErrorResult, FileToolName, FileTools } from '@functional-systems/memdrive';

export async function toolConsumer(drive: FileDrive, external: FileDrive<'external'>, name: string, input: unknown) {
    const names: readonly FileToolName[] = ['guide', 'read', 'tree', 'list', 'search', 'findText', 'write'];
    // @ts-expect-error Publication tools are removed.
    const removed: FileToolName = 'merge';
    // @ts-expect-error Ref and rollback tools are removed; hosts use the SDK directly.
    const removedRef: FileToolName = 'rollback';
    void removed; void removedRef;
    const tools: FileTools = createFileTools({ drive, tools: names });
    let turn = 0;
    const checkpoint: FileToolCheckpoint = () => ({ name: `turn-${++turn}` });
    createFileTools({ drive, tools: ['write'], checkpoint });
    createFileTools({ drive, tools: ['write'], checkpoint: async () => ({ name: 'turn-async' }) });
    // @ts-expect-error The hook returns a checkpoint name object.
    createFileTools({ drive, tools: ['write'], checkpoint: () => 'turn' });
    // The host names the actor and clock of every write tool call.
    const actor: FileActor = { user: 'user-1', agent: 'assistant' };
    createFileTools({ drive, tools: ['write'], checkpoint, actor, now: () => new Date() });
    // @ts-expect-error now returns a Date.
    createFileTools({ drive, tools: ['write'], now: () => '2026-01-01T00:00:00.000Z' });
    // @ts-expect-error An actor names a user or an agent.
    createFileTools({ drive, tools: ['write'], actor: { team: 'core' } });
    const definitions: readonly FileToolDefinition[] = tools.definitions;
    const fixedDefinitions: readonly FileToolDefinition[] = getFileToolDefinitions({ embeddingMode: 'managed', tools: names });
    getFileToolDefinitions({ embeddingMode: 'external', tools: ['search', 'write'] });
    // @ts-expect-error Definition lookup requires an explicit embedding mode.
    getFileToolDefinitions({ tools: names });
    // @ts-expect-error Definition lookup has no drive.
    getFileToolDefinitions({ embeddingMode: 'managed', tools: names, drive });
    // @ts-expect-error Catalogs are immutable.
    fixedDefinitions.push(definitions[0]!);
    // @ts-expect-error Only supported embedding modes are accepted.
    getFileToolDefinitions({ embeddingMode: 'text', tools: names });
    const schemaType: 'object' = definitions[0]!.inputSchema.type;
    const guideVersion: string = fileToolGuide.version;
    const instructions: string = fileToolInstructions;
    const topic: FileToolGuideTopic = fileToolGuide.topics[0]!.topic;
    const topicContent: string = fileToolGuideTopics[topic].content;
    // @ts-expect-error The guide catalog is immutable.
    fileToolGuideTopics.editing.content = '';
    // @ts-expect-error Unknown guide topics are not part of the catalog.
    const unknownTopic: FileToolGuideTopic = 'unknown';
    void unknownTopic;
    const vectorTools = createFileTools({ drive: external, tools: ['search'] });
    const error: FileToolErrorResult = fileToolError(new Error('failure'));
    // @ts-expect-error A host must explicitly select permitted tools.
    createFileTools({ drive });
    // @ts-expect-error Recovery is a host operation, not an agent tool.
    createFileTools({ drive, tools: ['recover'] });
    // @ts-expect-error Tool definitions are immutable.
    tools.definitions.push(definitions[0]!);
    await tools.execute(name, input, { signal: new AbortController().signal });
    return { schemaType, guideVersion, instructions, topicContent, vectorTools, error };
}

// @ts-expect-error Ref creation returns the SDK result; there is no separate tool ref type.
export type RemovedRefResult = import('@functional-systems/memdrive').FileToolRefResult;
