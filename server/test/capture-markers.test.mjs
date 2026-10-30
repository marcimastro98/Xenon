// capture-markers.js: bookmarks and stutters on the capture timeline.
// Pinned here: a bookmark only while something records, two quick presses
// are one; stutters are read from fpsmon's frames on the status tick, never in
// a game's first seconds, one per stretch of trouble; a saved video takes the
// markers of its own span, in seconds from its start; a trim shifts them; the
// Deck/AI/SDK key and the gallery are wired.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const M = require('../capture-markers.js');
const { createRecorder } = require('../recorder.js');
const { createReplay } = require('../replay.js');
const { createCaptures } = require('../captures.js');
const { createCaptureGallery } = require('../capture-gallery.js');
const captureMarker = require('../capabilities/capture-marker.js');
const { CAPABILITIES } = require('../js/capability-catalog.js');
const sdk = require('../sdk-widgets.js');
const Model = require('../js/capture-gallery-model.js');
const { normalizeCaptureSettings } = require('../capture-settings.js');
const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const tick = () => new Promise(setImmediate);

const smooth = (n = 60) => Array.from({ length: n }, () => 16);

function rig({ active = true, autoMarks = true } = {}) {
  let t = 100000;
  let frames = [];
  let on = active;
  let auto = autoMarks;
  const reads = [];
  const fps = {
    getFramesSince: (mark, game) => {
      reads.push({ mark, game });
      const f = frames;
      frames = [];
      return { mark: (mark || 0) + 1, frames: f };
    },
  };
  const m = M.createCaptureMarkers({ fps, active: () => on, autoMarks: () => auto, now: () => t });
  return {
    m, reads,
    at: (ms) => { t = ms; },
    feed: (f) => { frames = f; },
    set: (o) => { if ('on' in o) on = o.on; if ('auto' in o) auto = o.auto; },
  };
}

test('spikeTimes: a frame three times the median (at least 50 ms), timed from the end', () => {
  const f = smooth();
  f[50] = 100;
  // Nine frames of 16 ms come after the spike.
  assert.deepEqual(M.spikeTimes(f, 10000), [10000 - 9 * 16]);
  assert.deepEqual(M.spikeTimes(smooth(), 10000), [], 'nothing stands out');
  const few = smooth(10);
  few[5] = 200;
  assert.deepEqual(M.spikeTimes(few, 10000), [], 'too few frames say nothing');
  const slow = Array.from({ length: 60 }, () => 40);
  slow[30] = 60;
  assert.deepEqual(M.spikeTimes(slow, 1000), [], 'under three times the median');
  const junk = smooth();
  junk[10] = NaN;
  junk[11] = -5;
  junk[12] = 90;
  assert.equal(M.spikeTimes(junk, 1000).length, 1, 'bad values are skipped');
});

test('a bookmark only while something records; two presses within a second are one', () => {
  const r = rig({ active: false });
  assert.deepEqual(r.m.mark(), { ok: false, error: 'not_recording' });
  r.set({ on: true });
  r.at(1000);
  assert.deepEqual(r.m.mark(), { ok: true });
  r.at(1500);
  assert.deepEqual(r.m.mark(), { ok: true, already: true });
  r.at(2600);
  assert.deepEqual(r.m.mark(), { ok: true });
  assert.deepEqual(r.m.between(0, 5000), [{ at: 1, kind: 'mark' }, { at: 2.6, kind: 'mark' }]);
});

test('stutters: not in the first 10 s of a game, then one per 20 s stretch', () => {
  const r = rig();
  const spikeAt = (t) => {
    const f = smooth();
    f[59] = 120;
    r.at(t);
    r.feed(f);
    r.m.tick({ running: true, game: 'Game.exe' });
  };
  r.at(0);
  r.m.tick({ running: true, game: 'Game.exe' }); // the game starts at 0
  spikeAt(5000);   // loading hitch: skipped
  spikeAt(15000);  // kept
  spikeAt(25000);  // 10 s later: the same stretch
  spikeAt(40000);  // kept
  assert.deepEqual(r.m.between(-1, 50000).map(m => [Math.round(m.at), m.kind]), [[15, 'stutter'], [40, 'stutter']]);
  assert.ok(r.reads.every(x => x.game === 'Game.exe'));
});

