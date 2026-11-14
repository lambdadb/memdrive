import { createTools } from '@functional-systems/memdrive/tools';
import type { MemDrive } from '@functional-systems/memdrive';
import { createRetriever, type RetrievalModel, type RetrievalResult, defaultAgentLimits } from '@functional-systems/memdrive/retriever';
declare const drive: MemDrive;
const model: RetrievalModel = { createSession({ request, instructions, tools }) {
    void [request.query, instructions, tools];
    return { prepare(replies) {
        void replies;
        return { inputTokens: 10, respond: async ({ signal, maxOutputTokens }) => {
            void [signal, maxOutputTokens];
            return { status: 'completed', evidenceIds: [], usage: { inputTokens: 10, outputTokens: 2 } };
        } };
    } };
} };
const retriever = await createRetriever({ drive, strategy: 'agentic', agent: { model, countTokens: text => text.length, limits: { rounds: 4 } } });
const result: RetrievalResult = await retriever.recall({ query: 'What happened?', limit: 2 });
void [result.completion.status, result.usage.databaseRequests, defaultAgentLimits.dataCalls];
const tools = await createTools({ drive, retrieval: { strategy: 'agentic', agent: { model, countTokens: text => text.length } } });
await tools.execute('memdrive_recall', { requests: [{ query: 'What happened?' }] });
// @ts-expect-error Retrieval tools use the standard createTools surface.
void retriever.tools;
// @ts-expect-error Retrieval configuration cannot override the tools drive.
await createTools({ drive, retrieval: { drive } });
// @ts-expect-error Strategies are explicit host configuration.
await createRetriever({ drive, strategy: 'automatic' });
// @ts-expect-error Model adapters report normalized usage rather than provider wire payloads.
const invalid: RetrievalModel = { createSession: () => ({ prepare: () => ({ inputTokens: 10, respond: async () => ({ choices: [] }) }) }) };
void invalid;
