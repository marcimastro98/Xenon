import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseSemver, semverNewer } = require('../semver.js');

test('parseSemver handles plain and v-prefixed tags', () => {
  assert.deepEqual(parseSemver('3.0.1'), [3, 0, 1]);
  assert.deepEqual(parseSemver('v3.0.1'), [3, 0, 1]);
  assert.deepEqual(parseSemver(' V10.20.30 '), [10, 20, 30]);
  assert.deepEqual(parseSemver('3.0.1-rc.1'), [3, 0, 1]);   // prerelease suffix ignored
  assert.equal(parseSemver('3.0'), null);
  assert.equal(parseSemver('latest'), null);
  assert.equal(parseSemver(''), null);
  assert.equal(parseSemver(null), null);
});

test('semverNewer compares each component numerically', () => {
  assert.equal(semverNewer('3.0.2', '3.0.1'), true);
  assert.equal(semverNewer('3.1.0', '3.0.9'), true);
  assert.equal(semverNewer('4.0.0', '3.9.9'), true);
  assert.equal(semverNewer('3.0.1', '3.0.1'), false);
  assert.equal(semverNewer('3.0.1', '3.0.2'), false);
  assert.equal(semverNewer('3.0.10', '3.0.9'), true);   // numeric, not lexicographic
});

test('semverNewer never reports an update on unparseable input', () => {
  assert.equal(semverNewer('banana', '3.0.1'), false);
  assert.equal(semverNewer('3.0.2', ''), false);
  assert.equal(semverNewer(null, null), false);
});