test('nothing is read without a game, a capture, or with automatic markers off', () => {
  const r = rig({ active: false });
  r.m.tick({ running: true, game: 'Game.exe' });
  r.set({ on: true, auto: false });
  r.m.tick({ running: true, game: 'Game.exe' });
  r.set({ auto: true });
  r.m.tick({ running: false, game: 'Game.exe' });
  r.m.tick({ running: true, game: '' });
  assert.equal(r.reads.length, 0);
  r.m.tick({ running: true, game: 'Game.exe' });
  assert.deepEqual(r.reads[0], { mark: null, game: 'Game.exe' }, 'a fresh mark after a pause');
  r.m.tick({ running: true, game: 'Other.exe' });
  assert.deepEqual(r.reads[1], { mark: null, game: 'Other.exe' }, 'a new game starts over');
  const broken = M.createCaptureMarkers({ fps: { getFramesSince: () => { throw new Error('x'); } }, active: () => true });
  assert.doesNotThrow(() => broken.tick({ running: true, game: 'G' }));
});

test('between: only the span, in seconds from its start, capped', () => {
  const r = rig();
  for (let i = 0; i < 150; i++) { r.at(10000 + i * 1500); r.m.mark(); }
  assert.deepEqual(r.m.between(10000, 13000), [{ at: 0, kind: 'mark' }, { at: 1.5, kind: 'mark' }, { at: 3, kind: 'mark' }]);
  assert.equal(r.m.between(0, 1e9).length, M.MAX_PER_CAPTURE);
  assert.deepEqual(r.m.between(5, 5), []);
  assert.deepEqual(r.m.between(NaN, 5), []);
});

test('normalizeMarkers and shiftMarkers keep only valid markers inside the video', () => {
  const list = [{ at: 3, kind: 'stutter' }, { at: 1.04, kind: 'mark' }, { at: 99, kind: 'mark' }, { at: -1, kind: 'mark' },
    { at: 2, kind: 'note' }, { at: 'x', kind: 'mark' }, null];
  assert.deepEqual(M.normalizeMarkers(list, 10), [{ at: 1, kind: 'mark' }, { at: 3, kind: 'stutter' }]);
  assert.deepEqual(M.normalizeMarkers('nope', 10), []);
  const shifted = M.shiftMarkers([{ at: 2, kind: 'mark' }, { at: 6, kind: 'stutter' }, { at: 20, kind: 'mark' }], 4, 12);
  assert.deepEqual(shifted, [{ at: 2, kind: 'stutter' }]);
});

test('a recording keeps the markers of its own span; a timelapse keeps none', async () => {
  const asked = [];
  const markers = { between: (a, b) => { asked.push([a, b]); return [{ at: 2, kind: 'mark' }]; } };
  const added = [];
  const host = {
    available: () => true,
    onEvent: () => () => {},
    request: (cmd) => Promise.resolve(cmd === 'record_start'
      ? { ok: true, width: 1, height: 1, fps: 60 }
      : { ok: true, reason: 'stopped', seconds: 12.5, frames: 750, bytes: 10 }),
  };
  const store = {
    plan: async ({ kind }) => ({ id: 'a'.repeat(16), dir: 'C:\\V', file: 'C:\\V\\x.mp4', name: 'x.mp4', kind }),
    prune: async () => ({ removed: 0 }),
    add: (e) => { added.push(e); return { id: e.id, kind: e.kind, name: 'x.mp4', seconds: e.seconds }; },
  };
  let clock = 1000;
  const rec = createRecorder({ host, store, markers, game: () => '', mkdir: async () => {}, exists: async () => true, now: () => clock });
  await rec.start({ target: 'screen' });
  clock = 20000;
  await rec.stop();
  assert.deepEqual(asked, [[1000, 1000 + 12500]]);
  assert.deepEqual(added[0].markers, [{ at: 2, kind: 'mark' }]);
  await rec.start({ target: 'screen', every: 2 });
  await rec.stop();
  assert.equal(added[1].markers, undefined, 'a timelapse plays faster than the clock');
});

