import type { RecallRequest, TextRecallRequest, MetadataSchema, EmbeddingConfig } from './types.js';
import { validateVector } from './storage.js';
import { validateFilter } from './filter.js';
import { requireInput } from './errors.js';

export type ValidRecall = RecallRequest & { limit: number };
const keys = (value: unknown, allowed: string[]): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => allowed.includes(key));
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

export function recallInput(request: unknown, schema: MetadataSchema, embedding: EmbeddingConfig): ValidRecall {
    const external = embedding.mode === 'external';
    requireInput(keys(request, [...(external ? ['queryVector'] : ['query', 'recentDialogue', 'context']), 'filter', 'excludeIds', 'limit', 'rerank']),
        'Use the documented recall arguments.');
    if (external) {
        validateVector(request.queryVector, embedding);
    } else requireInput(nonempty(request.query) && request.query.trim() !== '*:*', 'query must be nonempty text other than the exact match-all expression *:*.');
    requireInput(request.context === undefined || typeof request.context === 'string', 'context must be text.');
    requireInput(request.recentDialogue === undefined || (Array.isArray(request.recentDialogue)
        && request.recentDialogue.every(message => keys(message, ['role', 'content'])
            && typeof message.role === 'string' && ['user', 'assistant'].includes(message.role) && typeof message.content === 'string')),
    'recentDialogue must contain role-labelled user/assistant text.');
    requireInput(request.rerank === undefined || typeof request.rerank === 'boolean', 'rerank must be a boolean.');
    requireInput(request.excludeIds === undefined || (Array.isArray(request.excludeIds)
        && request.excludeIds.every(nonempty) && new Set(request.excludeIds).size === request.excludeIds.length),
    'excludeIds must contain distinct canonical IDs.');
    const limit = request.limit ?? 10;
    requireInput(typeof limit === 'number' && Number.isSafeInteger(limit) && limit >= 1 && limit <= 1000, 'limit must be between 1 and 1000.');
    validateFilter(request.filter, schema);
    return { ...structuredClone(request), limit } as ValidRecall;
}

export function contextualQuery(request: TextRecallRequest): string {
    if (!request.recentDialogue?.length && !request.context) return request.query;
    return JSON.stringify({ question: request.query,
        ...(request.recentDialogue?.length ? { recent_dialogue: request.recentDialogue } : {}),
        ...(request.context ? { context: request.context } : {}) });
}

export function textRecallQuery(request: TextRecallRequest): string {
    const context = contextualQuery(request);
    // Native text-query input bound, not a silent SDK context truncation policy.
    requireInput(new TextEncoder().encode(request.query).length <= 8192 && new TextEncoder().encode(context).length <= 8192,
        'The contextual search query exceeds the native 8 KiB limit.');
    return context;
}
