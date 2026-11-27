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

/**
 * Who made a change, as named by the host: at least one of a user and an agent.
 * The SDK stores the strings as given and never interprets them.
 */
export type FileActor = { user: string; agent?: string | undefined } | { user?: string | undefined; agent: string };

export interface FileListEntry {
    fileId: string;
    /** When the file was created; never changed afterwards. */
    createdAt: string;
    /** The actor that created the file, when the creating write named one. */
    createdBy?: FileActor | undefined;
    /** When the file's path, content or metadata last changed. */
    modifiedAt: string;
    /** The actor of the write that set `modifiedAt`; absent when that write named none. */
    modifiedBy?: FileActor | undefined;
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
 * One page of a path-ordered listing. Files and, with the `'/'` delimiter, folder
 * prefixes form one sequence in Unicode code point order of their paths (files
 * that share a path follow in fileId order); a folder takes the place of its
 * first file. A page holds the next `limit` entries of that sequence, counting
 * files and prefixes together, so only the last page is shorter. `next` is
 * present exactly when more entries follow. Each page reflects the view at the
 * time of that call: entries already returned are not repeated, but a file moved
 * meanwhile can appear again at its new path.
 */
export interface ListFilesResult {
    files: FileListEntry[];
    prefixes: string[];
    next?: FileCursorRequest | undefined;
}

/** Describe the folders under `prefix` (an absolute folder path ending in `/`, default `/`). */
export interface TreeRequest extends FileAtRequest {
    prefix?: string | undefined;
}

/** A folder below the tree's prefix and the number of files in it, including its subfolders. */
export interface TreeFolder {
    /** Absolute folder path ending in `/`. */
    path: string;
    fileCount: number;
}

/**
 * Folders below the prefix at any depth, in path order, without the prefix
 * itself or its ancestors. LambdaDB returns at most 100 folder buckets per call,
 * the most populated first, and the prefix and its ancestors use buckets too;
 * `truncated` is true when all of them were used, so less populated folders may
 * be missing. Below a very deep prefix the ancestors can use every bucket, and
 * `folders` is then empty with `truncated: true`.
 */
export interface TreeResult {
    /** Files under the prefix at any depth, counted exactly whatever `truncated` says. */
    fileCount: number;
    folders: TreeFolder[];
    truncated: boolean;
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

/** A listed fork or checkpoint with its native creation time (ISO 8601). */
export interface FileRefEntry<At extends ForkAt | CheckpointAt = ForkAt | CheckpointAt> extends FileRef<At> {
    createdAt: string;
}

/**
 * One page of forks or checkpoints in LambdaDB's name order. A page can hold
 * fewer than `limit` entries while `next` is present. The listing is complete
 * only when a page has no `next`.
 */
export interface ForkList {
    forks: FileRefEntry<ForkAt>[];
    next?: { cursor: string } | undefined;
}

/** One page of checkpoints in name order; see {@link ForkList}. */
export interface CheckpointList {
    checkpoints: FileRefEntry<CheckpointAt>[];
    next?: { cursor: string } | undefined;
}

/** Start a fork or checkpoint listing with an optional page size (1–100, default 100), or continue one with its cursor. */
export type ListFileRefsRequest = { limit?: number | undefined; cursor?: never } | { cursor: string; limit?: never };

/** Select a writable view (omission selects main) and attribute the whole write call. */
export interface WriteTargetRequest {
    at?: WritableAt | undefined;
    /** The actor recorded as `createdBy` of created files and `modifiedBy` of changed files. */
    by?: FileActor | undefined;
    /** Used instead of the current time for `createdAt` and `modifiedAt`. */
    time?: Date | undefined;
}

/** Make a write a checkpointed write: the call also creates `checkpoint-<name>` and makes it the branch's latest checkpoint. */
export interface CheckpointedWriteRequest {
    checkpoint: { name: string };
}

/** A plain write: no checkpoint is created. */
interface PlainWriteRequest {
    checkpoint?: undefined;
}

/** The ordinary write result plus the checkpoint that now holds it. */
export interface CheckpointedWriteResult<Result> {
    result: Result;
    checkpoint: FileRef<CheckpointAt>;
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

/** Select the branch whose latest checkpoint `describe` reports; omission selects main. */
export interface DescribeRequest {
    at?: WritableAt | undefined;
}

/** The store's configuration and the selected branch's latest checkpoint, or null when it has none. */
export type FileDriveDescription<Mode extends EmbeddingMode = 'managed'> = FileStoreDescription<Mode> & {
    latestCheckpoint: FileRef<CheckpointAt> | null;
};

/**
 * One store object. Each request selects its view with `at`; omission selects main.
 * State-changing calls on one branch run one at a time within this process (see
 * README "Concurrent calls"); ordering across processes and SDK copies belongs to
 * the caller.
 */
export interface FileDrive<Mode extends EmbeddingMode = 'managed'> {
    readonly name: string;
    describe(request?: DescribeRequest, options?: RequestOptions): Promise<FileDriveDescription<Mode>>;
    tree(request?: TreeRequest, options?: RequestOptions): Promise<TreeResult>;
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
    write(request: WriteTargetRequest & FileMutation<Mode> & CheckpointedWriteRequest, options?: RequestOptions): Promise<CheckpointedWriteResult<ViewFile<Mode>>>;
    write(request: WriteTargetRequest & DeleteFileRequest & CheckpointedWriteRequest, options?: RequestOptions): Promise<CheckpointedWriteResult<DeleteFileResult>>;
    write(request: WriteTargetRequest & WriteFileOperation<Mode> & CheckpointedWriteRequest, options?: RequestOptions): Promise<CheckpointedWriteResult<ViewFile<Mode> | DeleteFileResult>>;
    write(request: WriteFilesRequest<FileMutation<Mode>> & CheckpointedWriteRequest, options?: RequestOptions): Promise<CheckpointedWriteResult<ViewFile<Mode>[]>>;
    write(request: WriteFilesRequest<WriteFileOperation<Mode>> & CheckpointedWriteRequest, options?: RequestOptions): Promise<CheckpointedWriteResult<(ViewFile<Mode> | DeleteFileResult)[]>>;
    write(request: WriteTargetRequest & FileMutation<Mode> & PlainWriteRequest, options?: RequestOptions): Promise<ViewFile<Mode>>;
    write(request: WriteTargetRequest & DeleteFileRequest & PlainWriteRequest, options?: RequestOptions): Promise<DeleteFileResult>;
    write(request: WriteTargetRequest & WriteFileOperation<Mode> & PlainWriteRequest, options?: RequestOptions): Promise<ViewFile<Mode> | DeleteFileResult>;
    write(request: WriteFilesRequest<FileMutation<Mode>> & PlainWriteRequest, options?: RequestOptions): Promise<ViewFile<Mode>[]>;
    write(request: WriteFilesRequest<WriteFileOperation<Mode>> & PlainWriteRequest, options?: RequestOptions): Promise<(ViewFile<Mode> | DeleteFileResult)[]>;
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
