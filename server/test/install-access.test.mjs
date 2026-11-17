// An engine its own user cannot write (install-access.js, grant-install-access.ps1):
// the update asks for access once, on a tap, and only when staging really fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createInstallAccess, stagingReady, EXIT_DECLINED } = require('../install-access.js');
const { createSelfUpdate } = require('../self-update.js');

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(SERVER, 'grant-install-access.ps1');

/** A folder that turns writable only after a grant ran, like a Program Files install. */
function lockedFs({ unlockOnGrant = true } = {}) {
  const state = { locked: true };
  const fsImpl = {
    rmSync: () => {},
    mkdirSync: () => {},
    writeFileSync: () => { if (state.locked) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); },
    existsSync: (p) => String(p).endsWith('grant-install-access.ps1'),
  };
  return { fsImpl, state, unlockOnGrant };
}

/** A spawn that records its calls and exits with `code` (or never, or fails). */
function fakeSpawn(code, onRun) {
  const calls = [];
  const spawn = (file, args, opts) => {
    calls.push({ file, args, opts });
    if (code === 'throw') throw new Error('blocked');
    const handlers = {};
    setImmediate(() => {
      if (code === 'error') { handlers.error?.(new Error('ENOENT')); return; }
      if (code === 'never') return;
      onRun?.();
      handlers.exit?.(code);
    });
    return { on: (ev, cb) => { handlers[ev] = cb; } };
  };
  return { spawn, calls };
}

function access(fsImpl, spawn, extra) {
  return createInstallAccess({ root: 'C:\\Program Files (x86)\\Xenon', platform: 'win32', fsImpl, spawn, psExe: 'powershell.exe', ...extra });
}

test('a writable staging folder: no prompt, nothing spawned', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-access-'));
  try {
    const staging = path.join(dir, 'update');
    fs.mkdirSync(staging);
    fs.writeFileSync(path.join(staging, 'old.log'), 'x');
    const { spawn, calls } = fakeSpawn(0);
    await access(fs, spawn).ensureStaging(staging, [path.join(staging, 'download.zip')], true);
    assert.equal(calls.length, 0);
    assert.deepEqual(fs.readdirSync(staging), [], 'the old staging is cleared, as before');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a leftover the cleanup cannot remove makes staging not ready', () => {
  const fsImpl = { rmSync: (p) => { if (p === 'C:\\X\\update') throw new Error('EPERM'); }, mkdirSync: () => {}, writeFileSync: () => {}, existsSync: (p) => p.endsWith('download.zip') };
  assert.equal(stagingReady(fsImpl, 'C:\\X\\update', ['C:\\X\\update\\download.zip']), false);
  assert.equal(stagingReady(fsImpl, 'C:\\X\\update', []), true);
});

test('the automatic updater never asks: install_protected, nothing spawned', async () => {
  const { fsImpl } = lockedFs();
  const { spawn, calls } = fakeSpawn(0);
  await assert.rejects(access(fsImpl, spawn).ensureStaging('C:\\X\\update', [], false), /install_protected/);
  assert.equal(calls.length, 0);
});

test('off Windows there is no grant to run', async () => {
  const { fsImpl } = lockedFs();
  const { spawn, calls } = fakeSpawn(0);
  await assert.rejects(access(fsImpl, spawn, { platform: 'linux' }).ensureStaging('/x/update', [], true), /install_protected/);
  assert.equal(calls.length, 0);
});

