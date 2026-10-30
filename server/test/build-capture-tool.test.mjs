// tools/build-capture.mjs: builds the capture engine and copies it to where
// server.js looks for it. Pinned here: the copy target is the server's
// CAPTURE_EXE, and the cargo call is an argv with the right profile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlan } from '../../tools/build-capture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('release by default, debug on request, copied to server/capture', () => {
  const rel = buildPlan({ root: 'R', platform: 'win32' });
  assert.deepEqual(rel.args, ['build', '--manifest-path', path.join('R', 'apps', 'capture', 'Cargo.toml'), '--release']);
  assert.equal(rel.from, path.join('R', 'apps', 'capture', 'target', 'release', 'xenon-capture.exe'));
  assert.equal(rel.to, path.join('R', 'server', 'capture', 'xenon-capture.exe'));
  const dbg = buildPlan({ root: 'R', debug: true, platform: 'win32' });
  assert.ok(!dbg.args.includes('--release'));
  assert.equal(dbg.from, path.join('R', 'apps', 'capture', 'target', 'debug', 'xenon-capture.exe'));
});

test('on macOS the file has no extension, where the server looks for it there', () => {
  const mac = buildPlan({ root: 'R', platform: 'darwin' });
  assert.equal(mac.from, path.join('R', 'apps', 'capture', 'target', 'release', 'xenon-capture'));
  assert.equal(mac.to, path.join('R', 'server', 'capture', 'xenon-capture'));
});

test('the copy target is the path server.js starts', () => {
  const src = readFileSync(path.join(HERE, '..', 'server.js'), 'utf8');
  assert.match(src, /const CAPTURE_EXE = path\.join\(__dirname, 'capture', process\.platform === 'win32' \? 'xenon-capture\.exe' : 'xenon-capture'\);/);
  const pkg = JSON.parse(readFileSync(path.join(HERE, '..', '..', 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['capture:build'], 'node tools/build-capture.mjs');
});
