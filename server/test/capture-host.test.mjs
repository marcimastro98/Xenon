// capture-host.js: the capture engine's process. Pinned here: it starts on the
// first request with an argv (never a shell), answers are matched by id even
// out of order, a stuck request is killed, an engine that keeps dying is left
// alone instead of respawned in a loop, an idle exit is not a crash, and stop()
// leaves nothing running or waiting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const { createCaptureHost, CRASH_LIMIT, CRASH_WINDOW_MS } = require('../capture-host.js');

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stdin = new EventEmitter();
  child.written = [];
  child.stdin.write = (s) => { child.written.push(JSON.parse(s)); return true; };
  child.stdin.end = () => {};
  child.killed = false;
  child.kill = () => { child.killed = true; child.emit('exit', null); };
  child.reply = (obj) => child.stdout.emit('data', JSON.stringify(obj) + '\n');
  return child;
}

function setup({ platform = 'win32', exists = true } = {}) {
  const spawned = [];
  let clock = 1000;
  const timers = [];
  const host = createCaptureHost({
    exe: 'C:\\x\\xenon-capture.exe', platform,
    existsSync: () => exists,
    spawn: (exe, args, opts) => { const c = fakeChild(); spawned.push({ exe, args, opts, c }); return c; },
    now: () => clock,
    timers: {
      setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
      clearTimeout: (t) => { if (t) t.cleared = true; },
    },
  });
  return { host, spawned, timers, advance: (ms) => { clock += ms; } };
}

test('on an OS without an engine, or without the engine file, nothing is spawned', async () => {
  for (const s of [setup({ platform: 'freebsd' }), setup({ exists: false })]) {
    assert.equal(s.host.available(), false);
    assert.deepEqual(await s.host.request('ping'), { ok: false, error: 'unavailable' });
    assert.equal(s.spawned.length, 0);
  }
});

test('the first request starts the engine with an argv, hidden, and later ones reuse it', async () => {
  const { host, spawned } = setup();
  const p1 = host.request('ping');
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].args, ['serve']);
  assert.equal(spawned[0].opts.windowsHide, true);
  assert.equal(spawned[0].opts.shell, undefined, 'never a shell');
  const p2 = host.request('monitors');
  assert.equal(spawned.length, 1);
  const [a, b] = spawned[0].c.written;
  assert.equal(a.cmd, 'ping');
  // Out of order, split across chunks: still matched by id.
  const line = JSON.stringify({ id: b.id, ok: true, monitors: [] }) + '\n';
  spawned[0].c.stdout.emit('data', line.slice(0, 5));
  spawned[0].c.stdout.emit('data', line.slice(5));
  spawned[0].c.reply({ id: a.id, ok: true, version: '0.1.0' });
  assert.deepEqual(await p2, { id: b.id, ok: true, monitors: [] });
  assert.equal((await p1).version, '0.1.0');
  assert.equal(host.running(), true);
});

test('the request body cannot override the id or the command', async () => {
  const { host, spawned } = setup();
  const p = host.request('screenshot', { id: 999, cmd: 'evil', path: 'C:\\a.png' });
  const w = spawned[0].c.written[0];
  assert.equal(w.cmd, 'screenshot');
  assert.notEqual(w.id, 999);
  spawned[0].c.reply({ id: w.id, ok: true });
  await p;
});

test('garbage and unknown ids on stdout are ignored', async () => {
  const { host, spawned } = setup();
  const p = host.request('ping');
  const c = spawned[0].c;
  c.stdout.emit('data', 'not json\n{"id":"x"}\n{"id":12345,"ok":true}\n');
  c.reply({ id: c.written[0].id, ok: true, version: '1' });
  assert.equal((await p).version, '1');
});

test('a request with no answer in time is failed and the engine killed', async () => {
  const { host, spawned, timers } = setup();
  const p = host.request('screenshot', {}, { timeoutMs: 50 });
  assert.equal(timers[0].ms, 50);
  timers[0].fn();
  assert.deepEqual(await p, { ok: false, error: 'timeout' });
  assert.equal(spawned[0].c.killed, true);
  assert.equal(host.running(), false);
  // The next request starts a fresh engine.
  host.request('ping');
  assert.equal(spawned.length, 2);
});

