import { checkAbort, MemDriveError } from './errors.js';

/*
 * State-changing calls on one branch of one store run one at a time, in call
 * order, within this module instance. A file is several LambdaDB documents
 * (an original and its chunks) and LambdaDB has no multi-document transaction
 * or conditional write, so interleaved writers could remove each other's
 * chunks or create two files at one path. A queue exists only while it has
 * pending operations. Separate processes and SDK copies are not coordinated.
 */
type Queue = { tail: Promise<void>; pending: number };
const queues = new Map<string, Queue>();

/**
 * Store tags are hexadecimal and branch names are never empty and never
 * contain a slash. The empty branch name keys a pending store deletion.
 */
const queueKey = (store: string, branch: string) => `${store}/${branch}`;

/** Wait for the previous operations, or reject when the caller aborts first. */
function untilSettled(previous: Promise<void>, signal?: AbortSignal) {
    if (!signal) return previous;
    return new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(new MemDriveError('ABORTED', 'Operation aborted.'));
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
        void previous.then(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        });
    });
}

/** Run an operation after every pending operation on the given queues. */
async function serialize<T>(keys: string[], signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const done = new Promise<void>(resolve => { release = resolve; });
    const entries = keys.map(key => {
        const queue = queues.get(key) ?? { tail: Promise.resolve(), pending: 0 };
        const prior = queue.tail;
        queue.tail = done;
        queue.pending++;
        queues.set(key, queue);
        return { key, queue, prior };
    });
    const previous = Promise.all(entries.map(entry => entry.prior)).then(() => undefined);
    const settle = () => {
        release();
        for (const { key, queue } of entries)
            if (--queue.pending === 0 && queues.get(key) === queue) queues.delete(key);
    };
    try {
        await untilSettled(previous, signal);
        checkAbort(signal);
    } catch (error) {
        // An abandoned turn still holds its place until the operations before it finish.
        void previous.then(settle);
        throw error;
    }
    try { return await operation(); }
    finally { settle(); }
}

/** Run a state-changing operation on one branch of a store in call order, after a pending store deletion. */
export function onBranch<T>(store: string, branch: string, signal: AbortSignal | undefined, operation: () => Promise<T>) {
    const deletion = queueKey(store, '');
    return serialize([queueKey(store, branch), ...queues.has(deletion) ? [deletion] : []], signal, operation);
}

/**
 * Delete a store once its pending operations in this process finish. Operations
 * on any of its branches that arrive meanwhile run after the deletion.
 */
export function afterStoreQueues<T>(store: string, signal: AbortSignal | undefined, operation: () => Promise<T>) {
    const deletion = queueKey(store, '');
    const branches = [...queues.keys()].filter(key => key.startsWith(deletion) && key !== deletion);
    return serialize([deletion, ...branches], signal, operation);
}

/** Test-only: the pending operations of each live queue. Not exported from the package root. */
export const queueSizes = () => [...queues.values()].map(queue => queue.pending);
