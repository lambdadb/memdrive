import type { LambdaDBClient } from '@functional-systems/lambdadb';
export type MetadataType = 'string' | 'string[]' | 'number' | 'boolean' | 'datetime';
export type MetadataValue = string | string[] | number | boolean;
export type Metadata = Record<string, MetadataValue>;
export type MetadataSchema = Record<string, {
    type: MetadataType;
    description?: string | undefined;
}>;
export interface RequestOptions {
    signal?: AbortSignal | undefined;
}
export interface TextSearch {
    analyzers: string[];
}
export interface ManagedEmbedding {
    mode: 'managed';
    provider: 'openai';
    model: 'text-embedding-3-small';
    dimensions: 1536;
    similarity: 'cosine';
}
export interface ExternalEmbedding {
    mode: 'external';
    dimensions: number;
    similarity: 'cosine';
    identity: string;
}
export type EmbeddingOptions = {
    mode: 'managed';
} | ExternalEmbedding;
export type EmbeddingConfig = ManagedEmbedding | ExternalEmbedding;
export interface MemAttributes {
    timestamp?: string | undefined;
    metadata?: Metadata | undefined;
}
export interface TextMemInput extends MemAttributes {
    id?: string | undefined;
    content: string;
    embedding?: never;
}
export interface VectorMemInput extends MemAttributes {
    id?: string | undefined;
    embedding: number[];
    content?: never;
}
export type MemInput = TextMemInput | VectorMemInput;
export interface TextMem extends MemAttributes {
    id: string;
    content: string;
}
/** External-vector reads return source references and metadata, not vectors. */
export interface VectorMem extends MemAttributes {
    id: string;
    content?: never;
}
export type Mem = TextMem | VectorMem;
export interface TextMatch extends MemAttributes {
    kind: 'mem' | 'chunk';
    memId: string;
    content: string;
    start: number;
    end: number;
}
export interface VectorMatch extends MemAttributes {
    kind: 'mem';
    memId: string;
    content?: never;
    start?: never;
    end?: never;
}
export type Match = TextMatch | VectorMatch;
export type FilterScalar = string | number | boolean;
export type Filter = {
    and: Filter[];
    or?: never;
    field?: never;
    op?: never;
    value?: never;
} | {
    or: Filter[];
    and?: never;
    field?: never;
    op?: never;
    value?: never;
} | {
    field: string;
    op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte';
    value: FilterScalar;
    and?: never;
    or?: never;
} | {
    field: string;
    op: 'in';
    value: FilterScalar[];
    and?: never;
    or?: never;
} | {
    field: string;
    op: 'exists';
    value: boolean;
    and?: never;
    or?: never;
};
export interface RecallOptions {
    filter?: Filter | undefined;
    excludeIds?: string[] | undefined;
    limit?: number | undefined;
    rerank?: boolean | undefined;
}
export interface TextRecallRequest extends RecallOptions {
    query: string;
    queryVector?: never;
    context?: string | undefined;
    recentDialogue?: Array<{
        role: 'user' | 'assistant';
        content: string;
    }> | undefined;
}
export interface VectorRecallRequest extends Omit<RecallOptions, 'rerank'> {
    queryVector: number[];
    query?: never;
    rerank?: false | undefined;
    context?: never;
    recentDialogue?: never;
}
export type RecallRequest = TextRecallRequest | VectorRecallRequest;
export interface Usage {
    elapsedMs: number;
    databaseRequests: number;
}
export interface RecallResult {
    matches: Match[];
    usage: Usage;
}
export interface RecallFailure {
    error: {
        code: string;
        message: string;
        status?: number;
    };
    usage: Usage;
}
export interface BatchRecallResult {
    results: Array<RecallResult | RecallFailure>;
}
export interface Observation {
    type: 'retrieved';
    /** Diagnostic physical evidence IDs, not canonical memId values. */
    ids: string[];
    matches: Match[];
    requestIndex?: number | undefined;
}
export type RecordEvent = Record<string, unknown> & {
    phase: string;
    requestIndex?: number | undefined;
};
export interface RuntimeOptions {
    maxConcurrentRequests?: number | undefined;
    observe?: ((event: Observation) => void | Promise<void>) | undefined;
    record?: ((event: RecordEvent) => void | Promise<void>) | undefined;
}
export interface ConnectionOptions {
    client: LambdaDBClient;
    name: string;
}
export interface CreateOptions extends ConnectionOptions, RuntimeOptions {
    metadataSchema: MetadataSchema;
    textSearch?: TextSearch | undefined;
    embedding?: EmbeddingOptions | undefined;
    labels?: Record<string, string> | undefined;
    description?: string | undefined;
}
export interface OpenOptions extends ConnectionOptions, RuntimeOptions {
    branch?: string | undefined;
}
export interface DriveDescriptor {
    name: string;
    description?: string | undefined;
    labels: Record<string, string>;
    metadataSchema: MetadataSchema;
    embedding: EmbeddingConfig;
    textSearch?: TextSearch | undefined;
}
export interface CatalogRequest {
    client: LambdaDBClient;
    labels?: Record<string, string> | undefined;
    limit?: number | undefined;
    cursor?: string | undefined;
}
export interface CatalogResult {
    drives: DriveDescriptor[];
    nextCursor?: string | undefined;
}
export interface ListRequest {
    limit?: number | undefined;
    cursor?: string | undefined;
}
export interface ListResult {
    mems: Mem[];
    nextCursor?: string | undefined;
}
export type ForgetRequest = {
    ids: string[];
    filter?: never;
} | {
    filter: Filter;
    ids?: never;
};
export type ConfigureRequest = {
    metadataSchema: MetadataSchema;
    description?: string | undefined;
} | {
    description: string;
    metadataSchema?: MetadataSchema | undefined;
};
export interface BranchRequest {
    name: string;
    source?: {
        branch: string;
    } | undefined;
}
export type Branch = Awaited<ReturnType<ReturnType<LambdaDBClient['collection']>['branches']['create']>>['branch'];
/** Counts distinct keyword values across original memories, not chunks. */
export interface CountValuesRequest {
    /** One to five distinct keyword fields, matching the native facet limit. */
    fields: string[];
    filter?: Filter | undefined;
    excludeIds?: string[] | undefined;
    /** Values per field: defaults to 10, maximum 100. */
    limit?: number | undefined;
}
export interface CountValuesResult {
    values: Record<string, {
        buckets: Array<{ value: string; count: number }>;
        /** Null when the native bucket limit prevents determining completeness. */
        hasMore: boolean | null;
    }>;
    /** Time the cached result was fetched, in ISO 8601 UTC. */
    asOf: string;
}
export interface DriveData {
    readonly embedding: Readonly<EmbeddingConfig>;
    remember(request: {
        mems: MemInput[];
    }, options?: RequestOptions): Promise<{
        ids: string[];
    }>;
    read(request: {
        ids: string[];
    }, options?: RequestOptions): Promise<{
        mems: Mem[];
    }>;
    list(request?: ListRequest, options?: RequestOptions): Promise<ListResult>;
    countValues(request: CountValuesRequest, options?: RequestOptions): Promise<CountValuesResult>;
    forget(request: ForgetRequest, options?: RequestOptions): Promise<void>;
    recall(request: RecallRequest, options?: RequestOptions): Promise<RecallResult>;
    recall(request: {
        requests: RecallRequest[];
    }, options?: RequestOptions): Promise<BatchRecallResult>;
}
export interface MemDrive extends DriveData {
    at(reference: {
        branch: string;
    }): DriveData;
    readonly branches: {
        create(request: BranchRequest, options?: RequestOptions): Promise<Branch>;
        list(options?: RequestOptions): Promise<Branch[]>;
        delete(name: string, options?: RequestOptions): Promise<void>;
    };
    configure(request: ConfigureRequest, options?: RequestOptions): Promise<void>;
    describe(options?: RequestOptions): Promise<DriveDescriptor>;
    destroy(options?: RequestOptions): Promise<void>;
}
