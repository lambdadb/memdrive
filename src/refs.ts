import { validDate } from './config.js';
import { checkAbort, databaseError, MemDriveError, nativeRequest, requireInput } from './errors.js';

type CreatedRef = { kind: 'fork' | 'checkpoint' | 'merge source'; name: string };

const rejected = new Set([400, 401, 403, 404, 409, 422, 429]);

export function validateRefTime(asOf: unknown, checkpoint: boolean): asserts asOf is string | undefined {
    requireInput(asOf === undefined || !checkpoint && validDate(asOf) && Date.parse(asOf) <= Date.now(),
        'asOf requires a nonfuture UTC ISO timestamp with milliseconds on main or a working fork.');
}

export function historicalViewUnavailable(asOf: string, cause?: unknown) {
    return new MemDriveError('HISTORICAL_VIEW_UNAVAILABLE', 'The requested historical view is unavailable or no longer retained.',
        { cause, details: { asOf } });
}

export async function createRef<T>(pending: Set<string>, ref: CreatedRef, signal: AbortSignal | undefined, submit: () => Promise<T>, valid: (result: T) => boolean, asOf?: string) {
    const { kind, name } = ref;
    const key = `${kind}:${name}`;
    checkAbort(signal);
    function unconfirmed(cause?: unknown) {
        const message = kind === 'merge source'
            ? 'Merge source capture may have succeeded. Start a new capture with a new tag name.'
            : 'Reference creation may have succeeded. Pause source mutations and open the reference by name to inspect it.';
        return new MemDriveError('REF_CREATION_UNCONFIRMED', message, { cause, details: { [kind === 'merge source' ? 'tag' : kind]: name } });
    }
    if (pending.has(key)) throw unconfirmed();
    pending.add(key);
    let result;
    try { result = await nativeRequest(submit, signal); }
    catch (cause) {
        const error = databaseError(cause, `Could not create the ${kind}.`);
        if (!rejected.has(error.status ?? 0)) throw unconfirmed(cause);
        pending.delete(key);
        if (asOf !== undefined && (error.status === 400 || error.status === 404)) {
            const unavailable = historicalViewUnavailable(asOf, cause);
            unavailable.status = error.status;
            throw unavailable;
        }
        if (error.status === 409) error.code = kind === 'fork' ? 'BRANCH_CONFLICT'
            : kind === 'checkpoint' ? 'CHECKPOINT_CONFLICT' : 'MERGE_SOURCE_CONFLICT';
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

/** A cold LambdaDB branch can reject even a valid tag request until its first
 * snapshot commits. Retry only a definite rejection of the same reserved ref.
 */
export async function awaitMergeTag<T>(attempt: () => Promise<T>, stage: 'source' | 'target', signal?: AbortSignal) {
    const deadline = Date.now() + 120_000;
    for (let interval = 250; ; interval = Math.min(interval * 2, 5_000)) {
        try {
            return await attempt();
        } catch (cause) {
            if (!(cause instanceof MemDriveError) || cause.code !== 'DATABASE_ERROR' || cause.status !== 400) throw cause;
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                const code = stage === 'source' ? 'MERGE_SOURCE_NOT_READY' : 'MERGE_TARGET_NOT_READY';
                throw new MemDriveError(code, `Could not pin the merge ${stage} snapshot. Retry the same request.`, { cause });
            }
            await refBackoff(Math.min(interval, remaining), signal);
        }
    }
}
