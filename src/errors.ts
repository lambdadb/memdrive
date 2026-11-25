import type { RequestOptions } from './types.js';

export class MemDriveError extends Error {
    declare code: string;
    declare readonly details?: Record<string, unknown> | undefined;
    declare status?: number | undefined;
    constructor(code: string, message: string, { cause, details }: { cause?: unknown; details?: Record<string, unknown> | undefined } = {}) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = 'MemDriveError';
        this.code = code;
        if (details !== undefined) this.details = details;
    }
}

export function requireInput(condition: unknown, message: string): asserts condition {
    if (!condition) throw new MemDriveError('INVALID_INPUT', message);
}

export function operationOptions(options: RequestOptions = {}): RequestOptions {
    requireInput(options !== null && typeof options === 'object' && !Array.isArray(options)
        && Object.keys(options).every(key => key === 'signal'), 'Operation options accept only signal.');
    const { signal } = options;
    requireInput(signal === undefined || (signal !== null && typeof signal === 'object'
        && typeof signal.aborted === 'boolean' && typeof signal.addEventListener === 'function'
        && typeof signal.removeEventListener === 'function'), 'signal must be an AbortSignal.');
    return { signal };
}

export function checkAbort(signal?: AbortSignal) {
    if (signal?.aborted) throw new MemDriveError('ABORTED', 'Operation aborted.');
}

function abortError(cause: unknown, signal?: AbortSignal): unknown {
    const error = cause as { code?: string; name?: string } | undefined;
    if (error?.code === 'ABORTED') return cause;
    return signal?.aborted || error?.name === 'AbortError'
        ? new MemDriveError('ABORTED', 'Operation aborted.', { cause }) : cause;
}

export function databaseError(error: unknown, message: string): MemDriveError {
    if (error instanceof MemDriveError) return error;
    const result = new MemDriveError('DATABASE_ERROR', message, { cause: error });
    const remote = error as { statusCode?: unknown; status?: unknown; httpStatus?: unknown } | null | undefined;
    const status = remote?.statusCode ?? remote?.status ?? remote?.httpStatus;
    if (typeof status === 'number' && Number.isInteger(status)) result.status = status;
    return result;
}

export async function nativeRequest<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    checkAbort(signal);
    try { return await operation(); }
    catch (cause) { throw abortError(cause, signal); }
}
export const nativeOptions = (signal?: AbortSignal) => signal === undefined ? {} : { signal };

export const mutationOptions = (signal?: AbortSignal) => ({ ...nativeOptions(signal), retries: { strategy: 'none' as const } });

export interface ErrorSummary { code: string; message: string; status?: number; details?: Record<string, unknown> }

/** A serializable summary of an SDK error, without stacks or causes. */
export const errorSummary = (error: MemDriveError): ErrorSummary => ({ code: error.code, message: error.message,
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.details === undefined ? {} : { details: error.details }) });
