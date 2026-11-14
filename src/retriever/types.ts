import type { MemDrive, RecallRequest, Match, RequestOptions, TextRecallRequest } from '../types.js';
import type { ToolDefinition, ToolResult } from '../tools/types.js';

export interface ModelToolCall { id: string; name: string; arguments: unknown }
export interface ModelToolReply { id: string; name: string; result: ToolResult }
export interface ModelTurn {
    status: 'completed' | 'incomplete';
    calls?: ModelToolCall[];
    evidenceIds?: string[];
    usage: { inputTokens: number; outputTokens: number };
}
export interface RetrievalModel {
    /** Local only: create isolated provider conversation state for this recall. */
    createSession(input: { request: TextRecallRequest; instructions: string; tools: ToolDefinition[] }): {
        /** Local only: append replies and prepare the next request without network dispatch. */
        prepare(replies: ModelToolReply[]): {
            /** Conservative estimate of the complete provider request, including schema/history overhead. */
            inputTokens: number;
            respond(options: { signal: AbortSignal; maxOutputTokens: number }): Promise<ModelTurn>;
        };
    };
}
export interface AgentLimits {
    rounds: number;
    toolCalls: number;
    /** Public SDK calls; each recall batch item counts separately. Not native HTTP requests. */
    dataCalls: number;
    contextTokens: number;
    modelTokens: number;
    maxOutputTokens: number;
    toolResultTokens: number;
    timeoutMs: number;
}
export interface RetrieverUsage {
    elapsedMs: number;
    /** Null when any invoked primitive does not expose native request accounting. */
    databaseRequests: number | null;
    knownRecallDatabaseRequests: number;
    dataCalls: number;
    toolCalls: number;
    modelCalls: number;
    inputTokens: number;
    outputTokens: number;
    unknownUsageCalls: number;
}
export interface RetrievalResult {
    /** Only an explicit successful selection; never an automatic fallback candidate set. */
    matches: Match[];
    completion: { status: 'completed' | 'budget_exhausted' | 'aborted' | 'failed'; reason?: string };
    usage: RetrieverUsage;
}
export interface CreateRetrieverOptions {
    drive: MemDrive;
    strategy?: 'single_pass' | 'agentic';
    agent?: {
        model: RetrievalModel;
        /** Generic retrieval guidance by default; host-owned application guidance is optional. */
        instructions?: string;
        /** Token count for a complete serialized tool result; no text is silently truncated. */
        countTokens(text: string): number;
        limits?: Partial<AgentLimits>;
    };
    /** Scoped SDK orchestration events; underlying drive/native diagnostics have their own scope. */
    record?: (event: Record<string, unknown>) => void | Promise<void>;
}
export interface Retriever {
    recall(request: RecallRequest, options?: RequestOptions): Promise<RetrievalResult>;
}
