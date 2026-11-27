import { isObject, keysOnly } from './config.js';
import { checkAbort, databaseError, MemDriveError, nativeOptions, nativeRequest, operationOptions, requireInput } from './errors.js';
import { codePointOrder } from './list.js';
import { resultDocs, validPath } from './records.js';
import { ancestorFilter, viewRead, type Handle, type ViewRef, type WithoutAt } from './storage-reads.js';
import type { RequestOptions, TreeRequest, TreeResult } from './types.js';

/**
 * Facet buckets requested per tree call. LambdaDB returns at most 100 buckets
 * per field today; when it allows more, raise this one value.
 */
export const treeBucketLimit = 100;
const kind = { queryString: { query: '"file"', defaultField: 'kind' }, occur: 'filter' };

/** The number of file records a query matched, from its `kind` facet: every file record has kind "file". */
function matchedCount(response: unknown) {
    const buckets: unknown = isObject(response) && isObject(response.facets) && isObject(response.facets.kind)
        ? response.facets.kind.buckets : undefined;
    if (!Array.isArray(buckets) || buckets.length > 1) return undefined;
    if (!buckets.length) return 0;
    const [bucket] = buckets as unknown[];
    return isObject(bucket) && bucket.value === 'file' && Number.isSafeInteger(bucket.count) && (bucket.count as number) > 0
        ? bucket.count as number : undefined;
}

/**
 * Describe the folders under a prefix with one facet query over `ancestorPaths`,
 * which holds `/` and every ancestor folder of each file. A `kind` facet in the
 * same request counts the files under the prefix, independently of which folder
 * buckets fit. No file record or content is read, so this works in managed and
 * external embedding modes.
 */
export function fileTree(handle: Handle, name: string) {
    return async function tree(ref: ViewRef, request: WithoutAt<TreeRequest> = {}, options?: RequestOptions): Promise<TreeResult> {
        const { signal } = operationOptions(options);
        checkAbort(signal);
        requireInput(keysOnly(request, ['prefix']), 'tree accepts only an optional prefix.');
        const { prefix = '/' } = request;
        requireInput(prefix === '/' || (typeof prefix === 'string' && prefix.endsWith('/') && validPath(prefix.slice(0, -1))),
            'Tree prefix must be "/" or an absolute folder path ending in "/" with valid nonempty components.');
        let response;
        try {
            response = await nativeRequest(() => handle.query({ ...viewRead(ref), size: 0, query: { bool: [kind, ...ancestorFilter(prefix)] },
                facets: { ancestorPaths: { size: treeBucketLimit }, kind: { size: 1 } } }, nativeOptions(signal)), signal);
        } catch (cause) {
            const error = databaseError(cause, 'Could not read the drive tree.');
            // LambdaDB answers 400 when the distinct folders exceed its facet budget; the
            // response does not identify that case reliably, so the message only suggests it.
            if (error.status === 400 && error.code === 'DATABASE_ERROR')
                error.message = 'LambdaDB rejected the drive tree request. If the drive has very many or very deep folders, pass a narrower prefix; folders of search hit paths are candidates.';
            throw error;
        }
        checkAbort(signal);
        resultDocs(response, name, 0);
        const buckets: unknown = isObject(response.facets) && isObject(response.facets.ancestorPaths) ? response.facets.ancestorPaths.buckets : undefined;
        const fileCount = matchedCount(response);
        const seen = new Set<string>();
        // The prefix and its ancestors count every matched file; no folder counts more.
        if (fileCount === undefined || !Array.isArray(buckets) || buckets.length > treeBucketLimit || !buckets.every(bucket => {
            if (!isObject(bucket) || typeof bucket.value !== 'string' || !bucket.value.startsWith('/') || seen.has(bucket.value)
                || !Number.isSafeInteger(bucket.count) || (bucket.count as number) < 1 || (bucket.count as number) > fileCount) return false;
            seen.add(bucket.value);
            return true;
        })) throw new MemDriveError('INVALID_RESULT', 'Tree returned invalid folder counts.');
        const counted = buckets as { value: string; count: number }[];
        return {
            fileCount,
            // The query also counts the prefix itself and its ancestors; only descendants are folders of the tree.
            folders: counted.filter(bucket => bucket.value !== prefix && bucket.value.startsWith(prefix))
                .map(bucket => ({ path: bucket.value, fileCount: bucket.count }))
                .sort((a, b) => codePointOrder(a.path, b.path)),
            truncated: counted.length === treeBucketLimit,
        };
    };
}
