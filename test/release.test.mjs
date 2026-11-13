import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareDevPackage } from '../scripts/prepare-dev-package.mjs';
import { checkPublish } from '../scripts/check-publish.mjs';
import { publicationDecision, compareDevVersions } from '../scripts/publish-dev.mjs';

function fixture(t, version = '0.1.0') {
    const root = mkdtempSync(join(tmpdir(), 'memdrive-release-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const pkg = { name: '@functional-systems/memdrive', version, license: 'Apache-2.0',
        repository: { url: 'git+https://github.com/lambdadb/memdrive.git' }, dependencies: { pinned: '1.2.3' } };
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg));
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ name: pkg.name, version,
        packages: { '': { ...pkg }, 'node_modules/pinned': { version: '1.2.3' } } }));
    writeFileSync(join(root, 'LICENSE'), 'Synthetic fixture');
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
            GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }).trim();
    git('init', '-b', 'main'); git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
    return { root, git, sha: git('rev-parse', 'HEAD') };
}

test('dev preparation preserves source identity, dependency pins and all version locations', t => {
    const { root, sha } = fixture(t);
    assert.equal(prepareDevPackage(root, sha), '0.1.0-dev.1');
    const pkg = checkPublish(root, 'dev');
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json')));
    assert.equal(pkg.memdriveSourceCommit, sha);
    assert.equal(pkg.version, lock.version); assert.equal(pkg.version, lock.packages[''].version);
    assert.equal(lock.packages['node_modules/pinned'].version, '1.2.3');
    assert.equal(pkg.dependencies.pinned, '1.2.3');
    assert.throws(() => checkPublish(root, 'latest'), /dev channel/);
    assert.throws(() => prepareDevPackage(root, sha), /clean tracked sources/);
});

test('dev preparation rejects wrong commits and dirty sources before mutation, and direct stable publication is blocked', t => {
    const { root, sha } = fixture(t);
    assert.throws(() => prepareDevPackage(root, 'f'.repeat(40)), /match HEAD/);
    assert.throws(() => checkPublish(root, 'dev'), /development versions/);
    writeFileSync(join(root, 'LICENSE'), 'Dirty fixture');
    assert.throws(() => prepareDevPackage(root, sha), /clean tracked sources/);
    assert.equal(JSON.parse(readFileSync(join(root, 'package.json'))).version, '0.1.0');
});

test('dev versions use the intended target before release and the next patch after a stable tag', t => {
    const stable = fixture(t, '0.1.0');
    stable.git('tag', 'v0.1.0');
    writeFileSync(join(stable.root, 'next'), 'next');
    stable.git('add', '.'); stable.git('-c', 'commit.gpgsign=false', 'commit', '-m', 'next');
    assert.equal(prepareDevPackage(stable.root, stable.git('rev-parse', 'HEAD')), '0.1.1-dev.2');
    const rc = fixture(t, '0.2.0-rc.1');
    assert.equal(prepareDevPackage(rc.root, rc.sha), '0.2.0-dev.1');
});

test('publication skips identical reruns and backwards dev tags but rejects version collisions', () => {
    const pkg = { version: '0.1.0-dev.8', memdriveSourceCommit: 'a'.repeat(40) };
    assert.equal(publicationDecision(pkg, {}), 'publish');
    assert.equal(publicationDecision(pkg, { versions: { [pkg.version]: { ...pkg } } }), 'already-published');
    assert.throws(() => publicationDecision(pkg, { versions: { [pkg.version]: { memdriveSourceCommit: 'b'.repeat(40) } } }), /different source commit/);
    assert.equal(publicationDecision(pkg, { 'dist-tags': { dev: '0.1.0-dev.9' } }), 'superseded-version');
    assert.equal(compareDevVersions('0.2.0-dev.1', '0.1.99-dev.999'), 1);
    assert.equal(compareDevVersions('0.1.0-dev.10', '0.1.0-dev.9'), 1);
    assert.throws(() => compareDevVersions(pkg.version, '0.1.0'), /Unexpected dev/);
});
