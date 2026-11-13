import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readVersion, setVersion, parseVersion, compareCores, latestStableTag, PUBLISHED_VERSION } from './version.mjs';
import { originTag } from './select-release-mode.mjs';

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Derive an immutable dev version in the disposable checkout of a tagged main lineage. */
export function prepareDevPackage(root, sha) {
    assert(/^[a-f0-9]{40}$/.test(sha ?? ''), 'Require an exact source SHA');
    assert.equal(git(root, ['rev-parse', 'HEAD']), sha, 'Source SHA must match HEAD');
    assert.equal(git(root, ['status', '--porcelain', '--untracked-files=no']), '', 'Require clean tracked sources');
    const committed = readVersion(root), committedTag = `v${committed}`;
    const tagged = originTag(root, committedTag);
    assert(tagged, `Committed version tag ${committedTag} must exist on origin`);
    // A tag created after checkout must participate in numbering, not only run-mode selection.
    if (!git(root, ['tag', '--list', committedTag]))
        git(root, ['fetch', '--quiet', '--no-tags', 'origin', `refs/tags/${committedTag}:refs/tags/${committedTag}`]);
    assert.equal(git(root, ['rev-parse', `${committedTag}^{commit}`]), tagged, 'Local and origin release tags differ');
    git(root, ['merge-base', '--is-ancestor', committedTag, 'HEAD']);
    const { core: [major, minor, patch], channel, text } = parseVersion(committed);
    const base = channel === 'stable' ? `${major}.${minor}.${patch + 1n}` : text;
    const stable = latestStableTag(git(root, ['tag', '--merged', 'HEAD', '--list', 'v*']).split('\n'));
    assert(!stable || compareCores(parseVersion(base).core, parseVersion(stable.slice(1)).core) > 0,
        'Development version must be newer than the latest reachable stable release');
    const count = git(root, ['rev-list', '--count', '--first-parent', stable ? `${stable}..HEAD` : 'HEAD']);
    if (count === '0' && channel === 'stable' && stable === committedTag) return undefined;
    assert(/^[1-9]\d*$/.test(count), 'Require at least one commit since the latest stable release');
    const version = setVersion(root, `${base}-dev.${count}`, { allowed: PUBLISHED_VERSION });
    const file = join(root, 'package.json');
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    pkg.memdriveSourceCommit = sha;
    writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
    return version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    assert.equal(process.env.GITHUB_REF, 'refs/heads/main', 'Dev preparation requires main');
    assert.equal(process.env.GITHUB_EVENT_NAME, 'push', 'Dev preparation requires a main push');
    const version = prepareDevPackage(process.cwd(), process.env.GITHUB_SHA);
    console.log(version ? `Prepared ${version} from ${process.env.GITHUB_SHA}`
        : '::notice::Tagged stable release commit has no development version; skipping this push.');
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `ready=${!!version}\n`);
}
