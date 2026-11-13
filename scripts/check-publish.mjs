import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readVersion, parseVersion, PUBLISHED_VERSION } from './version.mjs';
import { originTag } from './select-release-mode.mjs';

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function releaseContext(env = process.env) {
    return { mode: env.RUN_MODE, event: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF,
        sha: env.GITHUB_SHA, tag: env.RELEASE_TAG,
        prerelease: env.RELEASE_PRERELEASE === 'true' ? true : env.RELEASE_PRERELEASE === 'false' ? false : undefined };
}

/** Check channel, source, tag and version agreement before any release credentials are used. */
export function checkPublish(root, context) {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    assert(pkg.private !== true, 'Package is private');
    assert.equal(pkg.name, '@functional-systems/memdrive', 'Unexpected package name');
    assert.equal(pkg.license, 'Apache-2.0', 'Unexpected package license');
    assert(existsSync(join(root, 'LICENSE')), 'LICENSE is required');
    assert.equal(pkg.repository?.url, 'git+https://github.com/lambdadb/memdrive.git', 'Unexpected source repository');
    const version = readVersion(root, { allowed: PUBLISHED_VERSION });
    const { channel } = parseVersion(version);
    assert(/^[a-f0-9]{40}$/.test(context.sha ?? ''), 'Require the exact event SHA');
    assert.equal(git(root, ['rev-parse', 'HEAD']), context.sha, 'Source SHA must match HEAD');
    if (context.mode === 'dev' || context.mode === 'verify') {
        assert.equal(context.event, 'push', 'Main builds require a push event');
        assert.equal(context.ref, 'refs/heads/main', 'Main builds require the main ref');
        if (context.mode === 'dev') {
            assert.equal(channel, 'dev', 'Development publication requires a dev version');
            assert.equal(pkg.memdriveSourceCommit, context.sha, 'Prepared source SHA must match the push');
        } else assert.notEqual(channel, 'dev', 'Verification requires a committed RC or stable version');
    } else {
        assert.equal(context.mode, 'release', 'Unsupported release mode');
        assert.equal(context.event, 'release', 'RC/stable publication requires a published GitHub Release');
        assert.notEqual(channel, 'dev', 'Development versions cannot publish through GitHub Releases');
        assert.equal(context.tag, `v${version}`, 'Release tag must match package version');
        assert.equal(context.ref, `refs/tags/${context.tag}`, 'Release ref must match the release tag');
        assert.equal(context.prerelease, channel === 'rc', 'GitHub prerelease flag must match the version channel');
        assert.equal(originTag(root, context.tag), context.sha, 'Origin release tag must identify the exact event SHA');
        assert.equal(git(root, ['rev-parse', `${context.tag}^{commit}`]), context.sha, 'Local release tag must identify HEAD');
    }
    if (pkg.memdriveSourceCommit !== undefined)
        assert.equal(pkg.memdriveSourceCommit, context.sha, 'Package source SHA differs from the event');
    // Permit only generated version/source metadata; all executable sources must stay reviewed.
    const changed = git(root, ['diff', '--name-only', 'HEAD']).split('\n').filter(Boolean);
    assert(changed.every(file => ['package.json', 'package-lock.json'].includes(file)), 'Tracked release sources were modified');
    for (const file of ['package.json', 'package-lock.json']) {
        const original = JSON.parse(git(root, ['show', `HEAD:${file}`]));
        const current = JSON.parse(readFileSync(join(root, file), 'utf8'));
        if (context.mode === 'dev') {
            delete original.version; delete current.version;
            if (file === 'package-lock.json') { delete original.packages[''].version; delete current.packages[''].version; }
        }
        if (file === 'package.json') { delete original.memdriveSourceCommit; delete current.memdriveSourceCommit; }
        assert.deepEqual(current, original, `${file} contains changes beyond generated release metadata`);
    }
    git(root, ['fetch', '--quiet', 'origin', 'main']);
    git(root, ['merge-base', '--is-ancestor', 'HEAD', 'origin/main']);
    return { pkg, distTag: context.mode === 'verify' ? '' : channel === 'stable' ? 'latest' : channel,
        smokePrefix: context.mode === 'dev' ? 'LAMBDADB_DEV_' : 'LAMBDADB_PROD_' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const context = releaseContext(), { pkg, distTag, smokePrefix } = checkPublish(process.cwd(), context);
    // Record source identity in the tested archive for every channel, without committing it.
    pkg.memdriveSourceCommit = context.sha;
    writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
    console.log(`Validated ${pkg.name}@${pkg.version} (${context.mode}); npm dist-tag=${distTag || 'none'}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
        `version=${pkg.version}\ndist_tag=${distTag}\nsmoke_prefix=${smokePrefix}\n`);
}
