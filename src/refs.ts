import { checkAbort, databaseError, MemDriveError, nativeRequest, requireInput } from './errors.js';

type CreatedRef = { kind: 'fork' | 'checkpoint'; name: string };

const rejected = new Set([400, 401, 403, 404, 409, 422, 429]);

export function validateRefVersion(version: unknown, main: boolean): asserts version is string | undefined {
    requireInput(version === undefined || main && typeof version === 'string' && /^v(0|[1-9][0-9]*)$/.test(version),
        'version is supported only from a main source and must identify a publication, such as v3 or the initial v0.');
}

export function historicalViewUnavailable(version: string, cause?: unknown) {
    return new MemDriveError('HISTORICAL_VIEW_UNAVAILABLE', 'The requested main version is unavailable or no longer retained.',
        { cause, details: { version } });
}

export async function createRef<T>(pending: Set<string>, ref: CreatedRef, signal: AbortSignal | undefined, submit: () => Promise<T>, valid: (result: T) => boolean, version?: string) {
    const { kind, name } = ref;
    const key = `${kind}:${name}`;
    checkAbort(signal);
    function unconfirmed(cause?: unknown) {
        return new MemDriveError('REF_CREATION_UNCONFIRMED',
            'Reference creation may have succeeded. Pause source mutations and inspect the reference with its at, for example by listing refs.',
            { cause, details: { [kind]: name } });
    }
    if (pending.has(key)) throw unconfirmed();
    pending.add(key);
    let result;
    try { result = await nativeRequest(submit, signal); }
    catch (cause) {
        const error = databaseError(cause, `Could not create the ${kind}.`);
        if (!rejected.has(error.status ?? 0)) throw unconfirmed(cause);
        pending.delete(key);
        if (version !== undefined && (error.status === 400 || error.status === 404)) {
            const unavailable = historicalViewUnavailable(version, cause);
            unavailable.status = error.status;
            throw unavailable;
        }
        if (error.status === 409) error.code = kind === 'fork' ? 'BRANCH_CONFLICT' : 'CHECKPOINT_CONFLICT';
        throw error;
    }
    if (signal?.aborted || !valid(result)) throw unconfirmed();
    pending.delete(key);
}

export async function refBackoff(ms: number, signal?: AbortSignal) {
    checkAbort(signal);
    await new Promise<void>((resolve, reject) => {
        const cancel = () => {
            clearTimeout(timer);
            reject(new MemDriveError('ABORTED', 'Operation aborted.'));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', cancel);
            resolve();
        }, ms);
        signal?.addEventListener('abort', cancel, { once: true });
    });
}
