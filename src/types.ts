import type { LambdaDBClient } from '@functional-systems/lambdadb';

export interface ConnectionOptions {
    client: LambdaDBClient;
    name: string;
}

export interface RequestOptions {
    signal?: AbortSignal | undefined;
}

export type ForkSelection = { fork: string; checkpoint?: never };
export type CheckpointSelection = { checkpoint: string; fork?: never };

export type EmbeddingMode = 'managed' | 'external';

export type OpenFileStoreOptions<Mode extends EmbeddingMode = 'managed'> = ConnectionOptions & ModeOption<Mode> & (
    { at?: undefined; recover?: boolean | undefined }
    | { at: ForkSelection | CheckpointSelection; recover?: never }
);

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
    embedding: readonly number[];
    metadata?: Metadata | undefined;
    content?: never;
}

export interface UpdateExternalFileRequest {
    op: 'update';
    fileId: string;
    newPath?: string | undefined;
    metadata?: Metadata | undefined;
    embedding?: readonly number[] | undefined;
    content?: never;
    edits?: never;
}

type FileMutation<Mode extends EmbeddingMode> = Mode extends 'external'
    ? CreateExternalFileRequest | UpdateExternalFileRequest
    : CreateFileRequest | UpdateFileRequest;
type ViewFile<Mode extends EmbeddingMode> = Mode extends 'external' ? FileListEntry : DriveFile;
type ViewSearch<Mode extends EmbeddingMode> = Mode extends 'external' ? SearchExternalFilesRequest : SearchFilesRequest;
type ViewSearchResult<Mode extends EmbeddingMode> = Mode extends 'external' ? SearchExternalFilesResult : SearchFilesResult;

interface FileView<Mode extends EmbeddingMode> {
    readonly name: string;
    fork(request: { name: string }, options?: RequestOptions): Promise<WorkingFileDrive<Mode>>;
    checkpoint(request: { name: string }, options?: RequestOptions): Promise<CheckpointFileDrive<Mode>>;
    list(request?: ListFilesRequest, options?: RequestOptions): Promise<ListFilesResult>;
    describe(options?: RequestOptions): Promise<FileStoreDescription<Mode>>;
    search(request: ViewSearch<Mode>, options?: RequestOptions): Promise<ViewSearchResult<Mode>>;
    read(request: ReadFileRequest, options?: RequestOptions): Promise<ViewFile<Mode> | null>;
    read(request: { paths: string[] }, options?: RequestOptions): Promise<ViewFile<Mode>[]>;
}

export interface MainFileDrive<Mode extends EmbeddingMode = 'managed'> extends FileView<Mode> {
    readonly at: { readonly kind: 'main' };
}

export interface CheckpointFileDrive<Mode extends EmbeddingMode = 'managed'> extends FileView<Mode> {
    readonly at: { readonly kind: 'checkpoint'; readonly name: string };
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

export interface WorkingFileDrive<Mode extends EmbeddingMode = 'managed'> extends FileView<Mode> {
    readonly at: { readonly kind: 'fork'; readonly name: string };
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
};

export type CreateFileStoreOptions = StoreOptions & {
    embedding?: { mode: 'managed' } | undefined;
    textSearch?: { analyzers: string[] } | undefined;
};

export type CreateExternalFileStoreOptions = StoreOptions & {
    embedding: ExternalEmbedding;
    textSearch?: never;
};

interface StoreDescription {
    name: string;
    labels: Record<string, string>;
    metadataSchema: MetadataSchema;
}

export type FileStoreDescription<Mode extends EmbeddingMode = 'managed'> = StoreDescription & (
    Mode extends 'external' ? { embedding: ExternalEmbedding; textSearch?: never } : {
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

export interface SearchExternalFilesRequest {
    queryVector: readonly number[];
    limit?: number | undefined;
    filter?: FileFilter | undefined;
}

export interface SearchExternalFilesResult {
    hits: FileListEntry[];
    reranked: false;
}

export interface SearchFilesRequest {
    query: string;
    embeddingQuery?: string | undefined;
    limit?: number | undefined;
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
