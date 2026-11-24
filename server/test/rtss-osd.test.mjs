import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { osdText } = require('../rtss/osd-text.js');
const { createOsdLoop, OWNER, IDLE_MS, LIVE_MS } = require('../rtss/osd-loop.js');

const SYS = { cpu: 41.6, cpuTemp: 62, gpu: 97, gpuTemp: 70, vramUsed: 12.34 * 1024 ** 3, vramTotal: 16 * 1024 ** 3, memory: { used: 20 * 1024 ** 3, total: 64 * 1024 ** 3 } };
const STATS = { avgFps: 125, low1Fps: 98.4, low01Fps: 71.2 };

test('the readings the tile shows, one line per group, named the way overlays name them', () => {
  const text = osdText({ hud: {}, fps: 143.6, stats: STATS, sys: SYS, net: null });
  assert.equal(text, '144 FPS  1% 98  0.1% 71  8.0 ms\nCPU 42%\nGPU 97% 70C');
});

test('in a row the groups share one line', () => {
  const text = osdText({ hud: { layout: 'row', cpuTemp: true, ram: true, ping: true }, fps: 60, stats: {}, sys: SYS, net: { ping: 12.4 } });
  assert.equal(text, '60 FPS  16.7 ms   CPU 42% 62C   GPU 97% 70C   RAM 20.0/64 GB  PING 12 ms');
});

test('only ASCII goes out: the PC reads it in its own code page', () => {
  const text = osdText({ hud: { cpuTemp: true }, fps: 60, stats: {}, sys: SYS, net: null, fahrenheit: true });
  assert.match(text, /CPU 42% 144F/);
  assert.match(text, /^[\x20-\x7e\n]*$/);
});

test('a reading without a value is left out, and nothing at all is an empty text', () => {
  assert.equal(osdText({ hud: {}, fps: null, stats: null, sys: null, net: null }), '');
  assert.equal(osdText({ hud: { vram: true }, fps: 90, stats: null, sys: { gpu: null }, net: null }), '90 FPS  11.1 ms');
  const none = { fps: false, low1: false, low01: false, frame: false, cpu: false, gpu: false, gpuTemp: false };
  assert.equal(osdText({ hud: none, fps: 90, stats: STATS, sys: SYS, net: null }), '');
});

// A loop driven by hand: `run()` fires the waiting timer and lets the tick finish.
function rig({ enabled = true, game = true, exclusive = true, text = '144 FPS', write = 'written', running = true } = {}) {
  const st = { enabled, game, exclusive, text, write, running, writes: [], releases: 0, opens: 0, wants: [], timer: null, delays: [] };
  const timers = {
    setTimeout: (fn, ms) => { st.timer = fn; st.delays.push(ms); return {}; },
    clearTimeout: () => { st.timer = null; },
  };
  const memory = {
    write: (owner, t) => { if (st.write instanceof Error) throw st.write; st.writes.push([owner, t]); return st.write; },
    release: () => { st.releases += 1; return 1; },
    running: () => { st.opens += 1; return st.running; },
  };
  const loop = createOsdLoop({
    memory, timers, enabled: () => st.enabled, gameRunning: () => st.game, exclusive: () => st.exclusive, text: async () => st.text,
    want: (on) => st.wants.push(on),
  });
  const run = async () => { const fn = st.timer; st.timer = null; await fn(); };
  return { loop, st, run };
}

test('over a game in exclusive full screen the readings are written once a second', async () => {
  const { loop, st, run } = rig();
  loop.start();
  await run();
  await run();
  assert.deepEqual(st.writes, [[OWNER, '144 FPS'], [OWNER, '144 FPS']]);
  assert.deepEqual(st.delays, [IDLE_MS, LIVE_MS, LIVE_MS]);
  assert.deepEqual(loop.state(), { running: true, showing: true });
  loop.stop();
});

test('in borderless the overlay window shows them: RivaTuner is not written, twice would double them', async () => {
  const { loop, st, run } = rig({ exclusive: false });
  loop.start();
  await run();
  assert.deepEqual(st.writes, []);
  assert.equal(st.releases, 1, 'only the stale slot check at start');
  assert.deepEqual(loop.state(), { running: true, showing: false });
  loop.stop();
});

