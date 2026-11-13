import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const core = String.raw`(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)`;
export const COMMITTED_VERSION = new RegExp(`^${core}(?:-rc\\.[1-9]\\d*)?$`);
export const PUBLISHED_VERSION = new RegExp(`^${core}(?:-(dev|rc)\\.([1-9]\\d*))?$`);

export function readVersion(root, { allowed = COMMITTED_VERSION } = {}) {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
    assert(allowed.test(pkg.version), 'Version must use an allowed canonical SemVer form');
    assert.equal(lock.version, pkg.version, 'Package and lock versions differ');
    assert.equal(lock.packages?.['']?.version, pkg.version, 'Root lock version differs');
    assert.equal(lock.name, pkg.name, 'Package and lock names differ');
    assert.equal(lock.packages?.['']?.name, pkg.name, 'Root lock name differs');
    return pkg.version;
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

export function latestStableTag(tags) {
    return tags.filter(tag => /^v/.test(tag) && PUBLISHED_VERSION.test(tag.slice(1))
        && parseVersion(tag.slice(1)).channel === 'stable')
        .sort((a, b) => compareVersions(a.slice(1), b.slice(1))).at(-1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const [command, version, ...extra] = process.argv.slice(2);
    assert(extra.length === 0 && ((command === 'get' && version === undefined) || (command === 'set' && version)),
        'Usage: node scripts/version.mjs get | set VERSION');
    console.log(command === 'get' ? readVersion(process.cwd()) : setVersion(process.cwd(), version));
}
