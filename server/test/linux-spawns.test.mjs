// What the Linux probes spawn, counted. Both run for as long as the server is up, so a
// process more or less here is a fixed cost on every Linux desktop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let calls = [];
let answer = () => '';
childProcess.execFile = (cmd, args, _options, callback) => {
  calls.push([cmd, ...args]);
  queueMicrotask(() => {
    try { callback(null, answer(cmd, args)); } catch (err) { callback(err, ''); }
  });
  return { on() {} };
};

const { createLinuxForeground } = require('../linux-foreground.js');
const collectors = require('../linux-collectors.js');

const ROOT_REPLY = [
  '_NET_ACTIVE_WINDOW(WINDOW): window id # 0x4200003',
  '_NET_CLIENT_LIST(WINDOW): window id # 0x1a00004, 0x4200003',
  '',
].join('\n');
const WINDOW_REPLY = [
  'WM_CLASS(STRING) = "game", "Game"',
  '_NET_WM_PID(CARDINAL) = 4242',
  '_NET_WM_STATE(ATOM) = _NET_WM_STATE_FULLSCREEN',
  '',
].join('\n');

function sampleOnce() {
  delete process.env.HYPRLAND_INSTANCE_SIGNATURE;
  delete process.env.SWAYSOCK;
  calls = [];
  return new Promise((resolve) => {
    const probe = createLinuxForeground({
      intervalMs: 60000,
      onSample(sample) { probe.stop(); resolve(sample); },
    });
    probe.start();
  });
}

test('a tick reads the root window once and the focused window once', async () => {
  answer = (_cmd, args) => (args[0] === '-root' ? ROOT_REPLY : WINDOW_REPLY);
  const sample = await sampleOnce();
  assert.deepEqual(calls, [
    ['xprop', '-root', '_NET_ACTIVE_WINDOW', '_NET_CLIENT_LIST'],
    ['xprop', '-id', '0x4200003', 'WM_CLASS', '_NET_WM_PID', '_NET_WM_STATE'],
  ]);
  assert.equal(sample.fullscreen, true);
  assert.equal(sample.pid, 4242);
});

test('no active window is nothing, not the first id of the client list', async () => {
  answer = () => '_NET_ACTIVE_WINDOW:  not found.\n_NET_CLIENT_LIST(WINDOW): window id # 0x1a00004, 0x4200003\n';
  const sample = await sampleOnce();
  assert.equal(calls.length, 1);
  assert.deepEqual(sample, { fullscreen: false, process: '', pid: 0 });
});

test('a focus proxy outside the client list stays opaque, in one read', async () => {
  answer = () => '_NET_ACTIVE_WINDOW(WINDOW): window id # 0x9900001\n_NET_CLIENT_LIST(WINDOW): window id # 0x1a00004\n';
  const sample = await sampleOnce();
  assert.equal(calls.length, 1);
  assert.deepEqual(sample, { fullscreen: false, process: '', pid: 0 });
});

test('an empty client list does not hide the focused window', async () => {
  answer = (_cmd, args) => (args[0] === '-root' ? '_NET_ACTIVE_WINDOW(WINDOW): window id # 0x4200003\n_NET_CLIENT_LIST:  not found.\n' : WINDOW_REPLY);
  const sample = await sampleOnce();
  assert.equal(calls.length, 2);
  assert.equal(sample.fullscreen, true);
});

test('a PC without nvidia-smi stops trying it for a while, then looks again', async (t) => {
  const missing = () => { throw Object.assign(new Error('spawn nvidia-smi ENOENT'), { code: 'ENOENT' }); };
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const tries = () => calls.filter(([cmd]) => cmd === 'nvidia-smi').length;
  calls = [];
  answer = missing;
  await collectors.gpu();
  await collectors.gpu();
  assert.equal(tries(), 1, 'one attempt, then the answer is remembered');
  now += 5 * 60 * 1000;
  answer = () => '37, 54, 2048, 8192, 1500, 7000, NVIDIA Test Card\n';
  const card = await collectors.gpu();
  assert.equal(tries(), 2, 'a driver installed later is found');
  assert.equal(card.gpu, 37);
  await collectors.gpu();
  assert.equal(tries(), 3, 'with a card it reads at every call');
});

test('nvidia-smi that fails for another reason is tried again at the next read', async (t) => {
  let now = 9_000_000;
  t.mock.method(Date, 'now', () => now);
  calls = [];
  answer = () => { throw Object.assign(new Error('exit 9'), { code: 9 }); };
  await collectors.gpu();
  await collectors.gpu();
  assert.equal(calls.filter(([cmd]) => cmd === 'nvidia-smi').length, 2);
  now += 1;
});

const gone = (name) => Object.assign(new Error(`spawn ${name} ENOENT`), { code: 'ENOENT' });

test('a desktop without xprop looks for it every five minutes, not at every sample', async (t) => {
  let now = 20_000_000;
  t.mock.method(Date, 'now', () => now);
  answer = (cmd) => { throw gone(cmd); };
  assert.deepEqual(await sampleOnce(), { process: '', pid: 0, fullscreen: false });
  assert.equal(calls.length, 1, 'one attempt');
  assert.deepEqual(await sampleOnce(), { process: '', pid: 0, fullscreen: false });
  assert.equal(calls.length, 0, 'the answer is remembered');
  now += 5 * 60 * 1000 - 1;
  await sampleOnce();
  assert.equal(calls.length, 0, 'still inside the wait');
  now += 1;
  answer = (_cmd, args) => (args[0] === '-root' ? ROOT_REPLY : WINDOW_REPLY);
  const sample = await sampleOnce();
  assert.equal(calls.length, 2, 'xprop installed later is found');
  assert.equal(sample.fullscreen, true);
  await sampleOnce();
  assert.equal(calls.length, 2, 'with xprop it reads at every sample');
});

test('xprop that fails for another reason is tried again at the next sample', async (t) => {
  t.mock.method(Date, 'now', () => 40_000_000);
  answer = () => { throw Object.assign(new Error('exit 1'), { code: 1 }); };
  await sampleOnce();
  assert.equal(calls.length, 1);
  await sampleOnce();
  assert.equal(calls.length, 1, 'a passing failure never pauses game detection');
});
