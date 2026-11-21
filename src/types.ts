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

export interface DriveFile {
    fileId: string;
    path: string;
    content: string;
}

export type ReadFileRequest = { fileId: string; path?: never } | { path: string; fileId?: never };
export interface CreateFileRequest {
    op: 'create';
    path: string;
    content: string;
}

interface FileView {
    readonly name: string;
    read(request: ReadFileRequest, options?: RequestOptions): Promise<DriveFile | null>;
}

export interface MainFileDrive extends FileView {
    readonly at: { readonly kind: 'main' };
    fork(request: { name: string }, options?: RequestOptions): Promise<WorkingFileDrive>;
}

export interface WorkingFileDrive extends FileView {
    readonly at: { readonly kind: 'fork'; readonly name: string };
    write(request: CreateFileRequest, options?: RequestOptions): Promise<DriveFile>;
}

export type FileDrive = MainFileDrive | WorkingFileDrive;
