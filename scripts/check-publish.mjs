import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { readVersion } from './version.mjs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
assert(pkg.private !== true, 'Publication is disabled during bootstrap; follow RELEASING.md before enabling it');
assert(typeof pkg.license === 'string' && existsSync('LICENSE'), 'A confirmed license and LICENSE file are required');
readVersion(process.cwd());
throw new Error('No publication workflow is configured yet; complete the reviewed release setup in RELEASING.md');
