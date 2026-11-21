import type { LambdaDBClient } from '@functional-systems/lambdadb';

export interface ConnectionOptions {
    client: LambdaDBClient;
    name: string;
}

export interface RequestOptions {
    signal?: AbortSignal | undefined;
}

export interface OpenFileStoreOptions extends ConnectionOptions {
    at?: { fork: string } | undefined;
}

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

interface FileView {
    readonly name: string;
    list(request?: ListFilesRequest, options?: RequestOptions): Promise<ListFilesResult>;
    describe(options?: RequestOptions): Promise<FileStoreDescription>;
    search(request: SearchFilesRequest, options?: RequestOptions): Promise<SearchFilesResult>;
    read(request: ReadFileRequest, options?: RequestOptions): Promise<DriveFile | null>;
    read(request: { paths: string[] }, options?: RequestOptions): Promise<DriveFile[]>;
}

export interface MainFileDrive extends FileView {
    readonly at: { readonly kind: 'main' };
    fork(request: { name: string }, options?: RequestOptions): Promise<WorkingFileDrive>;
}

export interface WorkingFileDrive extends FileView {
    readonly at: { readonly kind: 'fork'; readonly name: string };
    write(request: CreateFileRequest, options?: RequestOptions): Promise<DriveFile>;
    write(request: CreateFileRequest[], options?: RequestOptions): Promise<DriveFile[]>;
}

export type FileDrive = MainFileDrive | WorkingFileDrive;

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
