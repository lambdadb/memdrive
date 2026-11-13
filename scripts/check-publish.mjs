import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readVersion, PUBLISHED_VERSION } from './version.mjs';

export function checkPublish(root, channel) {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    assert.equal(channel, 'dev', 'Only an explicitly selected dev channel is enabled');
    assert(pkg.private !== true, 'Package is private');
    assert.equal(pkg.name, '@functional-systems/memdrive', 'Unexpected package name');
    assert.equal(pkg.license, 'Apache-2.0', 'Unexpected package license');
    assert(existsSync(join(root, 'LICENSE')), 'LICENSE is required');
    assert.equal(pkg.repository?.url, 'git+https://github.com/lambdadb/memdrive.git', 'Unexpected source repository');
    const version = readVersion(root, { allowed: PUBLISHED_VERSION });
    assert(/-dev\.[1-9]\d*$/.test(version), 'Only development versions may publish through this workflow');
    assert(/^[a-f0-9]{40}$/.test(pkg.memdriveSourceCommit ?? ''), 'Prepared source SHA is required');
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    assert.equal(pkg.memdriveSourceCommit, sha, 'Prepared source SHA must match HEAD');
    return pkg;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const pkg = checkPublish(process.cwd(), process.env.MEMDRIVE_PUBLISH_CHANNEL ?? process.env.npm_config_tag);
    console.log(`Validated ${pkg.name}@${pkg.version} for dev publication`);
}
