import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareDevPackage } from '../scripts/prepare-dev-package.mjs';
import { checkPublish } from '../scripts/check-publish.mjs';
import { selectReleaseMode } from '../scripts/select-release-mode.mjs';
import { publicationDecision, checkArchive, publishPackage } from '../scripts/publish-package.mjs';
import { setVersion, compareVersions, latestStableTag } from '../scripts/version.mjs';

function fixture(t, version = '0.1.0') {
    const base = mkdtempSync(join(tmpdir(), 'memdrive-release-'));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const root = join(base, 'work'), origin = join(base, 'origin.git');
    mkdirSync(root);
    const pkg = { name: '@functional-systems/memdrive', version, license: 'Apache-2.0',
        repository: { url: 'git+https://github.com/lambdadb/memdrive.git' }, dependencies: { pinned: '1.2.3' } };
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg));
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ name: pkg.name, version,
        packages: { '': { ...pkg }, 'node_modules/pinned': { version: '1.2.3' } } }));
    writeFileSync(join(root, 'LICENSE'), 'Synthetic fixture');
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
            GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }).trim();
    git('init', '--bare', origin); git('init', '-b', 'main');
    git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
    git('remote', 'add', 'origin', origin); git('push', '-u', 'origin', 'main');
    const commit = title => {
        writeFileSync(join(root, 'change'), title);
        git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '-m', title);
        git('push', 'origin', 'main'); return git('rev-parse', 'HEAD');
    };
    const tag = name => { git('tag', name); git('push', 'origin', `refs/tags/${name}`); };
    const context = (mode, extra = {}) => ({ mode, event: 'push', ref: 'refs/heads/main', sha: git('rev-parse', 'HEAD'), ...extra });
    return { root, origin, git, commit, tag, context };
}

test('main mode selection uses origin tags, rejects other refs, and fails closed on lookup errors', t => {
    const f = fixture(t);
    assert.deepEqual(selectReleaseMode(f.root, f.context()), { mode: 'verify', environment: 'prod' });
    f.git('tag', 'v0.1.0');
    assert.equal(selectReleaseMode(f.root, f.context()).mode, 'verify');
    f.git('push', 'origin', 'refs/tags/v0.1.0');
    assert.deepEqual(selectReleaseMode(f.root, f.context()), { mode: 'dev', environment: 'dev' });
    assert.throws(() => selectReleaseMode(f.root, f.context(undefined, { ref: 'refs/heads/feature' })), /requires main/);
    f.git('remote', 'set-url', 'origin', join(f.root, 'missing.git'));
    assert.throws(() => selectReleaseMode(f.root, f.context()), /Could not query origin/);
});

test('dev versions count since the reachable stable release and preserve dependencies and source identity', t => {
    const f = fixture(t); f.tag('v0.1.0');
    const sha = f.commit('next');
    assert.equal(prepareDevPackage(f.root, sha), '0.1.1-dev.1');
    const { pkg, distTag, smokePrefix } = checkPublish(f.root, f.context('dev'));
    const lock = JSON.parse(readFileSync(join(f.root, 'package-lock.json')));
    assert.equal(pkg.memdriveSourceCommit, sha); assert.equal(distTag, 'dev'); assert.equal(smokePrefix, 'LAMBDADB_DEV_');
    assert.equal(pkg.version, lock.version); assert.equal(pkg.version, lock.packages[''].version);
    assert.equal(lock.packages['node_modules/pinned'].version, '1.2.3');
    assert.equal(pkg.dependencies.pinned, '1.2.3');
    assert.throws(() => prepareDevPackage(f.root, sha), /clean tracked sources/);
});

test('tagged stable reruns skip without changes, and missing tags or incorrect source SHAs cannot prepare dev builds', t => {
    const f = fixture(t), sha = f.context().sha;
    assert.throws(() => prepareDevPackage(f.root, 'f'.repeat(40)), /match HEAD/);
    assert.throws(() => prepareDevPackage(f.root, sha), /must exist on origin/);
    f.tag('v0.1.0');
    assert.equal(prepareDevPackage(f.root, sha), undefined);
    assert.equal(f.git('status', '--porcelain'), '');
});

test('RC numbering continues across RC tags, starts from root without a stable release, and fetches late tags', t => {
    const f = fixture(t); f.tag('v0.1.0');
    setVersion(f.root, '0.2.0-rc.1'); f.commit('rc1'); f.tag('v0.2.0-rc.1');
    setVersion(f.root, '0.2.0-rc.2'); f.commit('rc2'); f.tag('v0.2.0-rc.2');
    const sha = f.commit('next');
    f.git('tag', '-d', 'v0.2.0-rc.2');
    assert.equal(prepareDevPackage(f.root, sha), '0.2.0-dev.3');
    assert.equal(f.git('tag', '--list', 'v0.2.0-rc.2'), 'v0.2.0-rc.2');
    const noStable = fixture(t, '0.1.0-rc.1'); noStable.tag('v0.1.0-rc.1');
    assert.equal(prepareDevPackage(noStable.root, noStable.commit('next')), '0.1.0-dev.2');
    const rollback = fixture(t); rollback.tag('v0.2.0'); rollback.tag('v0.1.0');
    assert.throws(() => prepareDevPackage(rollback.root, rollback.commit('next')), /newer than/);
});

