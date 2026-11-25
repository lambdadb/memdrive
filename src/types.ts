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

/** The store's main branch. Omitting `at` selects it. */
export type MainAt = { kind: 'main' };
/** A named fork: a writable branch created from another view. */
export type ForkAt = { kind: 'fork'; name: string };
/** A named read-only checkpoint: a tag of a view at the time it was created. */
export type CheckpointAt = { kind: 'checkpoint'; name: string };
/** A writable view: main or a fork. */
export type WritableAt = MainAt | ForkAt;
/** One serializable view identity shared by requests, results and continuations. */
export type FileAt = MainAt | ForkAt | CheckpointAt;

/** Select a source view; omission selects main. */
export interface FileAtRequest {
    at?: FileAt | undefined;
}

export type EmbeddingMode = 'managed' | 'external';

export type OpenFileStoreOptions<Mode extends EmbeddingMode = 'managed'> = ConnectionOptions & ModeOption<Mode> & {
    chunker?: DoclingChunker | undefined;
};

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

export type ListFilesRequest = FileAtRequest & ({
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
});

/** Continue a list or findText scan on the view that issued the cursor. Forward it unchanged. */
export interface FileCursorRequest {
    at: FileAt;
    cursor: string;
}

/**
 * One native listing page in native order, not sorted by path. A page can hold
 * fewer than `limit` entries, or none, while `next` is present; common prefixes
 * are computed per page and can repeat on later pages. The listing is complete
 * only when a page has no `next`, and concurrent writes can be missed or seen twice.
 */
export interface ListFilesResult {
    files: FileListEntry[];
    prefixes: string[];
    consistency: 'eventual';
    next?: FileCursorRequest | undefined;
}

export type ReadFileRequest = FileAtRequest & ({ fileId: string; path?: never } | { path: string; fileId?: never });
export interface ReadFilesRequest extends FileAtRequest {
    paths: string[];
}
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
    at: FileAt;
    /** Fingerprint of the original path, content and metadata, checked on continuation. */
    revision: string;
    totalLines: number;
    /** One-based inclusive line numbers and half-open UTF-16 offsets in the original. */
    range: { startLine: number; endLine: number; start: number; end: number };
    /** Forward unchanged to continue on the same view. */
    next?: (ReadFileRangeRequest & { at: FileAt }) | undefined;
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

/** Create a named fork or checkpoint from a source view; omission selects main. */
export interface CreateFileRefRequest {
    at?: FileAt | undefined;
    name: string;
}

/** Serializable identity of an existing fork or checkpoint. */
export interface FileRef<At extends ForkAt | CheckpointAt = ForkAt | CheckpointAt> {
    at: At;
}

/** User forks sorted by name. */
export interface ForkList {
    forks: FileRef<ForkAt>[];
}

/** User checkpoints sorted by name. */
export interface CheckpointList {
    checkpoints: FileRef<CheckpointAt>[];
}

/** Fork and checkpoint listings take no options. */
export type ListFileRefsRequest = Record<string, never>;

/** Select a writable view; omission selects main. */
export interface WriteTargetRequest {
    at?: WritableAt | undefined;
}

export type WriteFileOperation<Mode extends EmbeddingMode = 'managed'> = FileMutation<Mode> | DeleteFileRequest;
export interface WriteFilesRequest<Operation> extends WriteTargetRequest {
    operations: Operation[];
}

/** Restore main or a fork to the contents of a checkpoint. */
export interface RollbackRequest {
    at: WritableAt;
    to: CheckpointAt;
}

export interface RollbackResult {
    at: WritableAt;
}

/**
 * One store object. Each request selects its view with `at`; omission selects main.
 * State-changing calls on one branch run one at a time within this process (see
 * README "Concurrent calls"); ordering across processes and SDK copies belongs to
 * the caller.
 */
