import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkPublish } from './check-publish.mjs';

export function compareDevVersions(left, right) {
    const parse = value => {
        const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-dev\.([1-9]\d*)$/.exec(value);
        assert(match, `Unexpected dev version: ${value}`);
        return match.slice(1).map(BigInt);
    };
    const a = parse(left), b = parse(right);
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return 0;
}

export function publicationDecision(pkg, registry) {
    const published = registry.versions?.[pkg.version];
    if (published) {
        assert.equal(published.memdriveSourceCommit, pkg.memdriveSourceCommit, 'Version belongs to a different source commit');
        return 'already-published';
    }
    const current = registry['dist-tags']?.dev;
    return current && compareDevVersions(pkg.version, current) < 0 ? 'superseded-version' : 'publish';
}

async function registryPackage(name) {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
    if (response.status === 404) return {};
    assert(response.ok, `Registry lookup failed with HTTP ${response.status}`);
    return response.json();
}

export async function publishDev(root, manifestPath) {
    const pkg = checkPublish(root, 'dev');
    const [archive] = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(archive.name, pkg.name, 'Tarball package name differs');
    assert.equal(archive.version, pkg.version, 'Tarball version differs');
    assert.equal(archive.filename, `${pkg.name.replace('@', '').replace('/', '-')}-${pkg.version}.tgz`, 'Unexpected archive filename');
    const tarball = join(dirname(manifestPath), archive.filename);
    const integrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`;
    assert.equal(integrity, archive.integrity, 'Tarball differs from validated archive');
    const remote = execFileSync('git', ['ls-remote', '--exit-code', 'origin', 'refs/heads/main'],
        { cwd: root, encoding: 'utf8' }).trim().split(/\s+/)[0];
    if (remote !== pkg.memdriveSourceCommit) {
        console.log('Skipping superseded main commit');
        return;
    }
    const before = await registryPackage(pkg.name);
    const decision = publicationDecision(pkg, before);
    if (decision !== 'publish') {
        console.log(`Skipping ${pkg.version}: ${decision}`);
        return;
    }
    execFileSync('npm', ['publish', tarball, '--access', 'public', '--tag', 'dev', '--provenance'],
        { cwd: root, stdio: 'inherit', env: { ...process.env, MEMDRIVE_PUBLISH_CHANNEL: 'dev' } });
    const after = await registryPackage(pkg.name);
    assert.equal(after['dist-tags']?.dev, pkg.version, 'Registry dev tag does not identify the published version');
    assert.equal(after['dist-tags']?.latest, before['dist-tags']?.latest, 'Publication changed the latest tag');
    assert.equal(after.versions?.[pkg.version]?.memdriveSourceCommit, pkg.memdriveSourceCommit, 'Registry source SHA differs');
    assert.equal(after.versions?.[pkg.version]?.dist?.integrity, integrity, 'Registry archive differs from validated tarball');
    console.log(`Verified ${pkg.name}@${pkg.version} under dev; latest unchanged`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    assert.equal(process.argv.length, 3, 'Usage: node scripts/publish-dev.mjs PACK_MANIFEST');
    await publishDev(process.cwd(), resolve(process.argv[2]));
}
