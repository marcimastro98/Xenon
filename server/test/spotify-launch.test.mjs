import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

// The Spotify tile starts the closed desktop app and plays on the PC in one tap,
// minimized when the user asked and the platform can. Asked for on Discord.

const require = createRequire(import.meta.url);
const L = require('../spotify-launch.js');

const WIN_EXE = 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\Spotify.exe';

test('Windows runs Spotify.exe itself, with --minimized only when asked', () => {
  assert.deepEqual(L.launchPlan('win32', true, WIN_EXE), { cmd: WIN_EXE, args: ['--minimized'], direct: true, minimized: true });
  assert.deepEqual(L.launchPlan('win32', false, WIN_EXE), { cmd: WIN_EXE, args: [], direct: true, minimized: false });
});

test('Windows without Spotify.exe opens the spotify: link, never minimized', () => {
  const plan = L.launchPlan('win32', true, '');
  assert.equal(plan.cmd, 'powershell.exe');
  assert.equal(plan.direct, false);
  assert.equal(plan.minimized, false);
  assert.ok(plan.args.some((a) => a.includes("FileName='spotify:'")));
});

test('macOS uses open, hidden and in the background when minimized', () => {
  assert.deepEqual(L.launchPlan('darwin', true, ''), { cmd: '/usr/bin/open', args: ['-g', '-j', '-a', 'Spotify'], direct: false, minimized: true });
  assert.deepEqual(L.launchPlan('darwin', false, '').args, ['-a', 'Spotify']);
});

test('Linux opens the spotify: link and never claims minimized', () => {
  assert.deepEqual(L.launchPlan('linux', true, ''), { cmd: 'xdg-open', args: ['spotify:'], direct: false, minimized: false });
  assert.equal(L.canStartMinimizedOn('linux', ''), false);
  assert.equal(L.canStartMinimizedOn('darwin', ''), true);
  assert.equal(L.canStartMinimizedOn('win32', WIN_EXE), true);
  assert.equal(L.canStartMinimizedOn('win32', ''), false);
});

test('findWindowsExe prefers the classic install, then the Store alias', async () => {
  const env = { APPDATA: 'C:\\A', LOCALAPPDATA: 'C:\\L' };
  const present = (set) => async (p) => { if (!set.has(p)) throw new Error('ENOENT'); };
  const classic = 'C:\\A\\Spotify\\Spotify.exe';
  const store = 'C:\\L\\Microsoft\\WindowsApps\\Spotify.exe';
  assert.equal(await L.findWindowsExe(env, present(new Set([classic, store]))), classic);
  assert.equal(await L.findWindowsExe(env, present(new Set([store]))), store);
  assert.equal(await L.findWindowsExe(env, present(new Set())), '');
  assert.equal(await L.findWindowsExe({}, present(new Set([classic]))), '');
});

function fakeSpawn(script) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.unref = () => {};
    calls.push({ cmd, args, opts });
    setImmediate(() => script(child));
    return child;
  };
  fn.calls = calls;
  return fn;
}

test('runPlan: Spotify itself counts as started once it spawns, with its window not hidden', async () => {
  const spawnFn = fakeSpawn((c) => c.emit('spawn'));
  const r = await L.runPlan({ cmd: WIN_EXE, args: ['--minimized'], direct: true, minimized: true }, spawnFn);
  assert.deepEqual(r, { ok: true, minimized: true });
  assert.equal(spawnFn.calls[0].opts.windowsHide, false);
  assert.equal(spawnFn.calls[0].opts.detached, true);
});

test('runPlan: an opener reports through its exit code', async () => {
  const plan = { cmd: 'xdg-open', args: ['spotify:'], direct: false, minimized: false };
  assert.deepEqual(await L.runPlan(plan, fakeSpawn((c) => c.emit('exit', 0))), { ok: true, minimized: false });
  assert.deepEqual(await L.runPlan(plan, fakeSpawn((c) => c.emit('exit', 4))), { ok: false, error: 'launch_failed' });
});

test('runPlan: a missing command is a failure, not a crash', async () => {
  const plan = { cmd: 'xdg-open', args: ['spotify:'], direct: false, minimized: false };
  const r = await L.runPlan(plan, fakeSpawn((c) => c.emit('error', Object.assign(new Error('nope'), { code: 'ENOENT' }))));
  assert.deepEqual(r, { ok: false, error: 'launch_failed' });
  const throwing = () => { throw new Error('spawn EINVAL'); };
  assert.deepEqual(await L.runPlan(plan, throwing), { ok: false, error: 'launch_failed' });
});

test('runPlan: an opener still running after the settle time is left alone and counts as started', async () => {
  let killed = false;
  const spawnFn = fakeSpawn((c) => { c.kill = () => { killed = true; }; });
  const r = await L.runPlan({ cmd: 'xdg-open', args: ['spotify:'], direct: false, minimized: false }, spawnFn, 10);
  assert.deepEqual(r, { ok: true, minimized: false });
  assert.equal(killed, false);
});