export interface FileDrive<Mode extends EmbeddingMode = 'managed'> {
    readonly name: string;
    describe(options?: RequestOptions): Promise<FileStoreDescription<Mode>>;
    list(request?: ListFilesRequest, options?: RequestOptions): Promise<ListFilesResult>;
    read(request: Mode extends 'external' ? never : ReadFileRangeRequest, options?: RequestOptions): Promise<FileReadPage | null>;
    read(request: ReadFileRequest, options?: RequestOptions): Promise<ViewFile<Mode> | null>;
    read(request: ReadFilesRequest, options?: RequestOptions): Promise<ViewFile<Mode>[]>;
    search(request: ViewSearch<Mode>, options?: RequestOptions): Promise<ViewSearchResult<Mode>>;
    readonly findText: Mode extends 'external' ? undefined
        : (request: FindTextRequest, options?: RequestOptions) => Promise<FindTextResult>;
    fork(request: CreateFileRefRequest, options?: RequestOptions): Promise<FileRef<ForkAt>>;
    checkpoint(request: CreateFileRefRequest, options?: RequestOptions): Promise<FileRef<CheckpointAt>>;
    listForks(request?: ListFileRefsRequest, options?: RequestOptions): Promise<ForkList>;
    listCheckpoints(request?: ListFileRefsRequest, options?: RequestOptions): Promise<CheckpointList>;
    deleteFork(request: { at: ForkAt }, options?: RequestOptions): Promise<FileRef<ForkAt>>;
    deleteCheckpoint(request: { at: CheckpointAt }, options?: RequestOptions): Promise<FileRef<CheckpointAt>>;
    write(request: WriteTargetRequest & FileMutation<Mode>, options?: RequestOptions): Promise<ViewFile<Mode>>;
    write(request: WriteTargetRequest & DeleteFileRequest, options?: RequestOptions): Promise<DeleteFileResult>;
    write(request: WriteTargetRequest & WriteFileOperation<Mode>, options?: RequestOptions): Promise<ViewFile<Mode> | DeleteFileResult>;
    write(request: WriteFilesRequest<FileMutation<Mode>>, options?: RequestOptions): Promise<ViewFile<Mode>[]>;
    write(request: WriteFilesRequest<WriteFileOperation<Mode>>, options?: RequestOptions): Promise<(ViewFile<Mode> | DeleteFileResult)[]>;
    rollback(request: RollbackRequest, options?: RequestOptions): Promise<RollbackResult>;
}

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
}

export type FileStoreDescription<Mode extends EmbeddingMode = 'managed'> = StoreDescription & (
    Mode extends 'external' ? { embedding: ExternalEmbedding; textSearch?: never } : {
        chunking: ChunkingOptions;
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

interface SearchOptions extends FileAtRequest {
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
    /** Natural-language retrieval intent, or focused terms for keyword matching. */
    query: string;
    /** Candidate retrieval method. Defaults to semantic; never switches automatically. */
    mode?: 'semantic' | 'keyword' | 'hybrid' | undefined;
    /** Overrides embedding and enabled reranking input. Keyword mode requires reranking to use it. */
    embeddingQuery?: string | undefined;
    /** Independently rerank retrieved candidates in any mode. Defaults to false. */
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

export type FindTextRequest = FileAtRequest & ({
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
});

export interface FileTextHit extends DriveFile {
    /**
     * Verified half-open UTF-16 offsets into the file's original text, and the
     * one-based inclusive lines of its first and last units, numbered like ranged
     * `read`. Pass the lines to `read` to retrieve the lines containing the match.
     */
    range: { startLine: number; endLine: number; start: number; end: number };
    /** An original text excerpt containing the match, with its own UTF-16 offsets. */
    context: { content: string; range: { start: number; end: number } };
}

export interface FindTextResult {
    hits: FileTextHit[];
    consistency: 'snapshot' | 'live';
    /** Forward unchanged even when the current page has no hits. */
    next?: FileCursorRequest | undefined;
}
