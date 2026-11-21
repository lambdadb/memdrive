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

export type OpenFileStoreOptions = ConnectionOptions & (
    { at?: undefined; recover?: boolean | undefined }
    | { at: ForkSelection | CheckpointSelection; recover?: never }
);

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

interface FileView {
    readonly name: string;
    fork(request: { name: string }, options?: RequestOptions): Promise<WorkingFileDrive>;
    checkpoint(request: { name: string }, options?: RequestOptions): Promise<CheckpointFileDrive>;
    list(request?: ListFilesRequest, options?: RequestOptions): Promise<ListFilesResult>;
    describe(options?: RequestOptions): Promise<FileStoreDescription>;
    search(request: SearchFilesRequest, options?: RequestOptions): Promise<SearchFilesResult>;
    read(request: ReadFileRequest, options?: RequestOptions): Promise<DriveFile | null>;
    read(request: { paths: string[] }, options?: RequestOptions): Promise<DriveFile[]>;
}

export interface MainFileDrive extends FileView {
    readonly at: { readonly kind: 'main' };
}

export interface CheckpointFileDrive extends FileView {
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

export interface WorkingFileDrive extends FileView {
    readonly at: { readonly kind: 'fork'; readonly name: string };
    merge(request: MergeRequest, options?: RequestOptions): Promise<MergeResult>;
    diff(options?: RequestOptions): Promise<FileChange[]>;
    write(request: CreateFileRequest | UpdateFileRequest, options?: RequestOptions): Promise<DriveFile>;
    write(request: DeleteFileRequest, options?: RequestOptions): Promise<DeleteFileResult>;
    write(request: WriteFileRequest, options?: RequestOptions): Promise<WriteFileResult>;
    write(request: (CreateFileRequest | UpdateFileRequest)[], options?: RequestOptions): Promise<DriveFile[]>;
    write(request: WriteFileRequest[], options?: RequestOptions): Promise<WriteFileResult[]>;
}

export type FileDrive = MainFileDrive | WorkingFileDrive | CheckpointFileDrive;

export type MetadataType = 'string' | 'number' | 'boolean' | 'datetime';
export type Metadata = Record<string, string | number | boolean>;
export type MetadataSchema = Record<string, { type: MetadataType; description?: string | undefined }>;

export interface CreateFileStoreOptions extends ConnectionOptions {
    labels?: Record<string, string> | undefined;
    metadataSchema?: MetadataSchema | undefined;
    textSearch?: { analyzers: string[] } | undefined;
}

export interface FileStoreDescription {
    name: string;
    labels: Record<string, string>;
    metadataSchema: MetadataSchema;
    textSearch: { analyzers: string[] };
    embedding: {
        mode: 'managed';
        provider: 'openai';
        model: 'text-embedding-3-small';
        dimensions: 1536;
        similarity: 'cosine';
    };
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
