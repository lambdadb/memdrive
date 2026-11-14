import type { RequestOptions } from '../types.js';
import { requireInput } from '../errors.js';
import { createRetriever } from '../retriever/index.js';
import { createMemoryTools } from './factory.js';
import type { CreateToolsOptions, MemoryTools } from './types.js';
export type * from './types.js';

/** Bind the existing tool catalog; optional orchestration changes only recall execution. */
export async function createTools(configuration: CreateToolsOptions, options: RequestOptions = {}): Promise<MemoryTools> {
    requireInput(configuration !== null && typeof configuration === 'object' && !Array.isArray(configuration)
        && Object.keys(configuration).every(key => ['drive', 'branch', 'writable', 'retrieval'].includes(key)), 'Use drive, optional branch, writable and retrieval to create memory tools.');
    const retrieval = configuration?.retrieval;
    requireInput(retrieval === undefined || (retrieval !== null && typeof retrieval === 'object' && !Array.isArray(retrieval)
        && Object.keys(retrieval).every(key => ['strategy', 'agent', 'record'].includes(key))), 'Use documented retrieval options.');
    const agent = retrieval?.agent;
    const snapshot = retrieval === undefined ? undefined : { ...retrieval,
        ...(agent && typeof agent === 'object' && !Array.isArray(agent) ? { agent: { ...agent,
            model: typeof agent.model?.createSession === 'function' ? { createSession: agent.model.createSession.bind(agent.model) } : agent.model,
            ...(agent.limits && typeof agent.limits === 'object' && !Array.isArray(agent.limits) ? { limits: { ...agent.limits } } : {}),
        } } : {}),
    };
    const tools = await createMemoryTools(configuration, options, snapshot === undefined ? undefined
        : drive => createRetriever({ ...snapshot, drive }, options));
    return Object.freeze({ get definitions() { return tools.definitions; }, execute: tools.execute });
}
