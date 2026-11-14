import { MemDriveError } from '../index.js';
import type { CountValuesRequest, ForgetRequest, ListRequest, MemInput, RecallRequest, RequestOptions } from '../types.js';
import { toolDefinitions } from './definitions.js';
import { evidenceIds as createEvidenceIds } from './evidence-ids.js';
import { shortIds as createShortIds } from './short-ids.js';
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
    requireInput(object(configuration) && Object.keys(configuration).every(key => ['drive', 'branch', 'writable', 'shortIds', 'evidenceIds'].includes(key)),
        'Use drive, optional branch, writable, shortIds and evidenceIds to create memory tools.');
    requireInput(configuration.writable === undefined || typeof configuration.writable === 'boolean', 'writable must be a boolean.');
    requireInput(configuration.shortIds === undefined || typeof configuration.shortIds === 'boolean', 'shortIds must be a boolean.');
    requireInput(configuration.evidenceIds === undefined || typeof configuration.evidenceIds === 'boolean', 'evidenceIds must be a boolean.');
    const { drive, branch, writable = false, shortIds = false, evidenceIds = false } = configuration;
    requireInput(!(shortIds || evidenceIds) || !writable, 'Session IDs require read-only memory tools.');
    requireInput(drive && typeof drive.describe === 'function' && typeof drive.recall === 'function', 'Provide a MemDrive handle.');
    const data = branch === undefined ? drive : drive.at({ branch });
    const descriptor = await drive.describe(options);
    checkAbort(options);
    const definitions = toolDefinitions(descriptor, writable, shortIds, evidenceIds);
    const ids = shortIds ? createShortIds() : undefined;
    const evidence = evidenceIds ? createEvidenceIds(descriptor.embedding.mode === 'external') : undefined;
    const enabled = new Set(definitions.map(tool => tool.name));
    return Object.freeze({
        get definitions() { return structuredClone(definitions); },
        resolveId: (id: string) => ids ? ids.resolve(id) : id,
        resolveEvidence: (id: string) => {
            if (!evidence) throw new MemDriveError('INVALID_INPUT', 'Evidence IDs are disabled for this tool session.');
            return evidence.resolve(id);
        },
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
                    case 'memdrive_recall': {
                        requireInput(Object.keys(args).length === 1 && Array.isArray(args.requests)
                            && args.requests.length >= 1 && args.requests.length <= 5,
                        'recall requires requests containing 1 to 5 search requests.');
                        const aliasErrors = new Map<number, string>();
                        if (ids) args.requests.forEach((request, index) => {
                            try {
                                const translated = structuredClone(request);
                                ids.query(translated);
                                (args.requests as unknown[])[index] = translated;
                            }
                            catch (cause) {
                                if (!(cause instanceof MemDriveError)) throw cause;
                                aliasErrors.set(index, cause.message);
                                // Retain batch indices and SDK cancellation/validation order; {} cannot dispatch a query.
                                (args.requests as unknown[])[index] = {};
                            }
                        });
                        const received = await data.recall({ requests: args.requests as RecallRequest[] }, requestOptions);
                        const recalled = aliasErrors.size ? structuredClone(received) : received;
                        for (const [index, message] of aliasErrors) {
                            const item = recalled.results[index];
                            if (item && 'error' in item && item.error.code === 'INVALID_INPUT') item.error.message = message;
                        }
                        value = recalled;
                        break;
                    }
                    case 'memdrive_read':
                        ids?.read(args);
                        value = await data.read(args as { ids: string[] }, requestOptions);
                        break;
                    case 'memdrive_describe':
                        requireInput(Object.keys(args).length === 0, 'describe accepts an empty object.');
                        value = await drive.describe(requestOptions);
                        break;
                    case 'memdrive_count_values':
                        ids?.query(args);
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
                const detached = structuredClone(value);
                evidence?.output(name, detached);
                ids?.output(name, detached);
                return { ok: true, value: detached };
            } catch (cause) {
                return errorResult(cause);
            }
        },
    });
}
