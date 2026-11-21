# MemDrive

TypeScript file SDK backed by LambdaDB. MemDrive accepts an initialized LambdaDB client. The application owns connection credentials and transport.

The package is `@functional-systems/memdrive`, licensed under Apache-2.0. It supports ESM, CommonJS, TypeScript, Node.js 20.12+, and browser bundlers.

## File stores

Use `@functional-systems/memdrive` to create a text file store and save exact originals on a working fork. These stores use a dedicated layout and require a fresh collection name.

```ts
import { MemDrive } from '@functional-systems/memdrive';

const main = await MemDrive.create({ client, name: 'workspace' });
const work = await main.fork({ name: 'research' });
const file = await work.write({
    op: 'create',
    path: '/notes/context.md',
    content: '# Task context\r\n',
});

const reopened = await MemDrive.open({ client, name: 'workspace', at: { fork: 'research' } });
const saved = await reopened.read({ fileId: file.fileId });
// The same file is available through { path: '/notes/context.md' }.
```

`read` returns the original file or `null` when absent. Content can be empty and the SDK preserves whitespace and line endings. Paths are case-sensitive, absolute and slash-separated. Each write creates one file. An existing path in the same fork rejects creation with `PATH_EXISTS`. Main is read-only and supplies the starting view for creating a fork. Working edits are private to that fork. This API currently covers file creation and exact reads.

Use one writer per fork across runtimes and LambdaDB client instances. The SDK serializes writes to a fork within one client instance. It confirms each create through a consistent branch read before returning success. If the request may have been accepted but the SDK cannot confirm it, the error code is `WRITE_UNCONFIRMED`. Its details include the assigned `fileId` and path so the caller can inspect the result. The handle blocks another create at that path until it observes an existing file there. This protection is local to the client instance. A replacement writer must confirm that the earlier request has settled before using that path.

## Historical memory SDK

The earlier memory SDK and its API documentation are available at [the historical revision](https://github.com/lambdadb/memdrive/tree/3b7bd21d9b73f2cf735eeae9e4052ef046b668db). File stores require newly created collections.