test('an idle exit is not a crash; dying with work waiting is, and three in a minute stop respawns', async () => {
  const { host, spawned, advance } = setup();
  // Idle exits: many, never "failing".
  for (let i = 0; i < CRASH_LIMIT + 2; i++) {
    const p = host.request('ping');
    const c = spawned[spawned.length - 1].c;
    c.reply({ id: c.written[0].id, ok: true });
    await p;
    c.emit('exit', 0);
  }
  // Crashes with a request pending.
  for (let i = 0; i < CRASH_LIMIT; i++) {
    const p = host.request('screenshot');
    spawned[spawned.length - 1].c.emit('exit', 3221225477);
    assert.deepEqual(await p, { ok: false, error: 'engine_exited' });
  }
  const before = spawned.length;
  assert.deepEqual(await host.request('ping'), { ok: false, error: 'engine_failing' });
  assert.equal(spawned.length, before, 'not respawned');
  advance(CRASH_WINDOW_MS + 1);
  host.request('ping');
  assert.equal(spawned.length, before + 1, 'tried again after the window');
});

test('a spawn that throws is an error, not a crash of the server', async () => {
  const host = createCaptureHost({
    exe: 'x.exe', platform: 'win32', existsSync: () => true,
    spawn: () => { throw new Error('EACCES'); },
  });
  assert.deepEqual(await host.request('ping'), { ok: false, error: 'engine_exited' });
});

test('stop() answers what is waiting, kills the engine and refuses new work', async () => {
  const { host, spawned } = setup();
  const p = host.request('screenshot');
  host.stop();
  assert.deepEqual(await p, { ok: false, error: 'stopped' });
  assert.equal(spawned[0].c.killed, true);
  assert.deepEqual(await host.request('ping'), { ok: false, error: 'stopped' });
  assert.equal(spawned.length, 1);
});

test('lines without an id are events for the listeners; an engine exit is one too', async () => {
  const { host, spawned } = setup();
  const events = [];
  const off = host.onEvent((e) => events.push(e));
  host.onEvent(() => { throw new Error('a bad listener breaks nothing'); });
  const p = host.request('record_start', { target: 'screen' });
  const c = spawned[0].c;
  c.reply({ event: 'record_ended', reason: 'window_closed', frames: 3 });
  c.reply({ no: 'event' });
  c.reply({ id: c.written[0].id, ok: true });
  assert.equal((await p).ok, true);
  c.emit('exit', 0);
  assert.deepEqual(events, [
    { event: 'record_ended', reason: 'window_closed', frames: 3 },
    { event: 'engine_exited', code: 0 },
  ]);
  off();
  host.request('ping');
  spawned[1].c.reply({ event: 'record_ended' });
  assert.equal(events.length, 2, 'a removed listener hears nothing');
});

// What the engine can do. Each OS starts from its own list, so a feature the
// platform's engine lacks is hidden before the first ping; a ping reply then
// replaces the list (an older engine than the server knows), keeping only
// well-formed names.
test('has(): per-OS defaults, nothing at all without the engine or on Linux', () => {
  const { WINDOWS_FEATURES, MAC_FEATURES } = require('../capture-host.js');
  const win = setup().host;
  const mac = setup({ platform: 'darwin' }).host;
  for (const f of WINDOWS_FEATURES) assert.equal(win.has(f), true, f);
  for (const f of MAC_FEATURES) assert.equal(mac.has(f), true, f);
  for (const f of ['draw', 'badge']) assert.equal(mac.has(f), false, f);
  for (const f of ['sound', 'lapse', 'tuning', 'export', 'cover', 'inspect', 'measure', 'replay', 'webcam', 'steps']) assert.equal(mac.has(f), true, f);
  assert.equal(mac.available(), true);
  assert.equal(setup({ platform: 'linux' }).host.has('screenshot'), false);
  assert.equal(setup({ exists: false }).host.has('screenshot'), false);
});

