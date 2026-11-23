import { format, formatTag, parseStore } from './config.js';
import { checkAbort, databaseError, MemDriveError, mutationOptions, nativeOptions, nativeRequest } from './errors.js';
import { publicationIdentity } from './publication-log.js';
import type { Handle } from './storage-reads.js';
import type { ConnectionOptions } from './types.js';

export const deletingFormat = 'files-deleting-v0';
const rejected = new Set([400, 401, 403, 404, 409, 422, 429]);

/**
 * Name-keyed objects that live only as long as something else needs them.
 * An entry is held weakly, so it is collected once the application drops it;
 * `hold` keeps it strongly while it carries state that must not be lost. The
 * same name returns the same object for as long as that object is alive.
 */
export function weakRegistry<T extends object>() {
    const entries = new Map<string, WeakRef<T>>();
    const held = new Map<string, T>();
    const collected = new FinalizationRegistry<string>(name => {
        if (entries.get(name)?.deref() === undefined) entries.delete(name);
    });
    return {
        get: (name: string) => entries.get(name)?.deref(),
        set(name: string, value: T) {
            if (entries.get(name)?.deref() === value) return;
            held.delete(name);
            entries.set(name, new WeakRef(value));
            collected.register(value, name);
        },
        delete(name: string) {
            entries.delete(name);
            held.delete(name);
        },
        /** Pin or release the current entry of `name`. A replaced or removed object is ignored. */
        hold(name: string, value: object, keep: boolean) {
            if (entries.get(name)?.deref() !== value) return;
            if (keep) held.set(name, value as T);
            else held.delete(name);
        },
    };
}

type Coordinator = ReturnType<typeof coordinator>;
const coordinators = new WeakMap<ConnectionOptions['client'], ReturnType<typeof weakRegistry<Coordinator>>>();

function coordinator(retain: (gate: object, keep: boolean) => void) {
    let active = 0;
    let exclusive = false;
    let invalid = false;
    // A running operation or an unfinished destruction must outlive every
    // reference the application holds; an idle coordinator may be collected.
    const update = () => retain(gate, active > 0 || exclusive || invalid);
    const gate = {
        soleOperation() { return active === 1 && !exclusive && !invalid; },
        invalidate() { invalid = true; update(); },
        reset() { invalid = false; update(); },
        async run<T>(operation: () => Promise<T>): Promise<T> {
            if (exclusive) throw new MemDriveError('STORE_BUSY', 'A lifecycle operation is in progress.');
            if (invalid) throw new MemDriveError('STORE_DELETED', 'Store destruction is incomplete or unconfirmed. Resume with MemDrive.destroy.');
            active++;
            update();
            try { return await operation(); }
            finally { active--; update(); }
        },
        async exclusive<T>(operation: () => Promise<T>): Promise<T> {
            if (exclusive || active) throw new MemDriveError('STORE_BUSY', 'Wait for active store operations to finish before maintenance.');
            exclusive = true;
            update();
            try { return await operation(); }
            finally { exclusive = false; update(); }
        },
    };
    return gate;
}

export function lifecycle({ client, name }: ConnectionOptions) {
    let stores = coordinators.get(client);
    if (!stores) { stores = weakRegistry(); coordinators.set(client, stores); }
    let gate = stores.get(name);
    if (!gate) {
        const registry = stores;
        gate = coordinator((value, keep) => registry.hold(name, value, keep));
        stores.set(name, gate);
    }
    return gate;
}


export async function inspectCollection(handle: Handle, signal?: AbortSignal) {
    try {
        const response = await nativeRequest(() => handle.get(nativeOptions(signal)), signal);
        checkAbort(signal);
        if (response?.collection?.collectionName !== handle.collectionName)
            throw new MemDriveError('INVALID_RESULT', 'Collection lookup did not identify the requested collection.');
        return response.collection;
    } catch (cause) {
        const error = databaseError(cause, 'Could not inspect the collection.');
        if (error.status === 404) return undefined;
        throw error;
    }
}

