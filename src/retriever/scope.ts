import type { BatchRecallResult, MemDrive, RecallRequest, RecallResult, RequestOptions, Filter, DriveDescriptor, Mem } from '../types.js';
import { requireInput } from '../errors.js';
import { recallInput } from '../recall-input.js';
import { matchesFilter, validateFilter } from '../filter.js';
import type { RetrieverUsage } from './types.js';

/** Scope limits data exposed by this orchestration, not authorization of the underlying handle. */
export function scopedDrive(drive: MemDrive, request: RecallRequest, descriptor: DriveDescriptor,
    usage: RetrieverUsage, reserve: (calls: number) => void): MemDrive {
    const excluded = new Set(request.excludeIds ?? []);
    const allowed = (mem: Mem) => !excluded.has(mem.id) && matchesFilter(mem, request.filter, descriptor.metadataSchema);
    const narrow = <T extends { filter?: Filter | undefined; excludeIds?: string[] | undefined }>(input: T): T => {
        requireInput(input.excludeIds === undefined || (Array.isArray(input.excludeIds) && input.excludeIds.every(id => typeof id === 'string' && id.trim())
            && new Set(input.excludeIds).size === input.excludeIds.length), 'excludeIds must contain distinct canonical IDs.');
        validateFilter(input.filter, descriptor.metadataSchema);
        return { ...input,
            filter: request.filter && input.filter ? { and: [request.filter, input.filter] } : request.filter ?? input.filter,
            excludeIds: [...new Set([...excluded, ...(input.excludeIds ?? [])])],
        };
    };
    async function recall(input: RecallRequest, options?: RequestOptions): Promise<RecallResult>;
    async function recall(input: { requests: RecallRequest[] }, options?: RequestOptions): Promise<BatchRecallResult>;
    async function recall(input: RecallRequest | { requests: RecallRequest[] }, options?: RequestOptions): Promise<RecallResult | BatchRecallResult> {
        const batch = 'requests' in input;
        const requests = batch ? input.requests : [input]; reserve(requests.length);
        const previousRequests = usage.databaseRequests;
        // Until the call settles, cancellation cannot claim an exact native request total.
        usage.databaseRequests = null;
        let result: BatchRecallResult;
        try { result = await drive.recall({ requests: requests.map(item => {
            // Invalid items retain SDK batch error/cancellation semantics and cannot dispatch.
            try { recallInput(item, descriptor.metadataSchema, descriptor.embedding); }
            catch { return item; }
            return narrow(item);
        }) }, options); }
        catch (error) { usage.databaseRequests = null; throw error; }
        usage.databaseRequests = previousRequests;
        for (const item of result.results) {
            usage.knownRecallDatabaseRequests += item.usage.databaseRequests;
            if (usage.databaseRequests !== null) usage.databaseRequests += item.usage.databaseRequests;
        }
        return batch ? result : result.results[0] as RecallResult;
    }
    const uncounted = () => { reserve(1); usage.databaseRequests = null; };
    let initial = true;
    return { ...drive, recall,
        describe: async options => {
            // createTools already has the constructor's validated descriptor; explicit model calls refresh it.
            if (initial) { initial = false; return structuredClone(descriptor); }
            uncounted(); return drive.describe(options);
        },
        read: async (input, options) => { uncounted(); const result = await drive.read(input, options); return { mems: result.mems.filter(allowed) }; },
        list: async (input, options) => { uncounted(); const result = await drive.list(input, options); return { ...result, mems: result.mems.filter(allowed) }; },
        countValues: async (input, options) => { uncounted(); return drive.countValues(narrow(input), options); },
    };
}
