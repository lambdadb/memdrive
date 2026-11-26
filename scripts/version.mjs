import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const core = String.raw`(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)`;
export const COMMITTED_VERSION = new RegExp(`^${core}(?:-rc\\.[1-9]\\d*)?$`);
export const PUBLISHED_VERSION = new RegExp(`^${core}(?:-(dev|rc)\\.([1-9]\\d*))?$`);

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function checkVersion(pkg, lock, allowed) {
    assert(allowed.test(pkg.version), 'Version must use an allowed canonical SemVer form');
    assert.equal(lock.version, pkg.version, 'Package and lock versions differ');
    assert.equal(lock.packages?.['']?.version, pkg.version, 'Root lock version differs');
    assert.equal(lock.name, pkg.name, 'Package and lock names differ');
    assert.equal(lock.packages?.['']?.name, pkg.name, 'Root lock name differs');
    return pkg.version;
}

export function readVersion(root, { allowed = COMMITTED_VERSION } = {}) {
    return checkVersion(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')),
        JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')), allowed);
}

export function setVersion(root, version, { allowed = COMMITTED_VERSION } = {}) {
    assert(allowed.test(version), 'Use X.Y.Z or X.Y.Z-rc.N; dev versions belong only to publication checkouts');
    readVersion(root);
    const pkgFile = join(root, 'package.json'), lockFile = join(root, 'package-lock.json');
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')), lock = JSON.parse(readFileSync(lockFile, 'utf8'));
    pkg.version = version; lock.version = version; lock.packages[''].version = version;
    writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
    writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
    return readVersion(root, { allowed });
}


export function parseVersion(version) {
    const match = PUBLISHED_VERSION.exec(version);
    assert(match, `Unsupported version ${version}`);
    return { core: match.slice(1, 4).map(BigInt), text: match.slice(1, 4).join('.'),
        channel: match[4] ?? 'stable', number: BigInt(match[5] ?? 0) };
}

export function compareCores(left, right) {
    for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
    return 0;
}

export function compareVersions(left, right) {
    const a = parseVersion(left), b = parseVersion(right), rank = { dev: 0, rc: 1, stable: 2 };
    return compareCores(a.core, b.core) || rank[a.channel] - rank[b.channel]
        || (a.number === b.number ? 0 : a.number < b.number ? -1 : 1);
}

const isStableTag = tag => /^v/.test(tag) && PUBLISHED_VERSION.test(tag.slice(1))
    && parseVersion(tag.slice(1)).channel === 'stable';

export function latestStableTag(tags) {
    return tags.filter(isStableTag).sort((a, b) => compareVersions(a.slice(1), b.slice(1))).at(-1);
}

/** Map origin tag names to their commits, peeling annotated tags. */
export function originTags(root) {
    let output;
    try {
        output = git(root, ['ls-remote', '--tags', 'origin']);
    } catch (error) {
        throw new Error('Could not query origin tags', { cause: error });
    }
    const tags = new Map();
    for (const [commit, ref] of output.split('\n').filter(Boolean).map(line => line.split(/\s+/))) {
        const name = ref.slice('refs/tags/'.length);
        if (name.endsWith('^{}')) tags.set(name.slice(0, -3), commit);
        else if (!tags.has(name)) tags.set(name, commit);
    }
    return tags;
}

/** Resolve the commit behind an origin tag, including annotated tags. */
export const originTag = (root, tag) => originTags(root).get(tag);

function isAncestor(root, commit, sha) {
    // A commit missing from a full clone cannot be an ancestor of a local commit.
    try { git(root, ['cat-file', '-e', `${commit}^{commit}`]); } catch { return false; }
    try { git(root, ['merge-base', '--is-ancestor', commit, sha]); return true; } catch (error) {
        if (error.status === 1) return false;
        throw error;
    }
}

/**
 * Derive the development version of a commit from its committed version and origin tags.
 * Returns undefined for a tagged stable release commit, which has no development version (N = 0).
 */
export function devVersion(root, sha) {
    assert.equal(git(root, ['rev-parse', '--is-shallow-repository']), 'false', 'Development numbering requires full Git history');
    const committed = checkVersion(JSON.parse(git(root, ['show', `${sha}:package.json`])),
        JSON.parse(git(root, ['show', `${sha}:package-lock.json`])), COMMITTED_VERSION);
    const committedTag = `v${committed}`;
    // Number from origin tags so a checkout with stale, missing or local-only tags derives the same version.
    const tags = originTags(root), reachable = tag => isAncestor(root, tags.get(tag), sha);
    assert(tags.has(committedTag), `Committed version tag ${committedTag} must exist on origin`);
    assert(reachable(committedTag), `Committed version tag ${committedTag} must be an ancestor of ${sha}`);
    const { core: [major, minor, patch], channel, text } = parseVersion(committed);
    const base = channel === 'stable' ? `${major}.${minor}.${patch + 1n}` : text;
    const stable = latestStableTag([...tags.keys()].filter(tag => isStableTag(tag) && reachable(tag)));
    assert(!stable || compareCores(parseVersion(base).core, parseVersion(stable.slice(1)).core) > 0,
        'Development version must be newer than the latest reachable stable release');
    const count = git(root, ['rev-list', '--count', '--first-parent', stable ? `${tags.get(stable)}..${sha}` : sha]);
    if (count === '0' && channel === 'stable' && stable === committedTag) return undefined;
    assert(/^[1-9]\d*$/.test(count), 'Require at least one commit since the latest stable release');
    return `${base}-dev.${count}`;
}

/** Require a commit on the first-parent history of origin main, where each dev number names one commit. */
export function assertMainCommit(root, sha) {
    git(root, ['fetch', '--quiet', 'origin', 'main']);
    assert(git(root, ['rev-list', '--first-parent', 'origin/main']).split('\n').includes(sha),
        `${sha} is not a first-parent commit of origin/main`);
}

/** Print the dev prerelease tag that the publication workflow accepts for a main commit. */
function devTag(root, ref = 'HEAD') {
    const sha = git(root, ['rev-parse', '--verify', `${ref}^{commit}`]);
    assertMainCommit(root, sha);
    const version = devVersion(root, sha);
    assert(version, `${sha} is a tagged stable release commit and has no development version`);
    return `v${version}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const [command, version, ...extra] = process.argv.slice(2);
    assert(extra.length === 0 && ((command === 'get' && version === undefined) || (command === 'set' && version)
        || command === 'dev'), 'Usage: node scripts/version.mjs get | set VERSION | dev [REF]');
    console.log(command === 'get' ? readVersion(process.cwd())
        : command === 'set' ? setVersion(process.cwd(), version) : devTag(process.cwd(), version));
}