/** Unknown deletion outcomes stay fenced until an explicit, host-coordinated retry. */
export async function deleteReference(submit: () => Promise<unknown>, confirm: () => Promise<void>, invalidate: () => void, signal?: AbortSignal) {
    checkAbort(signal);
    try { await nativeRequest(submit, signal); }
    catch (cause) {
        const error = databaseError(cause, 'Could not delete the reference.');
        if (error.status !== 404) {
            if (rejected.has(error.status ?? 0)) throw error;
            invalidate();
            throw new MemDriveError('REF_DELETION_UNCONFIRMED',
                'Reference deletion may have succeeded. Fence outstanding requests before retrying delete or reusing its name.', { cause });
        }
    }
    try {
        checkAbort(signal);
        await confirm();
        checkAbort(signal);
    } catch (cause) {
        invalidate();
        throw new MemDriveError('REF_DELETION_UNCONFIRMED', 'Reference deletion was not confirmed. Fence outstanding requests before retrying.', { cause });
    }
}

export async function destroyStore(connection: ConnectionOptions, before: (metadata: NonNullable<Awaited<ReturnType<typeof inspectCollection>>>, identity: Awaited<ReturnType<typeof publicationIdentity>>) => Promise<void>, invalidate: () => void, signal?: AbortSignal) {
    const { client, name } = connection;
    const content = client.collection(name);
    const metadata = await inspectCollection(content, signal);
    if (!metadata) { invalidate(); return; }
    const deleting = metadata.tags?.[formatTag] === deletingFormat;
    parseStore(deleting ? { ...metadata, tags: { ...metadata.tags, [formatTag]: format } } : metadata, name);
    const identity = await publicationIdentity(name, metadata);
    const internal = client.collection(identity.name);
    const journal = await inspectCollection(internal, signal);
    if (journal && (journal.collectionName !== identity.name || journal.defaultBranchName !== 'main'
        || journal.tags?.['memdrive.format'] !== 'merge-publication-v1' || journal.tags?.['memdrive.owner'] !== identity.driveId))
        throw new MemDriveError('INCOMPATIBLE_STORE', 'The publication journal is not owned by this store.');
    if (!deleting) {
        await before(metadata, identity);
        checkAbort(signal);
        try {
            await nativeRequest(() => content.update({ tags: { ...metadata.tags, [formatTag]: deletingFormat } }, mutationOptions(signal)), signal);
        } catch (cause) {
            const error = databaseError(cause, 'Could not mark the store for deletion.');
            if (rejected.has(error.status ?? 0)) throw error;
            invalidate();
            throw new MemDriveError('STORE_DELETION_UNCONFIRMED',
                'The deletion marker may have been stored. Fence outstanding requests, then retry destroy.', { cause });
        }
    }
    invalidate();
    try {
        // Keep the marked content collection as the durable cleanup anchor until
        // its owned journal is gone. A fresh process can resume from this marker.
        const marked = await inspectCollection(content, signal);
        if (!marked || (await publicationIdentity(name, marked)).driveId !== identity.driveId
            || marked.tags?.[formatTag] !== deletingFormat)
            throw new MemDriveError('INVALID_RESULT', 'The deletion marker was not confirmed on the original store.');
        if (journal) await removeCollection(internal, signal);
        await removeCollection(content, signal);
    } catch (cause) {
        throw new MemDriveError('STORE_DELETION_UNCONFIRMED',
            'Store cleanup is incomplete or unconfirmed. Fence outstanding requests, then retry destroy with the same client and name.', { cause });
    }
}

async function removeCollection(handle: Handle, signal?: AbortSignal) {
    try { await nativeRequest(() => handle.delete(mutationOptions(signal)), signal); }
    catch (cause) {
        const error = databaseError(cause, 'Could not delete the collection.');
        if (error.status !== 404) throw error;
    }
    if (await inspectCollection(handle, signal))
        throw new MemDriveError('INVALID_RESULT', 'Collection deletion has not been confirmed.');
}
