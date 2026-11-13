// Application-facing memory storage and retrieval. No answer assembly lives here.
import type { Backend, DataBackend, Evidence, VectorEvidence } from './storage.js';
import type {
    CreateOptions, OpenOptions, RequestOptions, RecallRequest, TextRecallRequest, RecallResult,
    BatchRecallResult, MetadataSchema, EmbeddingConfig, TextSearch, Usage, Observation, RecordEvent,
    MemInput, ForgetRequest, ConfigureRequest, BranchRequest, CatalogRequest, CatalogResult,
    ListRequest, MemDrive, DriveData, CountValuesRequest,
} from './types.js';
import { createBackend, openBackend, listBackends, validateChunk, publicMatch, validateVector, vectorMatch } from './storage.js';
import { buildSearchFilter, validateFilter, matchesFilter } from './filter.js';
import { MemDriveError, requireInput, operationOptions, checkAbort, abortError } from './errors.js';
import { createValueCounter } from './values.js';

export type * from './types.js';
export { MemDriveError } from './errors.js';

type Options = (CreateOptions | OpenOptions) & { branch?: string | undefined; embedding?: CreateOptions['embedding']; textSearch?: TextSearch | undefined };
type Queue = <T>(operation: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
type QueryBody = Parameters<DataBackend['query']>[0];
type NativeResponse = Awaited<ReturnType<DataBackend['query']>>;
type NormalizedResponse = Omit<NativeResponse, 'docs'> & { docs: Array<Omit<NativeResponse['docs'][number], 'doc'> & { doc: Evidence | VectorEvidence }> };
type ValidRecall = RecallRequest & { limit: number };
type PreparedRecall = { input: unknown; start: number; error?: never } | { error: MemDriveError; input?: never; start?: never };

const keys = (value: unknown, allowed: string[]): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => allowed.includes(key));
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

function validateOptions<T extends Options>(options: T, creating: boolean): T {
    requireInput(keys(options, ['client', 'name', 'maxConcurrentRequests', 'observe', 'record',
        ...(creating ? ['metadataSchema', 'textSearch', 'embedding', 'labels', 'description'] : ['branch'])]), 'Use the documented MemDrive options.');
    requireInput(creating || options.branch === undefined || (typeof options.branch === 'string'
        && /^[A-Za-z0-9_-]{3,52}$/.test(options.branch)), 'branch must be a valid branch name.');
    if (creating && options.embedding?.mode === 'external')
        requireInput(options.textSearch === undefined, 'External embeddings do not support textSearch.');
    const concurrency = options.maxConcurrentRequests ?? 5;
    requireInput(Number.isSafeInteger(concurrency) && concurrency > 0, 'maxConcurrentRequests must be a positive integer.');
    for (const name of ['observe', 'record'] as const)
        requireInput(options[name] === undefined || typeof options[name] === 'function', `${name} must be a callback.`);
    return { ...options };
}

// Separate queues bound logical recalls and database work across all branch views.
function requestQueue(limit: number): Queue {
    let active = 0;
    const waiting: Array<{ start(): void }> = [];
    return <T>(operation: () => Promise<T>, signal?: AbortSignal) => new Promise<T>((resolve, reject) => {
        try { checkAbort(signal); } catch (error) { reject(error); return; }
        const entry = { start() {
            signal?.removeEventListener('abort', cancel);
            active++;
            Promise.resolve().then(() => { checkAbort(signal); return operation(); }).then(resolve, reject).finally(() => {
                active--;
                waiting.shift()?.start();
            });
        } };
        const cancel = () => {
            const index = waiting.indexOf(entry);
            if (index < 0) return;
            waiting.splice(index, 1);
            signal?.removeEventListener('abort', cancel);
            reject(abortError(undefined, signal));
        };
        if (active < limit) entry.start();
        else {
            waiting.push(entry);
            signal?.addEventListener('abort', cancel, { once: true });
            if (signal?.aborted) cancel();
        }
    });
}

