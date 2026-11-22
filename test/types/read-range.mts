import type { FileDrive, FileReadPage, ReadFileRangeRequest } from '@functional-systems/memdrive';
export async function rangeConsumer(drive: FileDrive, external: FileDrive<'external'>) {
    const request: ReadFileRangeRequest = { path: '/notes.md', startLine: 3, endLine: 9, maxChars: 2000 };
    const page: FileReadPage | null = await drive.read(request);
    if (page?.next) await drive.read(page.next);
    // @ts-expect-error External stores do not have text ranges.
    await external.read({ path: '/vector', startLine: 1 });
    // @ts-expect-error Batch ranges are not supported.
    await drive.read({ paths: ['/notes.md'], maxChars: 2000 });
    return page;
}
