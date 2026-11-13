import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
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

async function registryPackage(name, { signal = AbortSignal.timeout(30_000) } = {}) {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, { signal });
    if (response.status === 404) return {};
    assert(response.ok, `Registry lookup failed with HTTP ${response.status}`);
    return response.json();
}

/** npm may acknowledge a publish before its metadata and dist-tag become visible. */
export async function waitForPublication({ pkg, distTag, integrity, previousLatest, alreadyPublished = false },
    { read = registryPackage, wait = sleep, now = Date.now } = {}) {
    const deadline = now() + 300_000;
    let announced = false, observed = 'version not visible';
    const timeout = () => new Error(`Timed out after 5 minutes waiting for npm processing of ${pkg.name}@${pkg.version}: ${observed}. No publication was retried.`);
    while (true) {
        const remaining = deadline - now();
        if (remaining <= 0) throw timeout();
        let registry;
        try { registry = await read(pkg.name, { signal: AbortSignal.timeout(remaining) }); }
        catch (error) { if (now() >= deadline) throw timeout(); throw error; }
        const published = registry.versions?.[pkg.version];
        if (published) {
            assert.equal(published.memdriveSourceCommit, pkg.memdriveSourceCommit, 'Registry source SHA differs');
            assert.equal(published.dist?.integrity, integrity, 'Registry archive differs from validated tarball');
        }
        const tags = registry['dist-tags'] ?? {}, current = tags[distTag];
        if (distTag !== 'latest' && tags.latest !== undefined)
            assert.equal(tags.latest, previousLatest, 'Prerelease publication changed the latest tag');
        const latestVisible = distTag === 'latest' || tags.latest === previousLatest;
        const superseded = !!(alreadyPublished && current && compareVersions(current, pkg.version) > 0);
        if (published && latestVisible && (current === pkg.version || superseded))
            return { channelVersion: current, superseded };
        observed = `${published ? 'version visible' : 'version not visible'}, ${distTag}=${current ?? 'missing'}`;
        if (!announced) {
            console.log(`Waiting for npm processing of ${pkg.name}@${pkg.version}; read-only checks every 5 seconds for up to 5 minutes.`);
            announced = true;
        }
        const delay = Math.min(5_000, deadline - now());
        if (delay <= 0) throw timeout();
        await wait(delay);
    }
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
    if (decision === 'superseded-version') {
        console.log(`Skipping ${pkg.version}: ${decision}`);
        return;
    }
    const alreadyPublished = decision === 'already-published';
    if (!alreadyPublished)
        execFileSync('npm', ['publish', tarball, '--access', 'public', '--tag', distTag, '--provenance'],
            { cwd: root, stdio: 'inherit', env: process.env });
    const result = await waitForPublication({ pkg, distTag, integrity,
        previousLatest: before['dist-tags']?.latest, alreadyPublished });
    if (result.superseded)
        console.log(`Verified previously published ${pkg.name}@${pkg.version}; ${distTag} now points to ${result.channelVersion}. No publication or tag change was made.`);
    else console.log(`Verified ${alreadyPublished ? 'previously published ' : ''}${pkg.name}@${pkg.version} under ${distTag}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    assert.equal(process.argv.length, 3, 'Usage: node scripts/publish-package.mjs PACK_MANIFEST');
    await publishPackage(process.cwd(), resolve(process.argv[2]), releaseContext());
}
