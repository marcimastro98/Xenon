// server/benchmark.js: a frame-time recording of the running game, saved as a
// CSV. Pinned here: every frame lands once and in order, the file name can never
// leave its folder, a run ends by itself when the game does, a run too short to
// mean anything writes nothing, and the timer exists only while recording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createBenchmark, toCsv, fileNameFor, safeName, resolveDocumentsDir, POLL_MS, MAX_MS } = require('../benchmark.js');

// fpsmon's read-by-mark contract: the first read primes, later reads return
// what arrived since the mark.
function fakeFps() {
  const st = { frames: [], side: 'display', on: true, seen: true };
  return {
    st,
    getFramesSince(mark) {
      if (!st.on) return null;
      if (!st.seen) return { mark: null, frames: [] };
      const next = { side: st.side, total: st.frames.length };
      if (!mark || mark.side !== st.side) return { mark: next, frames: [] };
      return { mark: next, frames: st.frames.slice(mark.total) };
    },
  };
}

function fakeTimers() {
  const t = { fn: null, set: 0, cleared: 0 };
  t.setInterval = (fn) => { t.fn = fn; t.set++; return { id: t.set }; };
  t.clearInterval = () => { t.fn = null; t.cleared++; };
  return t;
}

function rig({ game = 'cyberpunk2077', writeFails = false, folder } = {}) {
  const fps = fakeFps();
  const timers = fakeTimers();
  const g = { name: game };
  const clock = { now: 1700000000000 };
  const writes = [];
  const dirs = [];
  const ended = [];
  const started = [];
  const b = createBenchmark({
    fps,
    game: () => g.name,
    documentsDir: async () => path.join('C:', 'Users', 'u', 'Documents'),
    mkdir: async (d) => { dirs.push(d); },
    writeFile: async (file, text) => { if (writeFails) throw new Error('disk full'); writes.push({ file, text }); },
    now: () => clock.now,
    timers,
    onStart: (s) => started.push(s),
    onEnd: (r) => ended.push(r),
    folder,
  });
  const frames = (n, ms = 8) => { for (let i = 0; i < n; i++) fps.st.frames.push(ms); };
  const tick = () => { clock.now += POLL_MS; if (timers.fn) timers.fn(); };
  return { b, fps, timers, g, clock, writes, dirs, ended, started, frames, tick };
}

test('the chosen folder holds the file; a vanished one falls back to Documents and says so', async () => {
  const run = async (folder) => {
    const r = rig({ folder });
    r.b.start();
    r.frames(500, 10); r.tick();
    return { r, res: await r.b.stop() };
  };
  const chosen = path.join('E:', 'Bench');
  const a = await run(async () => ({ dir: chosen }));
  assert.equal(a.r.dirs[0], chosen);
  assert.equal(a.res.folderMissing, undefined);
  assert.ok(!JSON.stringify(a.res).includes(chosen), 'never the folder on the wire');

  const docs = path.join('C:', 'Users', 'u', 'Documents', 'Xenon', 'Benchmark');
  const gone = await run(async () => ({ dir: '', missing: true }));
  assert.equal(gone.r.dirs[0], docs);
  assert.equal(gone.res.folderMissing, true);
  assert.equal(gone.r.ended[0].folderMissing, true, 'the toast hears it too');

  assert.equal((await run(async () => ({ dir: 'relative' }))).r.dirs[0], docs, 'a relative folder is ignored');
  assert.equal((await run(async () => { throw new Error('io'); })).res.ok, true, 'a failing check never loses the run');
});

