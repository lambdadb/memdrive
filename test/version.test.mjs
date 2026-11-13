import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readVersion, setVersion, COMMITTED_VERSION, PUBLISHED_VERSION } from '../scripts/version.mjs';

test('version updates align package and both lock entries without changing dependency versions', async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'memdrive-version-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const pkg = { name: '@functional-systems/memdrive', version: '0.1.0', dependencies: { sample: '0.1.0' } };
    const lock = { name: pkg.name, version: pkg.version, packages: { '': { ...pkg }, 'node_modules/sample': { version: '0.1.0' } } };
    await writeFile(path.join(root, 'package.json'), JSON.stringify(pkg));
    await writeFile(path.join(root, 'package-lock.json'), JSON.stringify(lock));
    assert.equal(readVersion(root), '0.1.0');
    assert.equal(setVersion(root, '0.2.0-rc.1'), '0.2.0-rc.1');
    const changed = JSON.parse(await readFile(path.join(root, 'package-lock.json')));
    assert.equal(changed.packages['node_modules/sample'].version, '0.1.0');
    assert.equal(changed.packages[''].dependencies.sample, '0.1.0');
    const before = await readFile(path.join(root, 'package.json'), 'utf8');
    assert.throws(() => setVersion(root, '0.2.0-dev.1'));
    assert.equal(await readFile(path.join(root, 'package.json'), 'utf8'), before);
    changed.version = '0.3.0';
    await writeFile(path.join(root, 'package-lock.json'), JSON.stringify(changed));
    assert.throws(() => setVersion(root, '0.3.0'), /differ/);
    assert.equal(await readFile(path.join(root, 'package.json'), 'utf8'), before);
});

test('release channels reject noncanonical or unsupported versions', () => {
    for (const value of ['0.1.0', '1.2.3-rc.12']) assert(COMMITTED_VERSION.test(value));
    assert(PUBLISHED_VERSION.test('1.2.4-dev.1'));
    for (const value of ['01.2.3', '1.2', '1.2.3-beta.1', '1.2.3-rc.0', '1.2.3-rc.01', 'v1.2.3', '1.2.3+build']) {
        assert.equal(COMMITTED_VERSION.test(value), false, value);
        assert.equal(PUBLISHED_VERSION.test(value), false, value);
    }
});