function recallInput(request: unknown, schema: MetadataSchema, embedding: EmbeddingConfig): ValidRecall {
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

function recallQuery(request: ValidRecall, schema: MetadataSchema, textSearch: TextSearch | undefined, embedding: EmbeddingConfig): QueryBody {
    if (embedding.mode === 'external') return { size: request.limit, query: { knn: {
        field: 'embedding', queryVector: request.queryVector, k: request.limit,
        filter: buildSearchFilter([request.filter], request.excludeIds ?? [], [], schema),
    } } };
    const context = contextualQuery(request as TextRecallRequest);
    // Native text-query input bound, not a silent SDK context truncation policy.
    requireInput(new TextEncoder().encode(request.query).length <= 8192 && new TextEncoder().encode(context).length <= 8192,
        'The contextual search query exceeds the native 8 KiB limit.');
    const filter = buildSearchFilter([request.filter], request.excludeIds ?? [], [], schema);
    const candidates = Math.max(200, request.limit);
    const semantic = { knn: { field: 'embedding', queryText: context, k: candidates, filter } };
    const query = textSearch ? { bayesian: [semantic,
        { bool: [{ ...filter, occur: 'filter' },
            { queryString: { query: request.query, defaultField: 'content', skipSyntax: true }, occur: 'must' }] },
    ] } : semantic;
    return { size: request.limit, query, ...(request.rerank === false ? (textSearch ? { candidateSize: candidates } : {}) : {
        rerank: { provider: 'typesafe', model: 'jev-1.13.0', queryText: context,
            fields: ['content'], candidateSize: candidates, onFailure: 'error' },
    }) };
}

async function validatedHits(response: NativeResponse, request: ValidRecall, schema: MetadataSchema, name: string, max: number, embedding: EmbeddingConfig): Promise<Array<Evidence | VectorEvidence>> {
    if (response?.isDocsInline === false || !Array.isArray(response?.docs) || response.docs.length > max)
        throw new MemDriveError('INVALID_RESULT', 'Search returned an invalid document envelope.');
    const seen = new Set<string>();
    return Promise.all(response.docs.map(async hit => {
        if (hit.collection !== undefined && hit.collection !== name)
            throw new MemDriveError('INVALID_RESULT', 'Search returned a different collection.');
        let mem;
        try { mem = await (embedding.mode === 'external' ? vectorMatch(hit.doc, schema) : validateChunk(hit.doc, schema)); }
        catch (cause) { throw new MemDriveError('INVALID_RESULT', 'Search returned invalid Mem evidence.', { cause }); }
        if (seen.has(mem.id) || request.excludeIds?.includes(mem.memId) || !matchesFilter({ ...mem, id: mem.memId }, request.filter, schema))
            throw new MemDriveError('INVALID_RESULT', 'Search returned duplicate, excluded or filtered-out evidence.');
        seen.add(mem.id);
        return mem;
    }));
}

function verifyRerank(response: NormalizedResponse, body: QueryBody) {
    const result = response.rerank;
    const same = result?.provider === body.rerank!.provider && result?.model === body.rerank!.model;
    const applied = result?.status === 'applied' && Number.isSafeInteger(result.candidateCount)
        && result.scoredCount === result.candidateCount && result.candidateCount !== undefined && result.candidateCount >= response.docs.length
        && result.candidateCount <= body.rerank!.candidateSize!
        && response.docs.every(hit => typeof hit.score === 'number' && Number.isFinite(hit.score) && hit.score >= 0 && hit.score <= 1);
    const empty = result?.status === 'skipped' && result.reason === 'noCandidates'
        && result.candidateCount === 0 && result.scoredCount === 0 && response.docs.length === 0;
    if (!same || (!applied && !empty)) throw new MemDriveError('RERANK_FAILED', 'Native reranking was not confirmed.');
}

function makeDataHandle(backend: DataBackend, options: Options, queue: Queue, recallQueue: Queue): DriveData {
    const counter = createValueCounter({ describe: options => backend.describe(options), query: (body, options) => backend.query(body, options),
        metadataSchema: () => backend.metadataSchema });
    let generation = backend.generation;
    const invalidate = () => { generation = backend.generation; counter.invalidate(); };
    const inspect = async <T>(operation: () => Promise<T>): Promise<T> => {
        backend.assertActive();
        if (generation !== backend.generation) invalidate();
        try { const result = await operation(); backend.assertActive(); return result; }
        finally { if (generation !== backend.generation) invalidate(); }
    };
    const mutation = async <T>(operation: () => Promise<T>): Promise<T> => {
        try { return await operation(); }
        finally { invalidate(); }
    };
    const executeRecall = async (input: unknown, start: number, requestIndex?: number, signal?: AbortSignal): Promise<RecallResult> => {
        const usage: Usage = { elapsedMs: 0, databaseRequests: 0 };
        const hook = <T extends Observation | RecordEvent>(callback?: ((event: T) => void | Promise<void>)) => async (event: T) => {
            checkAbort(signal);
            await callback?.(requestIndex === undefined ? event : { ...event, requestIndex });
            checkAbort(signal);
        };
        const record = hook(options.record);
        const observe = hook(options.observe);
        const executeDb = <T>(operation: (options?: RequestOptions) => Promise<T>): Promise<T> => queue(async () => {
            backend.assertActive(); checkAbort(signal);
            usage.databaseRequests++;
            try { const result = await operation({ signal }); checkAbort(signal); return result; }
            catch (cause) {
                const failure = abortError(cause, signal);
                if (failure instanceof MemDriveError) throw failure;
                const error = new MemDriveError('DATABASE_ERROR', 'MemDrive database request failed.', { cause: failure });
                const remote = failure as { statusCode?: number; status?: number };
                error.status = remote.statusCode ?? remote.status;
                throw error;
            }
        }, signal);
        try {
            checkAbort(signal);
            backend.assertActive();
            if (generation !== backend.generation) invalidate();
            const schema = () => backend.metadataSchema;
            const request = recallInput(input, schema(), backend.embedding);
            requireInput(request.rerank !== true || backend.embedding.mode === 'managed',
                'rerank: true requires managed embeddings.');
            const query = async (body: QueryBody): Promise<NormalizedResponse> => {
                const response = await executeDb(options => backend.query(body, options));
                const mems = await validatedHits(response, request, schema(), options.name, body.size ?? 10, backend.embedding);
                return { ...response, docs: response.docs.map((hit, i) => ({ ...hit, doc: mems[i]! })) };
            };
            const body = recallQuery(request, schema(), backend.textSearch, backend.embedding);
            await record({ phase: 'query', request: structuredClone(body) });
            const response = await query(body);
            if (body.rerank) verifyRerank(response, body);
            const mems = response.docs.map(hit => hit.doc);
            await record({ phase: 'query_result', response: structuredClone(response) });
            await observe({ type: 'retrieved', ids: mems.map(mem => mem.id), matches: mems.map(publicMatch) });
            backend.assertActive(); checkAbort(signal);
            usage.elapsedMs = performance.now() - start;
            return { matches: mems.map(publicMatch), usage };
        } catch (cause) {
            const failure = abortError(cause, signal);
            usage.elapsedMs = performance.now() - start;
            const error = failure instanceof MemDriveError ? failure
                : new MemDriveError('RECALL_FAILED', 'MemDrive retrieval failed.', { cause: failure });
            error.usage = structuredClone(usage);
            throw error;
        }
    };
    const snapshot = (input: unknown): PreparedRecall => {
        const start = performance.now();
        try { return { input: structuredClone(input), start }; }
        catch (cause) {
            const error = new MemDriveError('INVALID_INPUT', 'Recall input must be cloneable data.', { cause });
            error.usage = { elapsedMs: 0, databaseRequests: 0 };
            return { error };
        }
    };
    const submit = async (prepared: PreparedRecall, requestIndex?: number, signal?: AbortSignal): Promise<RecallResult> => {
        if (prepared.error) throw prepared.error;
        try { return await recallQueue(() => executeRecall(prepared.input, prepared.start, requestIndex, signal), signal); }
        catch (cause) {
            // Queue cancellation and executeRecall both reject with MemDriveError.
            const error = cause as MemDriveError;
            error.usage ??= { elapsedMs: performance.now() - prepared.start, databaseRequests: 0 };
            throw error;
        }
    };
    async function recall(input: RecallRequest, options?: RequestOptions): Promise<RecallResult>;
    async function recall(input: { requests: RecallRequest[] }, options?: RequestOptions): Promise<BatchRecallResult>;
    async function recall(input: unknown, options?: RequestOptions): Promise<RecallResult | BatchRecallResult> {
            const { signal } = operationOptions(options);
            if (input !== null && typeof input === 'object' && Object.hasOwn(input, 'requests')) {
                requireInput(keys(input, ['requests']) && Array.isArray(input.requests) && input.requests.length > 0,
                    'Batch recall requires only a nonempty requests array.');
                // Snapshot every item before any operation can yield or mutate caller data.
                const prepared = Array.from(input.requests, snapshot);
                const results = await Promise.all(prepared.map(async (item, requestIndex) => {
                    try { return await submit(item, requestIndex, signal); }
                    catch (cause) {
                        const error = cause as MemDriveError;
                        return { error: { code: error.code, message: error.message,
                            ...(Number.isInteger(error.status) ? { status: error.status! } : {}) },
                        usage: structuredClone(error.usage!) };
                    }
                }));
                return { results };
            }
            return submit(snapshot(input), undefined, signal);

    }
    return Object.freeze({
        remember: (request: { mems: MemInput[] }, options?: RequestOptions) => mutation(() => backend.remember(request, options)),
        forget: (request: ForgetRequest, options?: RequestOptions) => mutation(() => backend.forget(request, options)),
        read: (request: { ids: string[] }, options?: RequestOptions) => backend.read(request, undefined, options),
        list: (request?: ListRequest, options?: RequestOptions) => backend.list(request, options),
        embedding: Object.freeze(structuredClone(backend.embedding)),
        recall,
        async countValues(request: CountValuesRequest, options?: RequestOptions) {
            const { signal } = operationOptions(options);
            checkAbort(signal);
            return inspect(() => counter.countValues(request, operation => queue(async () => {
                backend.assertActive(); checkAbort(signal);
                const result = await operation({ signal });
                backend.assertActive(); checkAbort(signal);
                return result;
            }, signal), signal));
        },
    });
}

function makeDrive(backend: Backend, options: Options): MemDrive {
    const concurrency = options.maxConcurrentRequests ?? 5;
    const queue = requestQueue(concurrency), recallQueue = requestQueue(concurrency);
    const at = (ref: { branch: string }) => {
        requireInput(keys(ref, ['branch']) && Object.hasOwn(ref, 'branch'), 'Select a branch with { branch }.');
        return makeDataHandle(backend.at(ref.branch), options, queue, recallQueue);
    };
    return Object.freeze({
        ...at({ branch: options.branch ?? 'main' }),
        at,
        branches: Object.freeze({
            create: (request: BranchRequest, options?: RequestOptions) => backend.branches.create(request, options),
            list: (options?: RequestOptions) => backend.branches.list(options),
            delete: (name: string, options?: RequestOptions) => backend.branches.delete(name, options),
        }),
        configure: (request: ConfigureRequest, options?: RequestOptions) => backend.configure(request, options),
        destroy: (options?: RequestOptions) => backend.destroy(options),
        describe: (options?: RequestOptions) => backend.describeDescriptor(options),
    });
}

export async function create(options: CreateOptions, requestOptions?: RequestOptions): Promise<MemDrive> {
    requestOptions = operationOptions(requestOptions); checkAbort(requestOptions.signal);
    options = validateOptions(options, true);
    const backend = await createBackend({ client: options.client, name: options.name, metadataSchema: options.metadataSchema, textSearch: options.textSearch, embedding: options.embedding, labels: options.labels,
        description: options.description }, requestOptions);
    return makeDrive(backend, options);
}

export async function open(options: OpenOptions, requestOptions?: RequestOptions): Promise<MemDrive> {
    requestOptions = operationOptions(requestOptions); checkAbort(requestOptions.signal);
    options = validateOptions(options, false);
    const backend = await openBackend({ client: options.client, name: options.name }, requestOptions);
    if (options.branch !== undefined && options.branch !== 'main'
        && !(await backend.branches.list(requestOptions)).some(branch => branch.name === options.branch))
        throw new MemDriveError('BRANCH_NOT_FOUND', 'The selected MemDrive branch does not exist.');
    return makeDrive(backend, options);
}

export const list = (request: CatalogRequest, options?: RequestOptions): Promise<CatalogResult> => listBackends(request, options);