test('a saved replay keeps the markers of the seconds it holds', async () => {
  const asked = [];
  const markers = { between: (a, b) => { asked.push([a, b]); return [{ at: 18, kind: 'stutter' }]; } };
  const listeners = new Set();
  const host = {
    available: () => true,
    onEvent: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    request: (cmd) => Promise.resolve(cmd === 'replay_start' ? { ok: true, width: 1, height: 1, fps: 60 } : { ok: true, queued: true }),
  };
  const added = [];
  const store = {
    plan: async ({ kind }) => ({ id: 'b'.repeat(16), dir: 'C:\\V', file: 'C:\\V\\r.mp4', name: 'r.mp4', kind }),
    prune: async () => ({ removed: 0 }),
    add: (e) => { added.push(e); return { id: e.id, kind: e.kind, name: 'r.mp4', seconds: e.seconds }; },
  };
  const replay = createReplay({
    host, store, markers, ringDir: 'C:\\T',
    timers: { setTimeout: () => ({}), clearTimeout: () => {} },
    options: () => ({ replay: true, replaySeconds: 30, replayWhen: 'always', replayAudio: 'sound', fps: 60, height: 0, quality: 'normal' }),
    gaming: () => false, game: () => '', mkdir: async () => {}, now: () => 50000,
  });
  await replay.sync();
  const p = replay.save({ seconds: 20 });
  await tick();
  await tick();
  for (const fn of listeners) fn({ event: 'replay_saved', token: 'b'.repeat(16), ok: true, seconds: 20 });
  const r = await p;
  assert.equal(r.ok, true);
  assert.deepEqual(asked, [[30000, 50000]]);
  assert.deepEqual(added[0].markers, [{ at: 18, kind: 'stutter' }]);
});

test('the index keeps markers on videos only; a trim shifts them to the copy', async () => {
  const ROOT = path.join(os.tmpdir(), 'marks');
  const disk = new Set();
  let n = 0;
  const store = createCaptures({
    file: path.join(ROOT, 'captures.json'), writeFileAtomic: async () => {}, picturesDir: async () => ROOT,
    exists: async (p) => disk.has(p), now: () => 1000, randomId: () => (++n).toString(16).padStart(16, '0'),
  });
  const listeners = new Set();
  const sent = [];
  const host = {
    available: () => true,
    onEvent: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    request: async (cmd, body) => { sent.push({ cmd, ...body }); return { ok: true, queued: true }; },
  };
  const gallery = createCaptureGallery({
    host, store, thumbDir: path.join(ROOT, 't'), mkdir: async () => {}, exists: async (p) => disk.has(p), unlink: async () => {},
  });
  const put = async (kind, extra) => {
    const p = await store.plan({ kind, game: '' });
    disk.add(p.file);
    return store.get(store.add({ id: p.id, kind, file: p.file, width: 1, height: 1, ...extra }).id);
  };
  const shot = await put('screenshot', { markers: [{ at: 1, kind: 'mark' }] });
  assert.equal(shot.markers, undefined);
  const v = await put('replay', { seconds: 30, markers: [{ at: 20, kind: 'mark' }, { at: 2, kind: 'mark' }, { at: 6, kind: 'stutter' }, { at: 45, kind: 'mark' }] });
  assert.deepEqual(v.markers, [{ at: 2, kind: 'mark' }, { at: 6, kind: 'stutter' }, { at: 20, kind: 'mark' }]);
  const none = await put('recording', { seconds: 5 });
  assert.equal('markers' in none, false, 'no list, no field');
  const p = gallery.trim(v.id, { start: 4.4, end: 12 });
  await tick();
  await tick();
  const job = sent.find(s => s.cmd === 'trim');
  for (const fn of listeners) fn({ event: 'trim_done', token: job.token, start: 4, seconds: 8.02 });
  const r = await p;
  assert.equal(r.ok, true);
  assert.deepEqual(r.entry.markers, [{ at: 2, kind: 'stutter' }]);
});

