import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readVersion } from './version.mjs';

/** Resolve the commit behind an origin tag, including annotated tags. */
export function originTag(root, tag) {
    const ref = `refs/tags/${tag}`;
    let output;
    try {
        output = execFileSync('git', ['ls-remote', '--exit-code', '--tags', 'origin', ref, `${ref}^{}`],
            { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
        if (error.status === 2) return undefined;
        throw new Error(`Could not query origin for ${tag}`, { cause: error });
    }
    const refs = new Map(output.trim().split('\n').map(line => line.split(/\s+/).reverse()));
    return refs.get(`${ref}^{}`) ?? refs.get(ref);
}

export function selectReleaseMode(root, { event, ref, sha }) {
    const version = readVersion(root);
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    assert.equal(sha, head, 'Source SHA must match HEAD');
    let mode;
    if (event === 'push') {
        assert.equal(ref, 'refs/heads/main', 'Push publication requires main');
        mode = originTag(root, `v${version}`) ? 'dev' : 'verify';
    } else {
        assert.equal(event, 'release', 'Only main pushes and published Releases are supported');
        assert.equal(ref, `refs/tags/v${version}`, 'Release ref must match the committed version');
        mode = 'release';
    }
    return { mode, environment: mode === 'dev' ? 'dev' : 'prod' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const result = selectReleaseMode(process.cwd(), { event: process.env.GITHUB_EVENT_NAME,
        ref: process.env.GITHUB_REF, sha: process.env.GITHUB_SHA });
    console.log(`Run mode ${result.mode}; environment ${result.environment}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
        `mode=${result.mode}\nenvironment=${result.environment}\n`);
}
