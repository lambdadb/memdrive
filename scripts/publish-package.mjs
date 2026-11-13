import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkPublish, releaseContext } from './check-publish.mjs';
import { compareVersions } from './version.mjs';

export function publicationDecision(pkg, registry, distTag, integrity) {
    const published = registry.versions?.[pkg.version];
    if (published) {
        assert.equal(published.memdriveSourceCommit, pkg.memdriveSourceCommit, 'Version belongs to a different source commit');
        assert.equal(published.dist?.integrity, integrity, 'Published archive differs from the tested tarball');
        return 'already-published';
    }
    const current = registry['dist-tags']?.dev;
    return distTag === 'dev' && current && compareVersions(pkg.version, current) < 0 ? 'superseded-version' : 'publish';
}

async function registryPackage(name) {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
    if (response.status === 404) return {};
    assert(response.ok, `Registry lookup failed with HTTP ${response.status}`);
    return response.json();
}

export function checkArchive(manifestPath, pkg) {
    const [archive] = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(archive.name, pkg.name, 'Tarball package name differs');
    assert.equal(archive.version, pkg.version, 'Tarball version differs');
    assert.equal(archive.filename, `${pkg.name.replace('@', '').replace('/', '-')}-${pkg.version}.tgz`, 'Unexpected archive filename');
    const tarball = join(dirname(manifestPath), archive.filename);
    const integrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`;
    assert.equal(integrity, archive.integrity, 'Tarball differs from validated archive');
    const packed = JSON.parse(execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }));
    for (const field of ['name', 'version', 'memdriveSourceCommit'])
        assert.equal(packed[field], pkg[field], `Packed ${field} differs from prepared metadata`);
    return { tarball, integrity };
}

export async function publishPackage(root, manifestPath, context) {
    const { pkg, distTag } = checkPublish(root, context);
    assert(distTag, 'Verification mode cannot publish');
    assert.equal(pkg.memdriveSourceCommit, context.sha, 'Prepared source SHA is required');
    const { tarball, integrity } = checkArchive(manifestPath, pkg);
    const remote = execFileSync('git', ['ls-remote', '--exit-code', 'origin', 'refs/heads/main'],
        { cwd: root, encoding: 'utf8' }).trim().split(/\s+/)[0];
    if (context.mode === 'dev' && remote !== pkg.memdriveSourceCommit) {
        console.log('Skipping superseded main commit');
        return;
    }
    const before = await registryPackage(pkg.name);
    const decision = publicationDecision(pkg, before, distTag, integrity);
    if (decision !== 'publish') {
        console.log(`Skipping ${pkg.version}: ${decision}`);
        return;
    }
    execFileSync('npm', ['publish', tarball, '--access', 'public', '--tag', distTag, '--provenance'],
        { cwd: root, stdio: 'inherit', env: process.env });
    const after = await registryPackage(pkg.name);
    assert.equal(after['dist-tags']?.[distTag], pkg.version, 'Registry channel does not identify the published version');
    if (distTag !== 'latest')
        assert.equal(after['dist-tags']?.latest, before['dist-tags']?.latest, 'Prerelease publication changed the latest tag');
    assert.equal(after.versions?.[pkg.version]?.memdriveSourceCommit, pkg.memdriveSourceCommit, 'Registry source SHA differs');
    assert.equal(after.versions?.[pkg.version]?.dist?.integrity, integrity, 'Registry archive differs from validated tarball');
    console.log(`Verified ${pkg.name}@${pkg.version} under ${distTag}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    assert.equal(process.argv.length, 3, 'Usage: node scripts/publish-package.mjs PACK_MANIFEST');
    await publishPackage(process.cwd(), resolve(process.argv[2]), releaseContext());
}
