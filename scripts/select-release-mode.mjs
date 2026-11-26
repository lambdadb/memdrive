import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readVersion, parseVersion, devVersion, originTag, assertMainCommit, PUBLISHED_VERSION } from './version.mjs';

/**
 * Main pushes only verify. A published dev prerelease always selects the dev environment, and
 * prod is selected only for the committed RC/stable version's own tag, which can never be a dev version.
 */
export function selectReleaseMode(root, { event, ref, sha, prerelease }) {
    const version = readVersion(root);
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    assert.equal(sha, head, 'Source SHA must match HEAD');
    let mode;
    if (event === 'push') {
        assert.equal(ref, 'refs/heads/main', 'Push publication requires main');
        mode = originTag(root, `v${version}`) ? 'dev-verify' : 'verify';
    } else {
        assert.equal(event, 'release', 'Only main pushes and published Releases are supported');
        const tagged = ref?.startsWith('refs/tags/v') ? ref.slice('refs/tags/v'.length) : '';
        if (PUBLISHED_VERSION.test(tagged) && parseVersion(tagged).channel === 'dev') {
            assert.equal(prerelease, true, `Development release v${tagged} must be a GitHub prerelease`);
            assertMainCommit(root, sha);
            const expected = devVersion(root, sha);
            assert(expected, `Commit ${sha} is a tagged stable release and has no development version`);
            assert.equal(tagged, expected, `Development release tag must be v${expected} for commit ${sha}`);
            mode = 'dev';
        } else {
            assert.equal(ref, `refs/tags/v${version}`, 'Release ref must match the committed version');
            mode = 'release';
        }
    }
    return { mode, environment: mode === 'dev' || mode === 'dev-verify' ? 'dev' : 'prod' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const result = selectReleaseMode(process.cwd(), { event: process.env.GITHUB_EVENT_NAME,
        ref: process.env.GITHUB_REF, sha: process.env.GITHUB_SHA, prerelease: process.env.RELEASE_PRERELEASE === 'true' });
    console.log(`Run mode ${result.mode}; environment ${result.environment}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
        `mode=${result.mode}\nenvironment=${result.environment}\n`);
}