test('has(): a ping reply sets the list; junk names, errors and other replies do not', async () => {
  const { host, spawned } = setup({ platform: 'darwin' });
  const p = host.request('ping');
  spawned[0].c.reply({ id: spawned[0].c.written[0].id, ok: true, version: '1', features: ['screenshot', 'ocr', 'Bad Name', 7, 'x'.repeat(40)] });
  await p;
  assert.equal(host.has('screenshot'), true);
  assert.equal(host.has('ocr'), true);
  assert.equal(host.has('record'), false, 'not in the reply');
  assert.equal(host.has('Bad Name'), false);
  // A non-ping reply carrying `features` is ignored.
  const q = host.request('monitors');
  spawned[0].c.reply({ id: spawned[0].c.written[1].id, ok: true, features: ['draw'] });
  await q;
  assert.equal(host.has('draw'), false);
  // A failed ping keeps what was learned.
  const r = host.request('ping');
  spawned[0].c.reply({ id: spawned[0].c.written[2].id, ok: false, error: 'x', features: [] });
  await r;
  assert.equal(host.has('screenshot'), true);
});

test('has(): a ping reply without a list (an old engine) keeps the defaults', async () => {
  const { host, spawned } = setup({ platform: 'darwin' });
  const p = host.request('ping');
  spawned[0].c.reply({ id: spawned[0].c.written[0].id, ok: true, version: '0' });
  await p;
  assert.equal(host.has('record'), true);
});

// The lists here mirror the engines' own (main.rs FEATURES for Windows,
// mac/mod.rs FEATURES for macOS): a feature added on one side only would be
// hidden on a PC that has it, or offered where it fails.
test('the feature lists match the Rust engines', async () => {
  const { readFileSync } = await import('node:fs');
  const { WINDOWS_FEATURES, MAC_FEATURES } = require('../capture-host.js');
  const rustList = (file) => {
    const src = readFileSync(new URL(`../../apps/capture/src/${file}`, import.meta.url), 'utf8');
    const m = /const FEATURES: &\[&str\] = &\[([^\]]+)\];/.exec(src);
    assert.ok(m, `${file} has a FEATURES list`);
    return [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
  };
  assert.deepEqual(rustList('main.rs'), [...WINDOWS_FEATURES]);
  assert.deepEqual(rustList('mac/mod.rs'), [...MAC_FEATURES]);
});

test('Linux knows nothing until its engine says which tools this session has', async () => {
  const { host, spawned } = setup({ platform: 'linux' });
  assert.equal(host.available(), true);
  assert.equal(host.has('screenshot'), false);
  // The first request of a fresh engine is preceded by a ping.
  const shot = host.request('screenshot', { target: 'screen' });
  const [ping, asked] = spawned[0].c.written;
  assert.equal(ping.cmd, 'ping');
  assert.equal(asked.cmd, 'screenshot');
  spawned[0].c.reply({ id: ping.id, ok: true, version: '1', features: ['screenshot', 'record'] });
  spawned[0].c.reply({ id: asked.id, ok: true });
  assert.deepEqual(await shot, { id: asked.id, ok: true });
  assert.equal(host.has('screenshot'), true);
  assert.equal(host.has('replay'), false);
  // A tool installed later shows up: the next engine is asked again.
  spawned[0].c.emit('exit', 0);
  host.request('monitors');
  assert.equal(spawned[1].c.written[0].cmd, 'ping');
  spawned[1].c.reply({ id: spawned[1].c.written[0].id, ok: true, features: ['screenshot', 'record', 'ocr'] });
  assert.equal(host.has('ocr'), true);
});

test('an explicit ping on Linux is not doubled, and Windows never pings by itself', async () => {
  const linux = setup({ platform: 'linux' });
  linux.host.request('ping');
  assert.deepEqual(linux.spawned[0].c.written.map((m) => m.cmd), ['ping']);
  const win = setup();
  win.host.request('monitors');
  assert.deepEqual(win.spawned[0].c.written.map((m) => m.cmd), ['monitors']);
});
