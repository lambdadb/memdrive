import type { RequestOptions, Usage } from './types.js';

export class MemDriveError extends Error {
    declare code: string;
    declare details?: Record<string, unknown> | undefined;
    declare usage?: Usage | undefined;
    declare status?: number | undefined;
    constructor(code: string, message: string, { cause, details, usage }: { cause?: unknown; details?: Record<string, unknown> | undefined; usage?: Usage | undefined } = {}) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = 'MemDriveError';
        this.code = code;
        if (details !== undefined) this.details = details;
        if (usage !== undefined) this.usage = usage;
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

export function abortError(cause: unknown, signal?: AbortSignal): unknown {
    const error = cause as { code?: string; name?: string } | undefined;
    if (error?.code === 'ABORTED') return cause;
    return signal?.aborted || error?.name === 'AbortError'
        ? new MemDriveError('ABORTED', 'Operation aborted.', { cause }) : cause;
}