test('the key: unavailable without the engine, not_recording when idle, the time while recording', () => {
  const told = [];
  let log = { mark: () => ({ ok: true }) };
  const d = {
    capture: {
      host: { available: () => true },
      markers: () => log,
      recorder: () => ({ status: () => ({ on: true, since: 1000 }) }),
      onMarker: (m) => told.push(m),
    },
  };
  assert.deepEqual(captureMarker.run(d, {}, 6000), { ok: true, at: 5 });
  assert.deepEqual(told, [{ ok: true, at: 5 }]);
  d.capture.recorder = () => ({ status: () => ({ on: false }) });
  assert.deepEqual(captureMarker.run(d, {}, 6000), { ok: true }, 'Instant Replay has no time worth saying');
  log = { mark: () => ({ ok: true, already: true }) };
  assert.deepEqual(captureMarker.run(d, {}), { ok: true, already: true });
  assert.equal(told.length, 2, 'a repeated press is not told twice');
  log = { mark: () => ({ ok: false, error: 'not_recording' }) };
  assert.deepEqual(captureMarker.run(d, {}), { ok: false, error: 'not_recording' });
  const off = { capture: { host: { available: () => false }, markers: () => log } };
  assert.deepEqual(captureMarker.run(off, {}), { ok: false, error: 'unavailable' });
  assert.deepEqual(captureMarker.run({}, {}), { ok: false, error: 'unavailable' });
});

test('wired: catalog, AI, SDK capture lists, Deck error text, settings, live toasts', () => {
  const c = CAPABILITIES.find(x => x.type === 'captureMarker');
  assert.equal(c.capability.ai.name, 'add_capture_marker');
  assert.equal(c.capability.requires, 'captureVideo');
  assert.equal(c.capability.risk, 'sensitive');
  assert.match(read('capabilities/index.js'), /case 'captureMarker': return captureMarker\.run\(d, action\);/);
  assert.ok(sdk.SDK_ACTION_CATEGORIES.capture.includes('captureMarker'));
  assert.match(read('js/custom-widget.js'), /'screenMeasure', 'captureMarker'\]/);
  assert.match(read('js/deck-error-text.js'), /not_recording: \['deck_err_not_recording'/);
  assert.equal(normalizeCaptureSettings({}).autoMarks, true, 'on by default');
  assert.equal(normalizeCaptureSettings({ autoMarks: false }).autoMarks, false);
  assert.match(read('js/main.js'), /addEventListener\('capture_marker'/);
  assert.match(read('js/screen-alerts.js'), /capture_marker: \(d\) =>/);
  assert.match(read('index.html'), /id="settings-capture-automarks"/);
});

test('a recording keeps PresentMon reading with no dashboard connected', () => {
  // It pauses when the last SSE client leaves; without this hold a recording
  // started from a hotkey or the phone got no stutter markers at all.
  const s = read('server.js');
  assert.match(s, /if \(sseClients\.size > 0 \|\| _fpsHeldByCapture\)/);
  assert.match(s, /function holdFpsForMarkers\(\) \{\s*const hold = captureRunning\(\) && captureOptions\(\)\.autoMarks !== false;/);
  const tick = s.slice(s.indexOf('function broadcastStatusNow()'), s.indexOf('const j = JSON.stringify(st);'));
  assert.match(tick, /holdFpsForMarkers\(\); \} catch \{\}\n\s+if \(sseClients\.size === 0\)/, 'before both branches of the status tick');
});

test('the gallery shows your marks first when there are too many, then in time order', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ at: i, kind: 'stutter' })).concat([{ at: 30, kind: 'mark' }]);
  const shown = Model.marksOf({ kind: 'replay', markers: many });
  assert.equal(shown.length, Model.MARKS_SHOWN);
  assert.ok(shown.some(m => m.kind === 'mark'), 'the user mark survives the cap');
  assert.deepEqual(shown.map(m => m.at), shown.map(m => m.at).sort((a, b) => a - b));
  assert.deepEqual(Model.marksOf({ kind: 'replay' }), []);
  assert.equal(Model.seekFor(10), 10 - Model.MARK_LEAD_S);
  assert.equal(Model.seekFor(1), 0);
});