test('verification has no publication channel and releases require exact tags, refs and prerelease flags', async t => {
    for (const [version, prerelease, distTag] of [['0.1.0', false, 'latest'], ['0.1.0-rc.1', true, 'rc']]) {
        const f = fixture(t, version), tag = `v${version}`;
        const verify = checkPublish(f.root, f.context('verify'));
        assert.equal(verify.distTag, ''); assert.equal(verify.smokePrefix, 'LAMBDADB_PROD_');
        await assert.rejects(publishPackage(f.root, 'absent-manifest', f.context('verify')), /cannot publish/);
        f.tag(tag);
        const context = f.context('release', { event: 'release', ref: `refs/tags/${tag}`, tag, prerelease });
        assert.deepEqual(selectReleaseMode(f.root, context), { mode: 'release', environment: 'prod' });
        assert.equal(checkPublish(f.root, context).distTag, distTag);
        assert.throws(() => checkPublish(f.root, { ...context, prerelease: !prerelease }), /prerelease flag/);
        assert.throws(() => checkPublish(f.root, { ...context, tag: 'v9.9.9' }), /tag must match/);
        assert.throws(() => checkPublish(f.root, { ...context, event: 'push' }), /published GitHub Release/);
        assert.throws(() => checkPublish(f.root, { ...context, sha: 'f'.repeat(40) }), /match HEAD/);
    }
});

test('release checks reject commits outside main, moved tags and modifications beyond generated metadata', t => {
    const outside = fixture(t); outside.git('switch', '-c', 'outside');
    writeFileSync(join(outside.root, 'unreviewed'), 'unreviewed');
    outside.git('add', '.'); outside.git('-c', 'commit.gpgsign=false', 'commit', '-m', 'outside'); outside.tag('v0.1.0');
    assert.throws(() => checkPublish(outside.root, outside.context('release', {
        event: 'release', ref: 'refs/tags/v0.1.0', tag: 'v0.1.0', prerelease: false,
    })));
    const f = fixture(t); f.tag('v0.1.0'); f.commit('next');
    assert.throws(() => checkPublish(f.root, f.context('release', {
        event: 'release', ref: 'refs/tags/v0.1.0', tag: 'v0.1.0', prerelease: false,
    })), /exact event SHA/);
    prepareDevPackage(f.root, f.context().sha);
    const pkgFile = join(f.root, 'package.json'), pkg = JSON.parse(readFileSync(pkgFile));
    pkg.dependencies.pinned = '9.9.9'; writeFileSync(pkgFile, JSON.stringify(pkg));
    assert.throws(() => checkPublish(f.root, f.context('dev')), /beyond generated release metadata/);
    writeFileSync(join(f.root, 'LICENSE'), 'modified');
    assert.throws(() => checkPublish(f.root, f.context('dev')), /Tracked release sources/);
});

test('publication reruns require the same source and archive, and only dev can skip backwards channel moves', () => {
    const pkg = { version: '0.1.0-dev.8', memdriveSourceCommit: 'a'.repeat(40) }, integrity = 'sha512-fixture';
    const published = { ...pkg, dist: { integrity } };
    assert.equal(publicationDecision(pkg, {}, 'dev', integrity), 'publish');
    assert.equal(publicationDecision(pkg, { versions: { [pkg.version]: published } }, 'dev', integrity), 'already-published');
    assert.throws(() => publicationDecision(pkg, { versions: { [pkg.version]: { ...published, memdriveSourceCommit: 'b'.repeat(40) } } }, 'dev', integrity), /different source commit/);
    assert.throws(() => publicationDecision(pkg, { versions: { [pkg.version]: published } }, 'dev', 'sha512-different'), /archive differs/);
    assert.equal(publicationDecision(pkg, { 'dist-tags': { dev: '0.1.0-dev.9' } }, 'dev', integrity), 'superseded-version');
    assert.equal(publicationDecision({ ...pkg, version: '0.1.0-rc.1' }, { 'dist-tags': { dev: '0.2.0-dev.1' } }, 'rc', integrity), 'publish');
    assert(compareVersions('0.1.0-dev.10', '0.1.0-dev.9') > 0);
    assert(compareVersions('0.1.0-dev.99', '0.1.0-rc.1') < 0);
    assert(compareVersions('0.1.0-rc.9', '0.1.0') < 0);
    assert.equal(latestStableTag(['v0.1.9', 'v0.2.0', 'v0.3.0-rc.1', 'not-a-tag']), 'v0.2.0');
});

test('archive validation binds the retained bytes and embedded source identity before publication', t => {
    const f = fixture(t, '0.1.0-rc.1'), pkgFile = join(f.root, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgFile)); pkg.memdriveSourceCommit = f.context().sha;
    writeFileSync(pkgFile, JSON.stringify(pkg));
    const manifestPath = join(f.root, 'npm-pack.json');
    const packed = execFileSync('npm', ['pack', '--json'], { cwd: f.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    writeFileSync(manifestPath, packed);
    const { tarball, integrity } = checkArchive(manifestPath, pkg);
    assert(integrity.startsWith('sha512-'));
    assert.throws(() => checkArchive(manifestPath, { ...pkg, memdriveSourceCommit: 'f'.repeat(40) }), /Packed memdriveSourceCommit/);
    writeFileSync(tarball, 'changed archive');
    assert.throws(() => checkArchive(manifestPath, pkg), /differs from validated archive/);
});
