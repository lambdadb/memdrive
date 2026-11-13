import { MemDriveError } from '../index.js';
import type { CountValuesRequest, ForgetRequest, ListRequest, MemInput, RecallRequest, RequestOptions } from '../types.js';
import { toolDefinitions } from './definitions.js';
import type { CreateToolsOptions, MemoryTools, ToolError, ToolResult } from './types.js';

export type * from './types.js';

const object = (value: unknown): value is Record<string, unknown> => value !== null
    && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function requireInput(condition: unknown, message: string): asserts condition {
    if (!condition) throw new MemDriveError('INVALID_INPUT', message);
}
function checkAbort(options: RequestOptions) {
    if (options.signal?.aborted) throw new MemDriveError('ABORTED', 'Operation aborted.');
}
function errorResult(cause: unknown): ToolResult {
    if (!(cause instanceof MemDriveError)) return { ok: false,
        error: { code: 'TOOL_EXECUTION_FAILED', message: 'Memory tool execution failed.' } };
    const error: ToolError = { code: cause.code, message: cause.message };
    if (Number.isInteger(cause.status)) error.status = cause.status!;
    // Preserve actionable write outcomes, never transport details, causes or stacks.
    if (cause.details) {
        const details: NonNullable<ToolError['details']> = {};
        for (const key of ['completedIds', 'uncertainIds', 'notAttemptedIds'] as const) {
            const value = cause.details[key];
            if (Array.isArray(value) && value.every((id): id is string => typeof id === 'string')) details[key] = [...value];
        }
        if (Object.keys(details).length) error.details = details;
    }
    return { ok: false, error };
}

/** Bind portable tools to an already authorized drive; no model or MCP runtime. */
export async function createTools(configuration: CreateToolsOptions, options: RequestOptions = {}): Promise<MemoryTools> {
    requireInput(object(configuration) && Object.keys(configuration).every(key => ['drive', 'branch', 'writable'].includes(key)),
        'Use drive, optional branch and writable to create memory tools.');
    requireInput(configuration.writable === undefined || typeof configuration.writable === 'boolean', 'writable must be a boolean.');
    const { drive, branch, writable = false } = configuration;
    requireInput(drive && typeof drive.describe === 'function' && typeof drive.recall === 'function', 'Provide a MemDrive handle.');
    const data = branch === undefined ? drive : drive.at({ branch });
    const descriptor = await drive.describe(options);
    checkAbort(options);
    const definitions = toolDefinitions(descriptor, writable);
    const enabled = new Set(definitions.map(tool => tool.name));
    return Object.freeze({
        get definitions() { return structuredClone(definitions); },
        async execute(name: string, input: unknown, requestOptions: RequestOptions = {}): Promise<ToolResult> {
            try {
                requireInput(object(requestOptions) && Object.keys(requestOptions).every(key => key === 'signal'), 'Operation options accept only signal.');
                checkAbort(requestOptions);
                if (!enabled.has(name as (typeof definitions)[number]['name']))
                    throw new MemDriveError('UNKNOWN_TOOL', 'Unknown or disabled memory tool.');
                requireInput(object(input), 'Tool arguments must be an object.');
                // Detach inputs before any SDK operation can yield. No coercion or null stripping.
                let args: Record<string, unknown>;
                try { args = structuredClone(input); }
                catch { throw new MemDriveError('INVALID_INPUT', 'Tool arguments must be cloneable data.'); }
                let value: unknown;
                switch (name) {
                    case 'memdrive_recall':
                        requireInput(Object.keys(args).length === 1 && Array.isArray(args.requests)
                            && args.requests.length >= 1 && args.requests.length <= 5,
                        'recall requires requests containing 1 to 5 search requests.');
                        value = await data.recall({ requests: args.requests as RecallRequest[] }, requestOptions);
                        break;
                    case 'memdrive_read':
                        value = await data.read(args as { ids: string[] }, requestOptions);
                        break;
                    case 'memdrive_describe':
                        requireInput(Object.keys(args).length === 0, 'describe accepts an empty object.');
                        value = await drive.describe(requestOptions);
                        break;
                    case 'memdrive_count_values':
                        value = await data.countValues(args as unknown as CountValuesRequest, requestOptions);
                        break;
                    case 'memdrive_list':
                        value = await data.list(args as ListRequest, requestOptions);
                        break;
                    case 'memdrive_remember':
                        value = await data.remember(args as { mems: MemInput[] }, requestOptions);
                        break;
                    case 'memdrive_forget':
                        await data.forget(args as unknown as ForgetRequest, requestOptions);
                        value = { acknowledged: true };
                        break;
                }
                requireInput(object(value), 'Memory tool returned an invalid result.');
                // Preserve settled SDK outcomes, including completed items in a canceled batch.
                // SDK outputs are JSON data. Every transport receives the same detached value.
                return { ok: true, value: structuredClone(value) };
            } catch (cause) {
                return errorResult(cause);
            }
        },
    });
}
