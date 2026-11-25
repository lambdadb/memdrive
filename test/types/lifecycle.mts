import { create, destroy, MemDrive } from '@functional-systems/memdrive';
import type { CheckpointAt, CheckpointList, ConnectionOptions, FileDrive, FileDriveDescription, FileRef, FileRefEntry, ForkAt, ForkList } from '@functional-systems/memdrive';

export async function lifecycleConsumer(connection: ConnectionOptions, external: FileDrive<'external'>) {
    const drive = await create(connection);
    const forks: ForkList = await drive.listForks();
    const forkAt: ForkAt | undefined = forks.forks[0]?.at;
    const checkpoints: CheckpointList = await external.listCheckpoints({}, { signal: new AbortController().signal });
    const checkpointAt: CheckpointAt | undefined = checkpoints.checkpoints[0]?.at;
    const entry: FileRefEntry<CheckpointAt> | undefined = checkpoints.checkpoints[0];
    const createdAt: string | undefined = entry?.createdAt;
    const page: CheckpointList = await drive.listCheckpoints({ limit: 10 });
    if (page.next) await drive.listCheckpoints(page.next);
    const forkPage: ForkList = await drive.listForks({ limit: 2 });
    if (forkPage.next) await drive.listForks({ cursor: forkPage.next.cursor });
    // @ts-expect-error A continuation carries only its cursor.
    await drive.listCheckpoints({ cursor: 'opaque', limit: 10 });
    const described: FileDriveDescription = await drive.describe();
    const latest: FileRef<CheckpointAt> | null = described.latestCheckpoint;
    await drive.describe({ at: { kind: 'fork', name: 'draft' } }, { signal: new AbortController().signal });
    // @ts-expect-error A checkpoint has no latest checkpoint.
    await drive.describe({ at: { kind: 'checkpoint', name: 'saved' } });
    // @ts-expect-error describe takes a request before its options.
    await drive.describe({ signal: new AbortController().signal });
    const work = await drive.fork({ name: 'draft' });
    const checkpoint = await drive.checkpoint({ at: work.at, name: 'saved' });
    const removed: FileRef<CheckpointAt> = await drive.deleteCheckpoint(checkpoint);
    await drive.deleteFork({ at: work.at });
    // @ts-expect-error Main cannot be deleted.
    await drive.deleteFork({ at: { kind: 'main' } });
    // @ts-expect-error A checkpoint is deleted with deleteCheckpoint.
    await drive.deleteFork({ at: checkpoint.at });
    // @ts-expect-error Existing views are selected by at, not name.
    await drive.deleteCheckpoint({ name: 'saved' });
    // @ts-expect-error Ref listings take only a limit or a cursor.
    await drive.listForks({ prefix: 'draft' });
    // @ts-expect-error Handle deletion is removed.
    await drive.delete();
    await destroy(connection);
    await MemDrive.destroy(connection, { signal: new AbortController().signal });
    return { forkAt, checkpointAt, removed, createdAt, latest };
}

// @ts-expect-error Per-view handle types are removed.
export type RemovedMain = import('@functional-systems/memdrive').MainFileDrive;
// @ts-expect-error Per-view handle types are removed.
export type RemovedWorking = import('@functional-systems/memdrive').WorkingFileDrive;
// @ts-expect-error Per-view handle types are removed.
export type RemovedCheckpoint = import('@functional-systems/memdrive').CheckpointFileDrive;
// @ts-expect-error open no longer selects a view.
export type RemovedForkSelection = import('@functional-systems/memdrive').ForkSelection;
// @ts-expect-error open no longer selects a view.
export type RemovedCheckpointSelection = import('@functional-systems/memdrive').CheckpointSelection;