test('leaving exclusive, closing the game or turning it off gives the slot back once', async () => {
  for (const change of [{ exclusive: false }, { game: false }, { enabled: false }]) {
    const { loop, st, run } = rig();
    loop.start();
    await run();
    const before = st.releases;
    Object.assign(st, change);
    await run();
    await run();
    assert.equal(st.releases, before + 1, JSON.stringify(change));
    assert.deepEqual(loop.state(), { running: true, showing: false });
    loop.stop();
    assert.equal(st.releases, before + 1, 'nothing left to give back at stop');
  }
});

test('a slot a crashed engine left goes back once the option reads on, even if the settings came late', async () => {
  // The engine starts the loop before it has read the settings: the option reads off at first.
  const { loop, st, run } = rig({ enabled: false, game: false });
  loop.start();
  assert.equal(st.releases, 0, 'nothing is opened at start');
  await run();
  assert.equal(st.releases, 0);
  st.enabled = true;
  await run();
  assert.equal(st.releases, 1, 'the leftover slot goes back on the first look with the option on');
  await run();
  st.enabled = false;
  await run();
  st.enabled = true;
  await run();
  assert.equal(st.releases, 1, 'once per engine, not on every switch');
  loop.stop();
});

test('with the option off nothing is opened, not even at start', async () => {
  const { loop, st, run } = rig({ enabled: false });
  loop.start();
  await run();
  assert.equal(st.releases, 0);
  assert.equal(st.opens, 0, 'not even to see whether RivaTuner is open');
  assert.deepEqual(st.writes, []);
  assert.deepEqual(st.wants, [], 'the frame reader is not asked for');
  assert.deepEqual(st.delays, [IDLE_MS, IDLE_MS]);
  loop.stop();
});

test('RivaTuner open asks for the frame reader before any game, and lets it go when it closes', async () => {
  const { loop, st, run } = rig({ game: false });
  loop.start();
  await run();
  assert.deepEqual(st.wants, [true], 'a game may refuse a trace that starts after it');
  await run();
  assert.deepEqual(st.wants, [true], 'told once, not every tick');
  st.running = false;
  await run();
  assert.deepEqual(st.wants, [true, false]);
  st.running = true;
  await run();
  st.enabled = false;
  await run();
  assert.deepEqual(st.wants, [true, false, true, false], 'turning the option off lets it go too');
  st.enabled = true;
  await run();
  loop.stop();
  assert.deepEqual(st.wants.at(-1), false, 'and so does the engine stopping');
});

test('drawing is true only while the slot holds the readings over a game', async () => {
  const { loop, st, run } = rig();
  assert.equal(loop.drawing(), false);
  loop.start();
  await run();
  assert.equal(loop.drawing(), true, 'the sensors keep being read for it, dashboard or not');
  st.exclusive = false;
  await run();
  assert.equal(loop.drawing(), false);
  st.exclusive = true;
  await run();
  loop.stop();
  assert.equal(loop.drawing(), false);
});

test('stopping the engine gives the slot back and ends the loop', async () => {
  const { loop, st, run } = rig();
  loop.start();
  await run();
  const before = st.releases;
  loop.stop();
  assert.equal(st.releases, before + 1);
  assert.equal(st.timer, null);
});

test('a tick still running when the engine stops does not write after it', async () => {
  const { loop, st } = rig();
  let finish;
  const slow = createOsdLoop({
    memory: { write: (o, t) => { st.writes.push([o, t]); return 'written'; }, release: () => { st.releases += 1; }, running: () => true },
    timers: { setTimeout: (fn) => { st.timer = fn; return {}; }, clearTimeout: () => {} },
    enabled: () => true, gameRunning: () => true, exclusive: () => true, text: () => new Promise((r) => { finish = r; }),
  });
  slow.start();
  const pending = st.timer();
  slow.stop();
  finish('late');
  await pending;
  assert.deepEqual(st.writes, []);
  loop.stop();
});

test('RivaTuner busy keeps the slot; RivaTuner gone or full lets it go', async () => {
  const busy = rig({ write: 'busy' });
  busy.loop.start();
  await busy.run();
  assert.equal(busy.loop.state().showing, false);
  busy.st.exclusive = false;
  await busy.run();
  assert.equal(busy.st.releases, 2, 'a busy slot is still ours to give back');
  busy.loop.stop();

  const gone = rig({ write: new Error('closed') });
  gone.loop.start();
  await gone.run();
  assert.equal(gone.st.timer !== null, true, 'the loop goes on');
  gone.loop.stop();
});
