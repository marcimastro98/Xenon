// server/perf-stream.js: the `perf` SSE behind the Game performance tile. It
// must cost nothing when no game runs or nothing shows it, and must tell a tile
// once, at once, that the game ended.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPerfStream, snapshot, INTERVAL_MS, GRAPH_FRAMES } = require('../perf-stream.js');

function fakeFps(over = {}) {
  const state = { fps: 120, ...over };
  return {
    state,
    getFpsDetail: () => ({ fps: state.fps, displayFps: state.fps, presentFps: state.fps == null ? null : state.fps * 2 }),
    getFrameStats: () => (state.fps == null ? null : { process: 'Game.exe', avgFps: 118, low1Fps: 90, low01Fps: null, p99Ms: 12.34 }),
    getFrameWindow: (n) => { state.asked = n; return state.fps == null ? null : { side: 'display', frames: [8.333, 8.36, 16.71] }; },
  };
}

function rig({ wanted = true, clients = true, fps = fakeFps() } = {}) {
  const sent = [];
  const flags = { wanted, clients };
  const s = createPerfStream({ fps, wanted: () => flags.wanted, hasClients: () => flags.clients, broadcast: (p) => sent.push(p) });
  return { s, sent, flags, fps };
}

test('a reading carries the rate, the lows and a rounded graph window', () => {
  const fps = fakeFps();
  const r = snapshot(fps);
  assert.deepEqual(r, {
    active: true, process: 'Game.exe', fps: 120, displayFps: 120, presentFps: 240,
    avgFps: 118, low1Fps: 90, low01Fps: null, p99Ms: 12.34, frames: [8.3, 8.4, 16.7], bench: null, why: null, exclusive: false,
  });
  assert.equal(fps.state.asked, GRAPH_FRAMES);
});

test('no frame rate, or a backend that lacks a call or throws, is never a crash', () => {
  assert.deepEqual(snapshot(fakeFps({ fps: null })), { active: false });
  assert.deepEqual(snapshot(null), { active: false });
  assert.deepEqual(snapshot({ getFpsDetail: () => { throw new Error('boom'); } }), { active: false });
  // macOS stub / Linux without a window: rate yes, graph no.
  const r = snapshot({ getFpsDetail: () => ({ fps: 60 }) });
  assert.equal(r.active, true);
  assert.deepEqual(r.frames, []);
  assert.equal(r.low1Fps, null);
  assert.equal(r.process, '');
});

test('the timer runs only while gaming, and the end is said once', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { s, sent, fps } = rig();
  s.setGaming(true);
  assert.equal(s.running(), true);
  assert.equal(sent.length, 1, 'first reading at once, not after a tick');
  t.mock.timers.tick(INTERVAL_MS * 3);
  assert.equal(sent.length, 4);
  s.setGaming(true);
  t.mock.timers.tick(INTERVAL_MS);
  assert.equal(sent.length, 5, 'a repeated "on" never starts a second timer');
  fps.state.fps = null;
  t.mock.timers.tick(INTERVAL_MS);
  assert.deepEqual(sent.at(-1), { active: false });
  t.mock.timers.tick(INTERVAL_MS * 4);
  assert.equal(sent.length, 6, 'an idle reading is sent once, then nothing');
  s.setGaming(false);
  assert.equal(s.running(), false);
  assert.equal(sent.length, 6, 'already said: not repeated on stop');
});

test('stopping after live readings sends one { active: false }', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { s, sent } = rig();
  s.setGaming(true);
  s.setGaming(false);
  s.setGaming(false);
  assert.deepEqual(sent, [sent[0], { active: false }]);
  t.mock.timers.tick(INTERVAL_MS * 5);
  assert.equal(sent.length, 2, 'no tick after stop');
});

test('nobody listening or nothing showing it: no reading is even taken', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let reads = 0;
  const fps = { getFpsDetail: () => { reads++; return { fps: 60 }; } };
  const { s, sent, flags } = rig({ fps, clients: false });
  s.setGaming(true);
  t.mock.timers.tick(INTERVAL_MS * 4);
  flags.clients = true; flags.wanted = false;
  t.mock.timers.tick(INTERVAL_MS * 4);
  assert.equal(reads, 0);
  assert.equal(sent.length, 0);
  s.stop();
  assert.equal(s.running(), false);
});

