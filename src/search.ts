import { MemDriveError, requireInput } from './errors.js';
import { keysOnly } from './config.js';
import type { ConnectionOptions, MetadataSchema, SearchFilesRequest } from './types.js';

type NativeQuery = ReturnType<ConnectionOptions['client']['collection']>['query'];
type QueryCollectionInput = Parameters<NativeQuery>[0];
type QueryCollectionResponse = Awaited<ReturnType<NativeQuery>>;

const encoder = new TextEncoder();
const reranker = { provider: 'typesafe', model: 'jev-1.13.0' } as const;
const usableQuery = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
    && !/\p{Surrogate}/u.test(value) && encoder.encode(value).length <= 8192;

export function searchQuery(request: SearchFilesRequest, schema: MetadataSchema): QueryCollectionInput {
    requireInput(keysOnly(request, ['query', 'embeddingQuery', 'limit', 'rerank']) && usableQuery(request.query),
        'Search requires a nonblank query of at most 8192 UTF-8 bytes.');
    const { query, embeddingQuery = query, limit = 10, rerank = true } = request;
    requireInput(usableQuery(embeddingQuery), 'Embedding query must be nonblank text of at most 8192 UTF-8 bytes.');
    requireInput(Number.isSafeInteger(limit) && limit >= 1 && limit <= 1000, 'Search limit must be 1–1000.');
    requireInput(typeof rerank === 'boolean' || keysOnly(rerank, ['fields', 'onFailure']), 'Invalid reranking options.');
    const fields = typeof rerank === 'boolean' ? ['content'] : rerank.fields === undefined ? ['content'] : rerank.fields;
    const onFailure = typeof rerank === 'boolean' ? 'error' : rerank.onFailure === undefined ? 'error' : rerank.onFailure;
    requireInput(Array.isArray(fields) && fields.length >= 1 && fields.length <= 8 && new Set(fields).size === fields.length
        && [...fields].every(field => field === 'content' || (typeof field === 'string' && field.startsWith('metadata.')
            && Object.hasOwn(schema, field.slice(9)) && schema[field.slice(9)]?.type === 'string')),
    'Reranking fields must be distinct content or declared string metadata paths.');
    requireInput(onFailure === 'error' || onFailure === 'returnOriginal', 'Invalid reranking failure policy.');
    const candidates = Math.max(200, limit);
    const filter = { queryString: { query: '"chunk"', defaultField: 'kind' } };
    return {
        size: limit,
        query: { bayesian: [
            { knn: { field: 'embedding', queryText: embeddingQuery, k: candidates, filter } },
            { bool: [
                { ...filter, occur: 'filter' },
                { queryString: { query, defaultField: 'content', skipSyntax: true }, occur: 'must' },
            ] },
        ] },
        ...(rerank === false ? { candidateSize: candidates }
            : { rerank: { ...reranker, queryText: embeddingQuery, fields: [...fields], candidateSize: candidates, onFailure } }),
    };
}

export function validateReranking(response: QueryCollectionResponse, body: QueryCollectionInput): boolean {
    if (!body.rerank) return false;
    const result = response.rerank;
    if (result?.provider !== reranker.provider || result.model !== reranker.model)
        throw new MemDriveError('RERANK_FAILED', 'Native reranking was not confirmed.');
    const validCount = Number.isSafeInteger(result.candidateCount) && result.candidateCount >= response.docs.length
        && result.candidateCount <= body.rerank.candidateSize!;
    if (result.status === 'applied' && validCount && result.candidateCount === result.scoredCount
        && response.docs.every(hit => typeof hit?.score === 'number' && Number.isFinite(hit.score) && hit.score >= 0 && hit.score <= 1)) return true;
    if (result.status === 'skipped' && result.reason === 'noCandidates' && result.candidateCount === 0
        && result.scoredCount === 0 && response.docs.length === 0) return false;
    if (body.rerank.onFailure === 'returnOriginal' && result.status === 'fallback' && validCount && result.scoredCount === 0) return false;
    throw new MemDriveError('RERANK_FAILED', 'Native reranking was not confirmed.');
}