test('a CSV carries PresentMon column names and a running time', () => {
  const csv = toCsv({ game: 'Game.exe', side: 'display', frames: [10, 20.25] });
  assert.equal(csv, 'Application,TimeInSeconds,MsBetweenDisplayChange\nGame.exe,0.010000,10.000\nGame.exe,0.030250,20.250\n');
  assert.match(toCsv({ game: 'g', side: 'present', frames: [] }), /^Application,TimeInSeconds,MsBetweenPresents\n$/);
  // The real process name stays readable; only what breaks a CSV field goes.
  assert.match(toCsv({ game: 'tabletop simulator', side: 'display', frames: [5] }), /\ntabletop simulator\.exe,/);
  assert.match(toCsv({ game: 'a,"b"\nc', side: 'display', frames: [5] }), /\na b c\.exe,0\.005000,5\.000\n$/);
});

test('a file name never leaves its folder', () => {
  assert.equal(safeName('..\\..\\Windows\\evil'), 'Windows_evil');
  assert.equal(safeName('a/b:c*?"<>|'), 'a_b_c_');
  assert.equal(safeName(''), 'game');
  assert.equal(safeName('...'), 'game');
  assert.equal(safeName('x'.repeat(200)).length, 60);
  const name = fileNameFor('cyberpunk2077', new Date(2026, 9, 26, 9, 5, 7).getTime());
  assert.equal(name, 'cyberpunk2077 2026-10-26 09-05-07.csv');
  assert.equal(path.basename(name), name);
});

test('start, frames, stop: every frame once, saved with its summary', async () => {
  const r = rig();
  r.frames(50);                                  // before the start: not counted
  assert.deepEqual(r.b.start(), { ok: true, running: true, game: 'cyberpunk2077' });
  assert.deepEqual(r.started, [{ game: 'cyberpunk2077' }]);
  assert.equal(r.timers.set, 1);
  r.frames(300, 10); r.tick();
  r.frames(200, 10); r.tick();
  r.tick();                                      // nothing new: nothing added
  assert.deepEqual(r.b.status(), { running: true, game: 'cyberpunk2077', elapsedS: 3 });
  const res = await r.b.stop();
  assert.equal(res.ok, true);
  assert.equal(res.frames, 500);
  assert.equal(res.avgFps, 100);
  assert.equal(res.low1Fps, 100);
  assert.equal(res.durationS, 3);
  assert.equal(res.reason, 'stopped');
  assert.equal(res.file, path.basename(r.writes[0].file), 'a name, never a path');
  assert.equal(r.dirs[0], path.join('C:', 'Users', 'u', 'Documents', 'Xenon', 'Benchmark'));
  assert.equal(path.dirname(r.writes[0].file), r.dirs[0]);
  assert.equal(r.writes[0].text.trim().split('\n').length, 501, 'header + 500 frames');
  assert.equal(r.b.lastFile(), r.writes[0].file);
  assert.equal(r.timers.cleared, 1, 'the timer is gone with the run');
  assert.deepEqual(r.ended, [res]);
  assert.deepEqual(r.b.status(), { running: false });
  assert.deepEqual(await r.b.stop(), { ok: false, error: 'not_running' });
});

test('no game, a second start, or no frame source: refused, nothing running', () => {
  const r = rig({ game: '' });
  assert.deepEqual(r.b.start(), { ok: false, error: 'no_game' });
  r.g.name = 'g';
  r.fps.st.on = false;
  assert.deepEqual(r.b.start(), { ok: false, error: 'no_frames' });
  assert.equal(r.timers.set, 0);
  r.fps.st.on = true;
  r.b.start();
  assert.deepEqual(r.b.start(), { ok: false, error: 'running', game: 'g' });
  assert.equal(r.timers.set, 1);
});

test('a game the frame source does not see is refused; one that draws nothing ends after a few seconds', async () => {
  const r = rig();
  r.fps.st.seen = false;
  assert.deepEqual(r.b.start(), { ok: false, error: 'no_frames' });
  assert.equal(r.timers.set, 0);
  r.fps.st.seen = true;
  assert.equal(r.b.start().ok, true);
  for (let i = 0; i < 4; i++) r.tick();
  assert.equal(r.b.status().running, true, 'still waiting for the first frames');
  r.tick();
  await r.b.flush();
  assert.deepEqual(r.ended, [{ ok: false, error: 'no_frames', game: 'cyberpunk2077' }]);
  assert.equal(r.writes.length, 0);
  assert.equal(r.timers.fn, null);
});

