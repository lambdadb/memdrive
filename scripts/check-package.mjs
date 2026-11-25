import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, readdirSync, rmSync, mkdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const args = process.argv.slice(2);
const live = args.includes('--live');
const outputIndex = args.indexOf('--output-directory');
const output = outputIndex < 0 ? undefined : resolve(args[outputIndex + 1] ?? '');
const expected = [...(live ? ['--live'] : []), ...(output ? ['--output-directory', args[outputIndex + 1]] : [])];
assert(args.length === expected.length && args.every(arg => expected.includes(arg))
    && (outputIndex < 0 || (args[outputIndex + 1] && !args[outputIndex + 1].startsWith('--'))),
'Usage: node scripts/check-package.mjs [--live] [--output-directory PATH]');
const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const temporary = mkdtempSync(join(tmpdir(), 'memdrive-package-'));
const run = (command, args, cwd = temporary) => execFileSync(command, args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
});

try {
    const [archive] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', temporary], root));
    const paths = new Set(archive.files.map(file => file.path));
    for (const path of ['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'dist/esm/index.js',
        'dist/esm/index.d.ts', 'dist/commonjs/index.js', 'dist/commonjs/index.d.ts'])
        assert(paths.has(path), `Package is missing ${path}`);
    for (const path of paths)
        assert(/^(?:dist\/|src\/|package\.json$|README\.md$|CHANGELOG\.md$|LICENSE$|NOTICE$)/.test(path),
            `Unexpected package file: ${path}`);
    writeFileSync(join(temporary, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    // A clean CI cache may contain tarballs without registry metadata. Allow normal registry resolution.
    run('npm', ['install', '--prefer-offline', '--ignore-scripts', '--no-audit', '--no-fund', join(temporary, archive.filename)]);
    const installed = JSON.parse(run(process.execPath, ['-e', `console.log(JSON.stringify(require(${JSON.stringify(`${pkg.name}/package.json`)})))`]));
    assert.equal(installed.name, pkg.name, 'Installed package name differs');
    assert.equal(installed.version, pkg.version, 'Installed package version differs');
    assert.equal(installed.memdriveSourceCommit, pkg.memdriveSourceCommit, 'Installed source commit differs');
    assert.deepEqual(Object.keys(installed.exports).sort(), ['.', './docling', './package.json']);
    assert.deepEqual(Object.keys(installed.dependencies), ['@functional-systems/lambdadb']);
    const assertion = `for (const key of ['create', 'open', 'destroy', 'MemDriveError', 'createFileTools', 'getFileToolDefinitions', 'fileToolError', 'LambdaDBClient', 'HTTPClient']) {
        if (typeof sdk[key] !== 'function') throw new Error('Missing export: ' + key);
    }
    if (sdk.MemDrive.create !== sdk.create || sdk.MemDrive.open !== sdk.open || sdk.MemDrive.destroy !== sdk.destroy) throw new Error('Missing static factory');
    if (Object.keys(sdk.MemDrive).sort().join() !== 'create,destroy,open') throw new Error('Unexpected static factory members');
    const catalog = sdk.getFileToolDefinitions({ embeddingMode: 'managed', tools: ['fork', 'write', 'listForks', 'deleteFork', 'rollback'] });
    if (!Object.isFrozen(catalog) || catalog[0].inputSchema.properties.version || !catalog[0].inputSchema.properties.at
        || catalog[1].name !== 'write' || catalog[1].inputSchema.required.includes('at') || !catalog[1].inputSchema.$defs.forkAt
        || catalog[2].name !== 'listForks' || catalog[3].readOnly !== false
        || catalog[4].name !== 'rollback' || catalog[4].readOnly !== false || catalog[4].inputSchema.required.join() !== 'at,to')
        throw new Error('Invalid fixed tool catalog');
    for (const removed of ['merge', 'diff', 'status', 'history']) {
        try { sdk.getFileToolDefinitions({ embeddingMode: 'managed', tools: [removed] }); throw new Error('Removed tool is still listed: ' + removed); }
        catch (error) { if (error.code !== 'INVALID_INPUT') throw error; }
    }
    if (!sdk.fileToolGuide.version || !sdk.fileToolGuide.content || !sdk.fileToolGuideTopics.editing.content) throw new Error('Missing file-tool guide');
    if (typeof sdk.fileToolInstructions !== 'string' || !sdk.fileToolGuide.content.includes(sdk.fileToolInstructions)) throw new Error('Missing shared file-tool instructions');
    for (const { topic } of sdk.fileToolGuide.topics) {
        if (sdk.fileToolGuideTopics[topic].version !== sdk.fileToolGuide.version) throw new Error('Mismatched guide version');
    }`;
    run(process.execPath, ['--input-type=module', '-e', `import * as sdk from ${JSON.stringify(pkg.name)}; ${assertion}`]);
    // The re-exported client is the pinned dependency's own class, not a copy.
    run(process.execPath, ['--input-type=module', '-e', `import * as sdk from ${JSON.stringify(pkg.name)};
        import * as native from '@functional-systems/lambdadb';
        if (sdk.LambdaDBClient !== native.LambdaDBClient || sdk.HTTPClient !== native.HTTPClient) throw new Error('Re-exported client differs');`]);
    run(process.execPath, ['--input-type=commonjs', '-e', `const sdk = require(${JSON.stringify(pkg.name)}); ${assertion}`]);
    run(process.execPath, ['--input-type=module', '-e', `
        import { createDoclingChunker } from '${pkg.name}/docling';
        try { await createDoclingChunker({ tokenizer: '/missing-tokenizer.json' }); throw new Error('Unexpected backend'); }
        catch (error) { if (error.code !== 'CHUNKER_UNAVAILABLE') throw error; }
    `]);
    for (const file of readdirSync(join(root, 'test/types')).filter(file => /\.(?:mts|cts|ts)$/.test(file)))
        copyFileSync(join(root, 'test/types', file), join(temporary, file));
    copyFileSync(join(root, 'test/types/tsconfig.json'), join(temporary, 'tsconfig.json'));
    run(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', join(temporary, 'tsconfig.json')]);
    await build({
        stdin: { contents: `export { create, open, destroy, MemDrive, LambdaDBClient, createFileTools, getFileToolDefinitions, fileToolError, fileToolInstructions, fileToolGuide, fileToolGuideTopics } from ${JSON.stringify(pkg.name)};`,
            resolveDir: temporary, sourcefile: 'consumer.js' },
        bundle: true, platform: 'browser', format: 'esm', target: 'es2022', write: false,
    });
    mkdirSync(join(temporary, 'test/helpers'), { recursive: true });
    copyFileSync(join(root, 'test/helpers/file-client.mjs'), join(temporary, 'test/helpers/file-client.mjs'));
    copyFileSync(join(root, 'test/memdrive-files.test.mjs'), join(temporary, 'test/memdrive-files.test.mjs'));
    copyFileSync(join(root, 'test/file-tools.test.mjs'), join(temporary, 'test/file-tools.test.mjs'));
    copyFileSync(join(root, 'test/lifecycle.test.mjs'), join(temporary, 'test/lifecycle.test.mjs'));
    copyFileSync(join(root, 'test/read-range.test.mjs'), join(temporary, 'test/read-range.test.mjs'));
    copyFileSync(join(root, 'test/find-text.test.mjs'), join(temporary, 'test/find-text.test.mjs'));
    run(process.execPath, ['--test', 'test/memdrive-files.test.mjs', 'test/file-tools.test.mjs', 'test/lifecycle.test.mjs', 'test/read-range.test.mjs', 'test/find-text.test.mjs']);
    // Core consumers above work without the optional native package. Test its
    // separate entry point only after explicitly installing the pinned backend.
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', 'docling.rs@2.85.0']);
    mkdirSync(join(temporary, 'test/fixtures'), { recursive: true });
    copyFileSync(join(root, 'test/fixtures/docling-tokenizer.json'), join(temporary, 'test/fixtures/docling-tokenizer.json'));
    copyFileSync(join(root, 'test/structured-chunking.test.mjs'), join(temporary, 'test/structured-chunking.test.mjs'));
    run(process.execPath, ['--test', 'test/structured-chunking.test.mjs']);
    if (live) {
        cpSync(join(root, 'test/integration'), join(temporary, 'test/integration'), { recursive: true });
        const files = readdirSync(join(temporary, 'test/integration')).filter(file => file.endsWith('-live.test.mjs'));
        assert(files.length > 0, 'No live tests found');
        execFileSync(process.execPath, ['--test', '--test-concurrency=1', ...files.map(file => `test/integration/${file}`)], {
            cwd: temporary, stdio: 'inherit', env: { ...process.env, MEMDRIVE_RUN_LIVE_TESTS: '1' },
        });
    }
    if (output) {
        mkdirSync(output, { recursive: true });
        copyFileSync(join(temporary, archive.filename), join(output, archive.filename));
        writeFileSync(join(output, 'npm-pack.json'), `${JSON.stringify([archive], null, 2)}\n`);
    }
    console.log(`Verified ${pkg.name}@${pkg.version}: ${paths.size} packaged files; clean ESM, CommonJS, TypeScript and browser consumers.`);
} finally {
    rmSync(temporary, { recursive: true, force: true });
}