test('server.js gates the stream, seeds GET /perf and stops it on shutdown', () => {
  const s = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(s, /_perfStream\.setGaming\(st\.gaming && perfWanted\(\)\)/);
  // A tile on a hidden surface (overlay shortcut) wants no feed.
  assert.match(s, /function perfWanted\(\) \{[\s\S]{0,400}w\.widget === 'perf' && !layers\.hidden\.includes\(w\.surface\)/);
  // A Store widget granted the `perf` stream keeps it running too.
  assert.match(s, /function perfWanted\(\) \{[\s\S]{0,600}return sdkStreamGranted\('perf'\);\n\}/);
  assert.match(s, /if \(sseClients\.size === 0\) \{\n\s+_perfStream\.setGaming\(false\);[\s\S]{0,400}?\n\s+return;\n\s+\}/);
  // The session log is fed by the same tick, before the payload is built.
  assert.match(s, /_gameSessions\.tick\(\{ running: st\.gameRunning, game: st\.gameProcess \}\)/);
  assert.match(s, /reqPath === '\/perf' && req\.method === 'GET'\) \{[\s\S]{0,120}json\(_perfStream\.snapshot\(\)\)/);
  const shutdown = s.slice(s.indexOf('function _gracefulShutdown'));
  assert.match(shutdown.slice(0, 6000), /_perfStream\.stop\(\);/);
  assert.doesNotMatch(s, /CSRF_MUTATION_PATHS[^\n]*'\/perf'/, 'a read, not a mutation');
});

test('an idle reading carries the last game, and a closed session is told at once', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const sent = [];
  const flags = { last: { game: 'g', avgFps: 90 } };
  const fps = fakeFps({ fps: null });
  const s = createPerfStream({ fps, wanted: () => true, hasClients: () => true, broadcast: (p) => sent.push(p), last: () => flags.last });
  assert.deepEqual(s.snapshot(), { active: false, last: { game: 'g', avgFps: 90 } });
  s.sessionEnded();
  assert.deepEqual(sent, [{ active: false, last: { game: 'g', avgFps: 90 } }]);
  fps.state.fps = 120;
  s.setGaming(true);
  const n = sent.length;
  s.sessionEnded();
  assert.equal(sent.length, n, 'a live tile is not interrupted');
  fps.state.fps = null;
  flags.last = null;
  s.setGaming(false);
  assert.deepEqual(sent.at(-1), { active: false, last: null });
  const broken = createPerfStream({ fps, wanted: () => true, hasClients: () => true, broadcast: () => {}, last: () => { throw new Error('x'); } });
  assert.deepEqual(broken.snapshot(), { active: false, last: null });
});

test('a live reading says a benchmark is recording, and for how long', () => {
  const fps = fakeFps();
  assert.deepEqual(snapshot(fps, null, () => ({ running: true, game: 'g', elapsedS: 12 })).bench, { elapsedS: 12 });
  assert.equal(snapshot(fps, null, () => ({ running: false })).bench, null);
  assert.equal(snapshot(fps, null, () => { throw new Error('x'); }).bench, null);
  assert.equal(snapshot(fps).bench, null);
  assert.equal(snapshot(fakeFps({ fps: null }), null, () => ({ running: true, elapsedS: 1 })).bench, undefined, 'idle carries no benchmark');
  const s = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(s, /bench: \(\) => _benchmark\.status\(\)/);
  const shutdown = s.slice(s.indexOf('function _gracefulShutdown'));
  assert.match(shutdown.slice(0, 6000), /_benchmark\.flush\(\)/, 'a run in progress is saved on shutdown');
});

test('widgets get the perf stream: relayed on both pages, every field documented', () => {
  const main = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  assert.match(main, /es\.addEventListener\('perf', e => \{[\s\S]{0,300}window\.CustomWidget\.onData\('perf', d\)/);
  // Layer windows and the "widgets only" host share one relay table.
  const feed = readFileSync(new URL('../js/widget-feed.js', import.meta.url), 'utf8');
  assert.match(feed, /PLAIN_STREAMS = Object\.freeze\(\{[\s\S]*?perf: 'perf'/);
  const doc = readFileSync(new URL('../../docs/WIDGET_SDK.md', import.meta.url), 'utf8');
  const sec = doc.slice(doc.indexOf('### 3c-ter.'), doc.indexOf('### 3d.'));
  assert.match(sec, /m\.stream === 'perf'/);
  const live = snapshot(fakeFps());
  assert.equal(live.active, true);
  for (const k of Object.keys(live).filter(k => k !== 'active')) assert.match(sec, new RegExp('d\\.' + k + '\\b'), 'documented: ' + k);
});

test('a game that runs but whose frames cannot be read is named once, with whether the reader is installed', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const sent = [];
  const fps = { ...fakeFps({ fps: null }), isAvailable: () => false };
  const g = { name: 'Game.exe' };
  const s = createPerfStream({ fps, wanted: () => true, hasClients: () => true, broadcast: (p) => sent.push(p), game: () => g.name });
  assert.deepEqual(s.snapshot(), { active: false, game: 'Game.exe', reader: false });
  s.setGaming(true);
  t.mock.timers.tick(INTERVAL_MS * 4);
  assert.deepEqual(sent, [{ active: false, game: 'Game.exe', reader: false }], 'said once, not four times a second');
  fps.state.fps = 120;
  t.mock.timers.tick(INTERVAL_MS);
  assert.equal(sent.at(-1).active, true);
  fps.state.fps = null;
  t.mock.timers.tick(INTERVAL_MS);
  assert.deepEqual(sent.at(-1), { active: false, game: 'Game.exe', reader: false });
  g.name = '';
  t.mock.timers.tick(INTERVAL_MS);
  assert.deepEqual(sent.at(-1), { active: false }, 'the game closed: the plain idle reading');
  const n = sent.length;
  s.setGaming(false);
  assert.equal(sent.length, n, 'already idle: nothing more on stop');
  // With the reader installed, `reader` is left out.
  const ok = createPerfStream({ fps: { ...fps, isAvailable: () => true }, wanted: () => true, hasClients: () => true, broadcast: () => {}, game: () => 'Game.exe' });
  assert.deepEqual(ok.snapshot(), { active: false, game: 'Game.exe' });
});
