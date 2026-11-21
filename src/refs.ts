import { checkAbort, databaseError, MemDriveError, nativeRequest } from './errors.js';

type CreatedRef = { kind: 'fork' | 'checkpoint'; name: string };

const rejected = new Set([400, 401, 403, 404, 409, 422, 429]);

export async function createRef<T>(pending: Set<string>, ref: CreatedRef, signal: AbortSignal | undefined, submit: () => Promise<T>, valid: (result: T) => boolean) {
    const { kind, name } = ref;
    const key = `${kind}:${name}`;
    checkAbort(signal);
    function unconfirmed(cause?: unknown) {
        return new MemDriveError('REF_CREATION_UNCONFIRMED', 'Reference creation may have succeeded. Pause source mutations and open the reference by name to inspect it.',
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
        if (error.status === 409) error.code = kind === 'fork' ? 'BRANCH_CONFLICT' : 'CHECKPOINT_CONFLICT';
        throw error;
    }
    if (signal?.aborted || !valid(result)) throw unconfirmed();
    pending.delete(key);
}
