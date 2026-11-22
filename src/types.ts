import type { LambdaDBClient } from '@functional-systems/lambdadb';

export interface ConnectionOptions {
    client: LambdaDBClient;
    name: string;
}

export interface RequestOptions {
    signal?: AbortSignal | undefined;
}

export interface ChunkingOptions { strategy: 'auto' | 'boundary' | 'none' | 'docling' }
/** Runtime-local optional backend; native modules are never imported by the browser entry point. */
export interface DoclingChunker {
    readonly id: string;
    chunk(file: { path: string; content: string; format: string }, options?: RequestOptions): Promise<Array<{ text: string; contextualized: string }>>;
}

export type ForkSelection = { fork: string; checkpoint?: never };
export type CheckpointSelection = { checkpoint: string; fork?: never };

export type EmbeddingMode = 'managed' | 'external';

export type OpenFileStoreOptions<Mode extends EmbeddingMode = 'managed'> = ConnectionOptions & ModeOption<Mode> & (
    { at?: undefined; recover?: boolean | undefined }
    | { at: ForkSelection | CheckpointSelection; recover?: never }
) & { chunker?: DoclingChunker | undefined };

type ModeOption<Mode extends EmbeddingMode> = Mode extends 'external' ? { mode: 'external' } : { mode?: 'managed' | undefined };

export interface FileListEntry {
    fileId: string;
    modifiedAt: string;
    path: string;
    metadata?: Metadata | undefined;
}

export interface DriveFile extends FileListEntry {
    content: string;
}

export type ListFilesRequest = {
    prefix?: string | undefined;
    nameContains?: string | undefined;
    delimiter?: '/' | undefined;
    limit?: number | undefined;
    cursor?: never;
} | {
    cursor: string;
    prefix?: never;
    nameContains?: never;
    delimiter?: never;
    limit?: never;
};

export interface ListFilesResult {
    files: FileListEntry[];
    prefixes: string[];
    consistency: 'eventual';
    cursor?: string | undefined;
}

export type ReadFileRequest = { fileId: string; path?: never } | { path: string; fileId?: never };
export interface ReadFileRangeOptions {
    startLine?: number | undefined;
    endLine?: number | undefined;
    maxChars?: number | undefined;
    offset?: number | undefined;
    revision?: string | undefined;
}
export type ReadFileRangeRequest = ReadFileRequest & ReadFileRangeOptions & (
    { startLine: number } | { endLine: number } | { maxChars: number } | { offset: number; revision: string } | { revision: string }
);
export interface FileReadPage extends DriveFile {
    at: FileDrive['at'];
    /** Fingerprint of the original path, content and metadata, checked on continuation. */
    revision: string;
    /** Main publication last assigned to this original, when present. */
    version?: string | undefined;
    totalLines: number;
    /** One-based inclusive line numbers and half-open UTF-16 offsets in the original. */
    range: { startLine: number; endLine: number; start: number; end: number };
    next?: ReadFileRangeRequest | undefined;
}
export interface CreateFileRequest {
    op: 'create';
    path: string;
    content: string;
    metadata?: Metadata | undefined;
}

export interface TextEdit {
    oldText: string;
    newText: string;
}

export type UpdateFileRequest = {
    op: 'update';
    fileId: string;
    newPath?: string | undefined;
    metadata?: Metadata | undefined;
} & (
    { content?: string | undefined; edits?: never }
    | { content?: never; edits: TextEdit[] }
);

export interface DeleteFileRequest {
    op: 'delete';
    fileId: string;
}
export interface DeleteFileResult {
    fileId: string;
}
export type WriteFileRequest = CreateFileRequest | UpdateFileRequest | DeleteFileRequest;
export type WriteFileResult = DriveFile | DeleteFileResult;

export interface CreateExternalFileRequest {
    op: 'create';
    path: string;
    content: readonly number[];
    metadata?: Metadata | undefined;
}

export interface UpdateExternalFileRequest {
    op: 'update';
    fileId: string;
    newPath?: string | undefined;
    metadata?: Metadata | undefined;
    content?: readonly number[] | undefined;
    edits?: never;
}

type FileMutation<Mode extends EmbeddingMode> = Mode extends 'external'
    ? CreateExternalFileRequest | UpdateExternalFileRequest
    : CreateFileRequest | UpdateFileRequest;
