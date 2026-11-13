import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readVersion, setVersion, PUBLISHED_VERSION } from './version.mjs';

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

/** Change only version metadata in a disposable checkout of the exact source commit. */
export function prepareDevPackage(root, sha) {
    assert(/^[a-f0-9]{40}$/.test(sha ?? ''), 'Require an exact source SHA');
    assert.equal(git(root, ['rev-parse', 'HEAD']), sha, 'Source SHA must match HEAD');
    assert.equal(git(root, ['status', '--porcelain', '--untracked-files=no']), '', 'Require clean tracked sources');
    const committed = readVersion(root);
    const core = committed.split('-')[0];
    let base = core;
    // Before the first release, the committed version is the intended release target.
    // Once that stable version is tagged, development continues toward its next patch.
    if (committed === core && git(root, ['tag', '--list', `v${committed}`])) {
        git(root, ['merge-base', '--is-ancestor', `v${committed}`, 'HEAD']);
        const parts = core.split('.').map(BigInt);
        base = `${parts[0]}.${parts[1]}.${parts[2] + 1n}`;
    }
    const count = git(root, ['rev-list', '--count', '--first-parent', 'HEAD']);
    assert(/^[1-9]\d*$/.test(count), 'Require nonempty first-parent history');
    const version = setVersion(root, `${base}-dev.${count}`, { allowed: PUBLISHED_VERSION });
    const file = join(root, 'package.json');
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    pkg.memdriveSourceCommit = sha;
    writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
    return version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    assert.equal(process.env.GITHUB_REF, 'refs/heads/main', 'Dev preparation requires main');
    assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_dispatch', 'Dev preparation requires explicit dispatch');
    const version = prepareDevPackage(process.cwd(), process.env.GITHUB_SHA);
    console.log(`Prepared ${version} from ${process.env.GITHUB_SHA}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
}
