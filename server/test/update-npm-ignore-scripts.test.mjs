// The half of the v4.11.6 fix that never reached the updater.
//
// msedge-tts declares `preinstall: npx only-allow pnpm` — a guard whose entire
// purpose is to fail the install unless the caller is pnpm. On most machines npx
// quietly satisfies it. On one where %APPDATA%\npm does not exist — that folder
// appears only once something is installed globally, and cleanup tools remove it
// — npx itself dies with ENOENT, the preinstall fails, and npm aborts the whole
// tree.
//
// v4.11.6 answered that with `npm install --ignore-scripts` in install.ps1, and
// update-apply.ps1 kept running plain `npm install`. So on exactly those machines
// a fresh install worked while every self-update failed at that one step and
// rolled back cleanly — which made a shipped bug look like a problem with one
// person's PC. Reported on Discord as "dependency installation failed".
//
// The two scripts have to make the same pair of moves, because --ignore-scripts
// also skips OUR postinstall.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APPLY = readFileSync(new URL('../update-apply.ps1', import.meta.url), 'utf8');
const INSTALL = readFileSync(new URL('../install.ps1', import.meta.url), 'utf8');
const PKG = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

// If msedge-tts ever leaves, this whole dance can go — and this test says so
// rather than quietly passing on a premise that no longer holds.
test('the dependency this exists for is still in the tree', () => {
  const deps = Object.assign({}, PKG.dependencies, PKG.devDependencies);
  assert.ok(deps['msedge-tts'], 'msedge-tts is still a dependency — the guard still applies');
});

test('the updater installs the way the installer does', () => {
  const invoke = APPLY.slice(APPLY.indexOf('function Invoke-Npm {'));
  const body = invoke.slice(0, invoke.indexOf('\n}\n'));
  assert.match(body, /'install', '--ignore-scripts'/, "the updater carries --ignore-scripts");
  assert.match(INSTALL, /'install', '--ignore-scripts'/, 'and so does the installer, still');
});

// --ignore-scripts skips our own postinstall too, which is what builds
// server\shared. The installer pairs the flag with a link step; so must this.
test('skipping scripts is paired with the link step it skips', () => {
  const fn = APPLY.slice(APPLY.indexOf('function Restore-SharedLinks {'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /tools\\link-shared\.mjs/, 'it runs the link script');
  assert.match(body, /if \(-not \$nodeExe\)/, 'and gives up quietly when node is not on PATH');
  assert.match(body, /catch \{ Log/, 'a failure is logged, never thrown');
  // Called on the success path, right after the install it completes.
  const seq = APPLY.slice(APPLY.indexOf("Log 'npm install done'"));
  assert.match(seq.slice(0, 120), /Restore-SharedLinks/, 'called after a successful install');
});

// Best-effort is only safe because the engine repairs the link itself at boot.
test('the link step is allowed to fail because the server re-creates it', () => {
  const SERVER = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(SERVER, /function ensureSharedLink\(\)/, 'the boot-time repair still exists');
});

// PowerShell files must stay ASCII — a code page must not change how they parse.
test('the applier is still pure ASCII', () => {
  const bad = APPLY.split('\n').findIndex((l) => /[^\x00-\x7F]/.test(l));
  assert.equal(bad, -1, bad >= 0 ? 'non-ASCII on line ' + (bad + 1) : '');
});
