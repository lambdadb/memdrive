import type { MemDrive, RequestOptions } from '../types.js';

/** Portable JSON Schema; transport adapters may rename the containing field. */
export type JsonSchema = Record<string, unknown>;
export type ToolName = 'memdrive_recall' | 'memdrive_read' | 'memdrive_describe'
    | 'memdrive_count_values' | 'memdrive_list' | 'memdrive_remember' | 'memdrive_forget';
export interface ToolAnnotations {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
}
export interface ToolDefinition {
    name: ToolName;
    title: string;
    description: string;
    inputSchema: JsonSchema;
    outputSchema: JsonSchema;
    annotations: ToolAnnotations;
}
export interface ToolError {
    code: string;
    message: string;
    status?: number;
    /** Accepted, uncertain and unattempted writes are never silently retried. */
    details?: {
        completedIds?: string[];
        uncertainIds?: string[];
        notAttemptedIds?: string[];
    };
}
/** Identical JSON data for direct function calls and MCP structured/text results. */
export type ToolResult = { ok: true; value: Record<string, unknown> } | { ok: false; error: ToolError };
/** Canonical source identity; external-vector references have no text offsets. */
export type EvidenceReference = { memId: string; start: number; end: number } | { memId: string };
export interface CreateToolsOptions {
    drive: MemDrive;
    /** Omit to use the supplied handle's branch. Model arguments cannot change it. */
    branch?: string;
    /** Include remember and forget. Defaults to false. This is not authorization. */
    writable?: boolean;
    /** Use stable session-local memory aliases. Read-only registries only; defaults to false. */
    shortIds?: boolean;
    /** Add session-local evidence references to returned spans/originals. Read-only only. */
    evidenceIds?: boolean;
}
export interface MemoryTools {
    /** Returns detached tool definitions that callers may adapt without changing execution. */
    readonly definitions: ToolDefinition[];
    /** Host-only: resolve a returned alias to the stored ID. Identity when shortIds is false. */
    resolveId(id: string): string;
    /** Host-only: resolve returned evidence to its canonical source; throws for unknown/disabled IDs. */
    resolveEvidence(id: string): EvidenceReference;
    execute(name: string, args: unknown, options?: RequestOptions): Promise<ToolResult>;
}
