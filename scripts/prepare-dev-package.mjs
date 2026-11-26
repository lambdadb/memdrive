import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setVersion, devVersion, PUBLISHED_VERSION } from './version.mjs';

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Derive an immutable dev version in the disposable checkout of a tagged main lineage. */
export function prepareDevPackage(root, sha) {
    assert(/^[a-f0-9]{40}$/.test(sha ?? ''), 'Require an exact source SHA');
    assert.equal(git(root, ['rev-parse', 'HEAD']), sha, 'Source SHA must match HEAD');
    assert.equal(git(root, ['status', '--porcelain', '--untracked-files=no']), '', 'Require clean tracked sources');
    const derived = devVersion(root, sha);
    if (!derived) return undefined;
    const version = setVersion(root, derived, { allowed: PUBLISHED_VERSION });
    const file = join(root, 'package.json');
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    pkg.memdriveSourceCommit = sha;
    writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
    return version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const event = process.env.GITHUB_EVENT_NAME;
    if (event === 'push') assert.equal(process.env.GITHUB_REF, 'refs/heads/main', 'Dev preparation requires main');
    else assert.equal(event, 'release', 'Dev preparation requires a main push or a published dev prerelease');
    const version = prepareDevPackage(process.cwd(), process.env.GITHUB_SHA);
    // Mode selection already rejects a dev prerelease without a dev version; fail closed if it gets here.
    assert(version || event === 'push', 'A tagged stable release commit has no development version');
    console.log(version ? `Prepared ${version} from ${process.env.GITHUB_SHA}`
        : '::notice::Tagged stable release commit has no development version; skipping this push.');
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `ready=${!!version}\n`);
}
