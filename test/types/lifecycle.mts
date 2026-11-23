import { create, destroy, MemDrive } from '@functional-systems/memdrive';
import type { CheckpointAt, CheckpointList, ConnectionOptions, FileDrive, FileRef, ForkAt, ForkList } from '@functional-systems/memdrive';

export async function lifecycleConsumer(connection: ConnectionOptions, external: FileDrive<'external'>) {
    const drive = await create(connection);
    const forks: ForkList = await drive.listForks();
    const forkAt: ForkAt | undefined = forks.forks[0]?.at;
    const checkpoints: CheckpointList = await external.listCheckpoints({}, { signal: new AbortController().signal });
    const checkpointAt: CheckpointAt | undefined = checkpoints.checkpoints[0]?.at;
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
    // @ts-expect-error Ref listings take no options.
    await drive.listForks({ prefix: 'draft' });
    // @ts-expect-error Handle deletion is removed.
    await drive.delete();
    await destroy(connection);
    await MemDrive.destroy(connection, { signal: new AbortController().signal });
    return { forkAt, checkpointAt, removed };
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
