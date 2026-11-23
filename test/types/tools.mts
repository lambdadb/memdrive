import { createFileTools, fileToolError, fileToolGuide, fileToolGuideTopics } from '@functional-systems/memdrive';
import type { FileToolGuideTopic, FileDrive, FileToolDefinition, FileToolErrorResult, FileToolName, FileToolRefResult, FileTools } from '@functional-systems/memdrive';

export async function toolConsumer(drive: FileDrive, external: FileDrive<'external'>, name: string, input: unknown) {
    const names: readonly FileToolName[] = ['guide', 'status', 'history', 'read', 'fork', 'checkpoint'];
    const tools: FileTools = createFileTools({ drive, tools: names });
    const definitions: readonly FileToolDefinition[] = tools.definitions;
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
    const ref: FileToolRefResult = { name: drive.name, at: { kind: 'fork', name: 'draft' } };
    // @ts-expect-error A host must explicitly select permitted tools.
    createFileTools({ drive });
    // @ts-expect-error Recovery is a host operation, not an agent tool.
    createFileTools({ drive, tools: ['recover'] });
    // @ts-expect-error Tool definitions are immutable.
    tools.definitions.push(definitions[0]!);
    await tools.execute(name, input, { signal: new AbortController().signal });
    return { schemaType, guideVersion, topicContent, vectorTools, error, ref };
}