type ViewFile<Mode extends EmbeddingMode> = Mode extends 'external' ? FileListEntry : DriveFile;
type ViewSearch<Mode extends EmbeddingMode> = Mode extends 'external' ? SearchExternalFilesRequest : SearchFilesRequest;
type ViewSearchResult<Mode extends EmbeddingMode> = Mode extends 'external' ? SearchExternalFilesResult : SearchFilesResult;

export interface FileRefEntry { name: string }

interface FileView<Mode extends EmbeddingMode> {
    readonly name: string;
    listForks(options?: RequestOptions): Promise<FileRefEntry[]>;
    listCheckpoints(options?: RequestOptions): Promise<FileRefEntry[]>;
    fork(request: { name: string }, options?: RequestOptions): Promise<WorkingFileDrive<Mode>>;
    checkpoint(request: { name: string }, options?: RequestOptions): Promise<CheckpointFileDrive<Mode>>;
    list(request?: ListFilesRequest, options?: RequestOptions): Promise<ListFilesResult>;
    describe(options?: RequestOptions): Promise<FileStoreDescription<Mode>>;
    status(options?: RequestOptions): Promise<FileStoreStatus>;
    history(request?: FileHistoryRequest, options?: RequestOptions): Promise<FileHistoryResult>;
    search(request: ViewSearch<Mode>, options?: RequestOptions): Promise<ViewSearchResult<Mode>>;
    readonly findText: Mode extends 'external' ? undefined
        : (request: FindTextRequest, options?: RequestOptions) => Promise<FindTextResult>;
    read(request: Mode extends 'external' ? never : ReadFileRangeRequest, options?: RequestOptions): Promise<FileReadPage | null>;
    read(request: ReadFileRequest, options?: RequestOptions): Promise<ViewFile<Mode> | null>;
    read(request: { paths: string[] }, options?: RequestOptions): Promise<ViewFile<Mode>[]>;
}

export interface MainFileDrive<Mode extends EmbeddingMode = 'managed'> extends FileView<Mode> {
    readonly at: { readonly kind: 'main' };
    configure(request: { retentionInDays: number }, options?: RequestOptions): Promise<FileStoreDescription<Mode>>;
}

export interface CheckpointFileDrive<Mode extends EmbeddingMode = 'managed'> extends FileView<Mode> {
    readonly at: { readonly kind: 'checkpoint'; readonly name: string };
    delete(options?: RequestOptions): Promise<void>;
}

export type FileChange =
    | { op: 'create'; fileId: string; path: string }
    | { op: 'update'; fileId: string; path: string; previousPath?: string | undefined }
    | { op: 'delete'; fileId: string; previousPath: string };

export interface MergeRequest {
    requestId: string;
    summary: string;
}

export interface MergeResult {
    requestId: string;
    status: 'published' | 'unchanged';
    version: string;
}

export interface FileStoreStatus {
    at: FileDrive['at'];
    mainVersion: string;
    /** An observed unfinished main merge. Its writer may still be running. */
    merge?: { requestId: string; phase: 'publication' | 'bookkeeping' } | undefined;
}

/** List store-wide main publications after a version, or continue a previous page. */
export type FileHistoryRequest = {
    sinceVersion?: string | undefined;
    limit?: number | undefined;
    cursor?: never;
} | {
    cursor: string;
    sinceVersion?: never;
    limit?: never;
};

export interface FileHistoryEntry {
    version: string;
    publishedAt: string;
    summary: string;
    fileIds: string[];
    fileIdsTruncated: boolean;
}

export interface FileHistoryResult {
    entries: FileHistoryEntry[];
    /** The latest published main version observed when the first page was requested. */
    throughVersion: string;
    cursor?: string | undefined;
}

export interface WorkingFileDrive<Mode extends EmbeddingMode = 'managed'> extends FileView<Mode> {
    readonly at: { readonly kind: 'fork'; readonly name: string };
    delete(options?: RequestOptions): Promise<void>;
    merge(request: MergeRequest, options?: RequestOptions): Promise<MergeResult>;
    diff(options?: RequestOptions): Promise<FileChange[]>;
    write(request: FileMutation<Mode>, options?: RequestOptions): Promise<ViewFile<Mode>>;
    write(request: DeleteFileRequest, options?: RequestOptions): Promise<DeleteFileResult>;
    write(request: FileMutation<Mode> | DeleteFileRequest, options?: RequestOptions): Promise<ViewFile<Mode> | DeleteFileResult>;
    write(request: FileMutation<Mode>[], options?: RequestOptions): Promise<ViewFile<Mode>[]>;
    write(request: (FileMutation<Mode> | DeleteFileRequest)[], options?: RequestOptions): Promise<(ViewFile<Mode> | DeleteFileResult)[]>;
}

