// Node.js versions without current security fixes are named at startup, and
// package.json asks for the patched ones (CVE-2026-111497, Node 18/20 end of life).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const { nodeSecurityStatus, nodeWarning } = require('../node-version.js');

test('the startup warning names how to update on this OS, and is empty when patched', () => {
  assert.equal(nodeWarning('v24.22.1', 'linux'), '');
  assert.match(nodeWarning('v20.19.5', 'win32'), /no longer supported.*winget upgrade OpenJS\.NodeJS\.LTS/);
  assert.match(nodeWarning('v22.23.3', 'darwin'), /missing current security fixes.*brew upgrade node/);
  const linux = nodeWarning('v18.20.4', 'linux');
  assert.match(linux, /package manager or nodejs\.org/);
  assert.doesNotMatch(linux, /winget|brew/);
});

test('end-of-life and unpatched lines are told apart from patched ones', () => {
  for (const v of ['v18.20.4', 'v20.19.5', 'v25.2.0', 'garbage']) assert.equal(nodeSecurityStatus(v), 'unsupported', v);
  for (const v of ['v22.23.3', 'v24.21.0', 'v26.12.0']) assert.equal(nodeSecurityStatus(v), 'outdated', v);
  for (const v of ['v22.23.4', 'v24.22.1', 'v26.12.1', 'v26.13.0', 'v28.1.0']) assert.equal(nodeSecurityStatus(v), 'ok', v);
});

test('package.json and the server agree', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.engines.node, '>=22.23.4 <23 || >=24.22.1 <25 || >=26.12.1');
  const server = engineSource();
  assert.match(server, /require\('\.\/node-version'\)\.nodeWarning\(\)/);
});
