import { createFileTools, getFileToolDefinitions, fileToolError, fileToolGuide, fileToolGuideTopics } from '@functional-systems/memdrive';
import type { FileToolGuideTopic, FileDrive, FileToolDefinition, FileToolErrorResult, FileToolName, FileTools } from '@functional-systems/memdrive';

export async function toolConsumer(drive: FileDrive, external: FileDrive<'external'>, name: string, input: unknown) {
    const names: readonly FileToolName[] = ['guide', 'status', 'history', 'read', 'fork', 'checkpoint', 'listForks', 'listCheckpoints',
        'deleteFork', 'deleteCheckpoint', 'write', 'diff', 'merge'];
    const tools: FileTools = createFileTools({ drive, tools: names });
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
    return { schemaType, guideVersion, topicContent, vectorTools, error };
}

// @ts-expect-error Ref creation returns the SDK result; there is no separate tool ref type.
export type RemovedRefResult = import('@functional-systems/memdrive').FileToolRefResult;
