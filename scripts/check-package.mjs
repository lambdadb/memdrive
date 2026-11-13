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
        'dist/esm/index.d.ts', 'dist/commonjs/index.js', 'dist/commonjs/index.d.ts', 'docs/tools.md',
        'dist/esm/tools/index.js', 'dist/esm/tools/index.d.ts', 'dist/commonjs/tools/index.js', 'dist/commonjs/tools/index.d.ts'])
        assert(paths.has(path), `Package is missing ${path}`);
    for (const path of paths)
        assert(/^(?:dist\/|src\/|docs\/tools\.md$|package\.json$|README\.md$|CHANGELOG\.md$|LICENSE$|NOTICE$)/.test(path),
            `Unexpected package file: ${path}`);
    writeFileSync(join(temporary, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    // A clean CI cache may contain tarballs without registry metadata. Allow normal registry resolution.
    run('npm', ['install', '--prefer-offline', '--ignore-scripts', '--no-audit', '--no-fund', join(temporary, archive.filename), `tiktoken@${pkg.devDependencies.tiktoken}`]);
    const installed = JSON.parse(run(process.execPath, ['-e', `console.log(JSON.stringify(require(${JSON.stringify(`${pkg.name}/package.json`)})))`]));
    assert.equal(installed.name, pkg.name, 'Installed package name differs');
    assert.equal(installed.version, pkg.version, 'Installed package version differs');
    assert.equal(installed.memdriveSourceCommit, pkg.memdriveSourceCommit, 'Installed source commit differs');
    const assertion = `for (const key of ['create', 'open', 'list', 'MemDriveError']) {
        if (typeof sdk[key] !== 'function') throw new Error('Missing export: ' + key);
    }`;
    run(process.execPath, ['--input-type=module', '-e', `import * as sdk from ${JSON.stringify(pkg.name)}; ${assertion}`]);
    run(process.execPath, ['--input-type=commonjs', '-e', `const sdk = require(${JSON.stringify(pkg.name)}); ${assertion}`]);
    const toolAssertion = `if (typeof createTools !== 'function') throw new Error('Missing createTools export');`;
    run(process.execPath, ['--input-type=module', '-e', `import { createTools } from ${JSON.stringify(`${pkg.name}/tools`)}; ${toolAssertion}`]);
    run(process.execPath, ['--input-type=commonjs', '-e', `const { createTools } = require(${JSON.stringify(`${pkg.name}/tools`)}); ${toolAssertion}`]);
    for (const file of readdirSync(join(root, 'test/types')).filter(file => /\.(?:mts|cts|ts)$/.test(file)))
        copyFileSync(join(root, 'test/types', file), join(temporary, file));
    copyFileSync(join(root, 'test/types/tsconfig.json'), join(temporary, 'tsconfig.json'));
    run(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', join(temporary, 'tsconfig.json')]);
    await build({
        stdin: { contents: `export { create, open, list } from ${JSON.stringify(pkg.name)}; export { createTools } from ${JSON.stringify(`${pkg.name}/tools`)};`,
            resolveDir: temporary, sourcefile: 'consumer.js' },
        bundle: true, platform: 'browser', format: 'esm', target: 'es2022', write: false,
    });
    // Exercise the benchmark consumer against the installed archive, not this checkout's self-reference.
    cpSync(join(root, 'benchmark/longmemeval'), join(temporary, 'benchmark/longmemeval'), { recursive: true });
    mkdirSync(join(temporary, 'test/helpers'), { recursive: true });
    copyFileSync(join(root, 'test/longmemeval.test.mjs'), join(temporary, 'test/longmemeval.test.mjs'));
    for (const file of ['memdrive-client.mjs', 'longmemeval-http.mjs'])
        copyFileSync(join(root, 'test/helpers', file), join(temporary, 'test/helpers', file));
    run(process.execPath, ['--test', 'test/longmemeval.test.mjs']);
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