test('a tap on a locked install runs the grant once, then stages', async () => {
  const { fsImpl, state } = lockedFs();
  const { spawn, calls } = fakeSpawn(0, () => { state.locked = false; });
  await access(fsImpl, spawn).ensureStaging('C:\\X\\update', [], true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'powershell.exe');
  assert.deepEqual(calls[0].args.slice(0, 4), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File']);
  assert.match(calls[0].args[4], /[\\/]server[\\/]grant-install-access\.ps1$/);
  assert.equal(calls[0].opts.windowsHide, false, 'the UAC prompt needs a window');
});

test('a declined prompt, a failed grant, a launch that fails and an unanswered prompt each say so', async () => {
  const cases = [[EXIT_DECLINED, /access_declined/], [1, /install_protected/], ['throw', /install_protected/], ['error', /install_protected/]];
  for (const [code, want] of cases) {
    const { fsImpl } = lockedFs();
    const { spawn } = fakeSpawn(code);
    await assert.rejects(access(fsImpl, spawn).ensureStaging('C:\\X\\update', [], true), want, String(code));
  }
  const { fsImpl } = lockedFs();
  const { spawn } = fakeSpawn('never');
  // A real prompt keeps the loop alive through its child; the fake holds nothing, and the
  // unref'd timeout alone lets Node 22 end the file before the answer comes.
  const keepAlive = setTimeout(() => {}, 5000);
  try {
    await assert.rejects(access(fsImpl, spawn, { timeoutMs: 20 }).ensureStaging('C:\\X\\update', [], true), /access_declined/);
  } finally { clearTimeout(keepAlive); }
});

test('a grant that reports success but leaves the folder locked is not trusted', async () => {
  const { fsImpl } = lockedFs();
  const { spawn } = fakeSpawn(0);
  await assert.rejects(access(fsImpl, spawn).ensureStaging('C:\\X\\update', [], true), /install_protected/);
});

test('self-update: only the Update tap may ask, and a refusal stops before any download', async () => {
  const seen = [];
  let fetched = 0;
  const installAccess = { ensureStaging: async (dir, leftovers, allowGrant) => { seen.push({ dir, leftovers, allowGrant }); throw new Error('access_declined'); } };
  const su = createSelfUpdate({ root: 'C:\\X', dataDir: 'C:\\X\\server\\data', installAccess, platform: 'win32', fetchImpl: async () => { fetched += 1; return { ok: false }; }, fsImpl: { existsSync: () => false } });
  await assert.rejects(su.prepare({ tag: 'v9.9.9', version: '9.9.9', allowGrant: true }), /access_declined/);
  await assert.rejects(su.prepare({ tag: 'v9.9.9', version: '9.9.9' }), /access_declined/);
  assert.deepEqual(seen.map((s) => s.allowGrant), [true, false]);
  assert.match(seen[0].dir, /[\\/]data[\\/]update$/);
  assert.deepEqual(seen[0].leftovers.map((p) => path.basename(p)), ['download.zip', '_extract', 'app']);
  assert.equal(fetched, 0);
});

test('the route lets the tap ask; a paired device cannot reach it', () => {
  const server = fs.readFileSync(path.join(SERVER, 'server.js'), 'utf8');
  assert.match(server, /selfUpdate\.prepare\(\{ tag: u\.tag, version: u\.latest, allowGrant: true \}\)/);
  assert.match(fs.readFileSync(path.join(SERVER, 'remote-access.js'), 'utf8'), /'\/update\/prepare',/);
  const auto = fs.readFileSync(path.join(SERVER, 'auto-update.js'), 'utf8');
  assert.doesNotMatch(auto, /allowGrant/, 'the automatic updater never raises a prompt');
});

test('the script stays ASCII, so Windows PowerShell 5.1 reads it right', () => {
  assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(fs.readFileSync(SCRIPT, 'utf8')));
});

const onWindows = process.platform === 'win32';
// Full paths: a Git Bash PATH puts a GNU whoami ahead of Windows' own.
const sys32 = (exe) => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', exe);

/** The elevated half, run for real on a throwaway folder this account owns. */
function runElevatedHalf(root, sid) {
  const r = spawnSync(sys32('WindowsPowerShell\\v1.0\\powershell.exe'), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'server', 'grant-install-access.ps1'), '-Elevated', '-Sid', sid],
    { windowsHide: true, encoding: 'utf8', timeout: 60000 });
  return r.status;
}

function mySid() {
  const out = spawnSync(sys32('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).stdout;
  return /"(S-1-[\d-]+)"/.exec(out)[1];
}

function fakeInstall(withServer) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-grant-'));
  fs.mkdirSync(path.join(root, 'server', 'data', 'update'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(root, 'server', 'grant-install-access.ps1'));
  if (withServer) fs.writeFileSync(path.join(root, 'server', 'server.js'), '');
  fs.writeFileSync(path.join(root, 'server', 'data', 'update', 'download.zip'), '');
  return root;
}

test('grant script: grants Modify on its own folder to the account it is given', { skip: !onWindows }, () => {
  const root = fakeInstall(true);
  try {
    const sid = mySid();
    assert.equal(runElevatedHalf(root, sid), 0);
    const acl = spawnSync(sys32('icacls.exe'), [path.join(root, 'server', 'data', 'update', 'download.zip')], { encoding: 'utf8', windowsHide: true }).stdout;
    const name = spawnSync(sys32('whoami.exe'), [], { encoding: 'utf8', windowsHide: true }).stdout.trim().toLowerCase();
    assert.ok(acl.toLowerCase().includes(`${name}:(i)(m)`) || acl.toLowerCase().includes(`${name}:(m)`), acl);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('grant script: refuses a group, a malformed id and a folder that is not Xenon', { skip: !onWindows }, () => {
  const root = fakeInstall(true);
  const bare = fakeInstall(false);
  try {
    assert.equal(runElevatedHalf(root, 'S-1-1-0'), 4, 'Everyone');
    assert.equal(runElevatedHalf(root, 'S-1-5-32-545'), 4, 'Users');
    assert.equal(runElevatedHalf(root, 'S-1-5-21-1;calc'), 4);
    assert.equal(runElevatedHalf(bare, mySid()), 5);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(bare, { recursive: true, force: true });
  }
});