test('frames that stop mid-run (the game in the background) do not end it', async () => {
  const r = rig();
  r.b.start();
  r.frames(400); r.tick();
  for (let i = 0; i < 20; i++) r.tick();
  assert.equal(r.b.status().running, true);
  const res = await r.b.stop();
  assert.equal(res.ok, true);
  assert.equal(res.frames, 400);
});

test('the game closing or changing ends the run and saves it', async () => {
  const r = rig();
  r.b.start();
  r.frames(400); r.tick();
  r.g.name = '';
  r.tick();
  await r.b.flush();
  assert.equal(r.ended.length, 1);
  assert.equal(r.ended[0].reason, 'game_ended');
  assert.equal(r.ended[0].frames, 400);
  assert.equal(r.writes.length, 1);
  assert.equal(r.timers.fn, null);
});

test('too short to mean anything: nothing is written', async () => {
  const r = rig();
  r.b.start();
  r.frames(99); r.tick();
  const res = await r.b.stop();
  assert.deepEqual(res, { ok: false, error: 'too_short', game: 'cyberpunk2077' });
  assert.equal(r.writes.length, 0);
  assert.equal(r.b.lastFile(), '');
});

test('a failed write is said, not swallowed', async () => {
  const r = rig({ writeFails: true });
  r.b.start();
  r.frames(200); r.tick();
  const res = await r.b.stop();
  assert.deepEqual(res, { ok: false, error: 'write_failed', game: 'cyberpunk2077' });
  assert.deepEqual(r.b.status(), { running: false }, 'a failed save does not leave a run stuck');
});

test('stop twice at once ends once; toggle starts and stops; the time limit ends it', async () => {
  const r = rig();
  assert.equal((await r.b.toggle()).running, true);
  r.frames(200); r.tick();
  const [a, b] = [r.b.stop(), r.b.stop()];
  assert.equal(a, b);
  await a;
  assert.equal(r.writes.length, 1);
  assert.equal(r.ended.length, 1);

  const s = rig();
  s.b.start();
  s.frames(200);
  s.clock.now += MAX_MS;
  s.tick();
  await s.b.flush();
  assert.equal(s.ended[0].reason, 'limit');
});

test('frames from another side mid-run end it with what was measured', async () => {
  const r = rig();
  r.b.start();
  r.frames(200); r.tick();
  r.fps.st.side = 'present';
  r.tick();
  await r.b.flush();
  assert.equal(r.ended[0].reason, 'side_changed');
  assert.equal(r.ended[0].frames, 200);
});

test('Documents comes from the shell folders on Windows, the profile otherwise', async () => {
  const ok = (_f, _a, _o, cb) => cb(null, '\r\nHKEY_CURRENT_USER\\...\\Shell Folders\r\n    Personal    REG_SZ    D:\\OneDrive\\Documenti\r\n');
  assert.equal(await resolveDocumentsDir({ platform: 'win32', homedir: 'C:\\Users\\u', execFile: ok }), 'D:\\OneDrive\\Documenti');
  const fail = (_f, _a, _o, cb) => cb(new Error('no reg'));
  assert.equal(await resolveDocumentsDir({ platform: 'win32', homedir: 'C:\\Users\\u', execFile: fail }), path.join('C:\\Users\\u', 'Documents'));
  const junk = (_f, _a, _o, cb) => cb(null, 'Personal REG_SZ relative\\path');
  assert.equal(await resolveDocumentsDir({ platform: 'win32', homedir: 'C:\\Users\\u', execFile: junk }), path.join('C:\\Users\\u', 'Documents'));
  let called = false;
  assert.equal(await resolveDocumentsDir({ platform: 'linux', homedir: '/home/u', execFile: () => { called = true; } }), path.join('/home/u', 'Documents'));
  assert.equal(called, false);
});