export type FileDrive<Mode extends EmbeddingMode = 'managed'> =
    MainFileDrive<Mode> | WorkingFileDrive<Mode> | CheckpointFileDrive<Mode>;

export type MetadataType = 'string' | 'number' | 'boolean' | 'datetime';
export type Metadata = Record<string, string | number | boolean>;
export type MetadataSchema = Record<string, { type: MetadataType; description?: string | undefined }>;

export interface ExternalEmbedding {
    mode: 'external';
    dimensions: number;
    similarity: 'cosine';
    identity: string;
}

type StoreOptions = ConnectionOptions & {
    labels?: Record<string, string> | undefined;
    metadataSchema?: MetadataSchema | undefined;
    retentionInDays?: number | undefined;
};

export type CreateFileStoreOptions = StoreOptions & {
    embedding?: { mode: 'managed' } | undefined;
    textSearch?: { analyzers: string[] } | undefined;
    chunking?: ChunkingOptions | undefined;
    chunker?: DoclingChunker | undefined;
};

export type CreateExternalFileStoreOptions = StoreOptions & {
    embedding: ExternalEmbedding;
    textSearch?: never;
    chunking?: never;
    chunker?: never;
};

interface StoreDescription {
    name: string;
    labels: Record<string, string>;
    metadataSchema: MetadataSchema;
    /** Native snapshot retention. Pinned refs and SDK journal records have separate lifetimes. */
    retentionInDays?: number | undefined;
}

export type FileStoreDescription<Mode extends EmbeddingMode = 'managed'> = StoreDescription & (
    Mode extends 'external' ? { embedding: ExternalEmbedding; textSearch?: never } : {
        chunking?: ChunkingOptions | undefined;
        textSearch: { analyzers: string[] };
        embedding: {
            mode: 'managed';
            provider: 'openai';
            model: 'text-embedding-3-small';
            dimensions: 1536;
            similarity: 'cosine';
        };
    }
);

export type FileFilter =
    | { and: FileFilter[]; or?: never }
    | { or: FileFilter[]; and?: never }
    | { field: `metadata.${string}`; op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'; value: string | number | boolean }
    | { field: `metadata.${string}`; op: 'in'; value: (string | number | boolean)[] }
    | { field: `metadata.${string}`; op: 'exists'; value: boolean };

interface SearchOptions {
    limit?: number | undefined;
    filter?: FileFilter | undefined;
}

export interface SearchExternalFilesRequest extends SearchOptions {
    query: readonly number[];
}

export interface SearchExternalFilesResult {
    hits: FileListEntry[];
    reranked: false;
}

export interface SearchFilesRequest extends SearchOptions {
    query: string;
    embeddingQuery?: string | undefined;
    rerank?: boolean | {
        fields?: string[] | undefined;
        onFailure?: 'error' | 'returnOriginal' | undefined;
    } | undefined;
}

export interface FileSearchHit extends DriveFile {
    /** Verified UTF-16 offsets into the file's original text. */
    range?: { start: number; end: number } | undefined;
}
export interface SearchFilesResult {
    hits: FileSearchHit[];
    reranked: boolean;
}


export type FindTextRequest = {
    query: string;
    prefix?: string | undefined;
    filter?: FileFilter | undefined;
    limit?: number | undefined;
    cursor?: never;
} | {
    cursor: string;
    query?: never;
    prefix?: never;
    filter?: never;
    limit?: never;
};

export interface FileTextHit extends DriveFile {
    /** Verified half-open UTF-16 offsets into the file's original text. */
    range: { start: number; end: number };
    /** An original text excerpt containing the match, with its own UTF-16 offsets. */
    context: { content: string; range: { start: number; end: number } };
}

export interface FindTextResult {
    hits: FileTextHit[];
    consistency: 'snapshot' | 'live';
    /** Continue with this cursor even when the current page has no hits. */
    cursor?: string | undefined;
}
