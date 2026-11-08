// server/game-sessions.js: one summary per game played, and the comparison the
// tile and Xenon AI read. Every frame counted once, short or empty sessions
// dropped, a bad file never a crash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createGameSessions, normalizeSession, compareSessions, widgetSnapshot, MAX_SESSIONS, MIN_SESSION_MS } = require('../game-sessions.js');

const MIN = 60 * 1000;

// A backend that hands out `frames` on each read, the way fpsmon's mark does.
function fakeFps() {
  const state = { queue: [], asked: [], rate: null, frames: true };
  return {
    state,
    getFramesSince(mark, game) {
      state.asked.push(game);
      if (!state.frames) return null;
      // Like fpsmon: the first read only sets the mark.
      const frames = mark ? state.queue.shift() || [] : [];
      return { mark: { n: (mark ? mark.n : 0) + 1 }, frames };
    },
    getCurrentFps: () => state.rate,
  };
}

function rig({ enabled = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gs-'));
  const file = join(dir, 'game-sessions.json');
  const clock = { t: 1_000_000 };
  const ended = [];
  const writes = [];
  const flags = { enabled };
  const fps = fakeFps();
  const logs = [];
  const gs = createGameSessions({
    fps, file,
    writeFileAtomic: async (f, body) => { writes.push(body); writeFileSync(f, body); },
    now: () => clock.t,
    enabled: () => flags.enabled,
    onEnd: (s) => ended.push(s),
    log: (line) => logs.push(line),
  });
  return { gs, fps, clock, ended, writes, file, dir, flags, logs };
}

const tenMs = n => new Array(n).fill(10);

test('a played game becomes one summary with its rate and lows', async () => {
  const { gs, fps, clock, ended, file } = rig();
  gs.tick({ running: true, game: 'Cyberpunk2077.exe' });
  for (let i = 0; i < 10; i++) {
    fps.state.queue.push(tenMs(200));
    clock.t += 30 * 1000;
    gs.tick({ running: true, game: 'cyberpunk2077' });
    gs.onSystem({ cpu: 40 + i, gpu: 90, cpuTemp: 60 + i, gpuTemp: 70 });
  }
  clock.t += 1000;
  gs.tick({ running: false, game: '' });
  await gs.flush();
  assert.equal(ended.length, 1);
  const s = ended[0];
  assert.equal(s.game, 'cyberpunk2077', 'one game, whatever case or .exe the tick carried');
  assert.equal(s.avgFps, 100);
  assert.equal(s.low1Fps, 100);
  assert.equal(s.low01Fps, 100);
  assert.equal(s.frames, 2000);
  assert.equal(s.cpuAvg, 44.5);
  assert.equal(s.cpuTempMax, 69);
  assert.equal(s.durationS, 301);
  assert.deepEqual(fps.state.asked.every(g => g === 'cyberpunk2077'), true, 'frames are read for the game, not the foreground');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.sessions.length, 1);
  assert.equal(saved.sessions[0].id, s.id);
});

test('a launcher blip or a game with no frame rate is not kept', async () => {
  const { gs, fps, clock, ended } = rig();
  gs.tick({ running: true, game: 'game' });
  fps.state.queue.push(tenMs(500));
  clock.t += MIN_SESSION_MS - 1000;
  gs.tick({ running: false });
  assert.equal(ended.length, 0, 'under two minutes');
  gs.tick({ running: true, game: 'game' });
  clock.t += 10 * MIN;
  gs.tick({ running: false });
  assert.equal(ended.length, 0, 'no frames at all (macOS has no frame rate)');
  assert.equal(gs.list().length, 0);
});

test('a game left out of the list says why in the log, once a minute at most', () => {
  const { gs, fps, clock, logs } = rig();
  gs.tick({ running: true, game: 'launcher' });
  clock.t += 5000;
  gs.tick({ running: false });
  assert.deepEqual(logs, [], 'a few seconds are not worth a line');

  gs.tick({ running: true, game: 'fc27' });
  clock.t += 10 * MIN;
  gs.tick({ running: false });
  assert.deepEqual(logs, ['[game-sessions] fc27: 600 s not kept, no frame rate was read']);

  gs.tick({ running: true, game: 'fc27' });
  fps.state.queue.push(tenMs(500));
  clock.t += 45 * 1000;
  gs.tick({ running: false });
  assert.equal(logs.length, 1, 'a game ending again within the minute adds nothing');

  gs.tick({ running: true, game: 'fc27' });
  clock.t += 90 * 1000;
  gs.tick({ running: false });
  assert.equal(logs[1], '[game-sessions] fc27: 90 s not kept, shorter than 2 min');
});

test('switching game closes the first session and opens the next', () => {
  const { gs, fps, clock, ended } = rig();
  gs.tick({ running: true, game: 'a' });
  fps.state.queue.push(tenMs(300));
  clock.t += 5 * MIN;
  gs.tick({ running: true, game: 'a' });
  gs.tick({ running: true, game: 'b' });
  assert.equal(ended.length, 1);
  assert.equal(ended[0].game, 'a');
  assert.equal(gs.isOpen(), true);
  gs.tick({ running: true, game: '' });
  assert.equal(ended.length, 1, 'a tick without a name is still the same game');
});

test('without single frames (Linux) the average comes from the reported rate, no lows', () => {
  const { gs, fps, clock, ended } = rig();
  fps.state.frames = false;
  gs.tick({ running: true, game: 'g' });
  for (const r of [60, 90, null, 120]) { fps.state.rate = r; clock.t += MIN; gs.tick({ running: true, game: 'g' }); }
  gs.tick({ running: false });
  assert.equal(ended[0].avgFps, 90);
  assert.equal(ended[0].low1Fps, null);
  assert.equal(ended[0].low01Fps, null);
  assert.equal(ended[0].frames, 0);
});

test('turned off: nothing opens, and a session in progress is dropped', () => {
  const { gs, fps, clock, ended, flags } = rig();
  gs.tick({ running: true, game: 'g' });
  fps.state.queue.push(tenMs(300));
  clock.t += 5 * MIN;
  flags.enabled = false;
  gs.tick({ running: true, game: 'g' });
  assert.equal(gs.isOpen(), false);
  flags.enabled = true;
  gs.tick({ running: false });
  assert.equal(ended.length, 0);
});

test('the comparison is against the previous session of the same game', () => {
  const mk = (game, start, avgFps, low1Fps = null) => normalizeSession({ game, start, end: start + 10 * MIN, avgFps, low1Fps });
  const list = [mk('a', 5e6, 130, 90), mk('b', 4e6, 60), mk('a', 3e6, 118, 95), mk('a', 2e6, 100)];
  const c = compareSessions(list, '');
  assert.equal(c.latest.avgFps, 130);
  assert.equal(c.previous.avgFps, 118);
  assert.equal(c.deltaAvgFps, 12);
  assert.equal(c.deltaLow1Fps, -5);
  assert.equal(c.deltaLow01Fps, null, 'no number when either side has none');
  assert.equal(compareSessions(list, 'B.exe').previous, null, 'a first session has nothing to compare');
  assert.equal(compareSessions(list, 'zzz'), null);
  assert.equal(compareSessions([], ''), null);
});

test('the tile reads the latest session with its difference', async () => {
  const { gs } = rig();
  const base = { end: 0 };
  await gs.importData([
    { ...base, game: 'a', start: 1e6, end: 1e6 + 6 * MIN, avgFps: 100 },
    { ...base, game: 'a', start: 3e6, end: 3e6 + 6 * MIN, avgFps: 112.3 },
  ]);
  const last = gs.last();
  assert.equal(last.avgFps, 112.3);
  assert.equal(last.deltaAvgFps, 12.3);
});

test('a bad file is set aside and junk rows are dropped', async () => {
  const { gs, file, dir } = rig();
  writeFileSync(file, '{not json');
  await gs.load();
  assert.equal(gs.list().length, 0);
  assert.ok(readdirSync(dir).some(f => f.includes('.corrupt-')), 'kept for inspection, not overwritten');

  const r2 = rig();
  writeFileSync(r2.file, JSON.stringify({ sessions: [
    null, 'x', { game: '', start: 1, end: 2, avgFps: 60 },
    { game: 'g', start: 5, end: 1, avgFps: 60 },
    { game: 'g', start: 1, end: 2, avgFps: NaN },
    { game: 'G.EXE', start: 1, end: 2, avgFps: 60, low1Fps: 'x', id: '<b>' },
  ] }));
  await r2.gs.load();
  const list = r2.gs.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].game, 'g');
  assert.equal(list[0].low1Fps, null);
  assert.match(list[0].id, /^gs_[a-z0-9]+$/);
});

test('the list is bounded, newest first, and clear empties it', async () => {
  const { gs, file } = rig();
  const rows = [];
  for (let i = 0; i < MAX_SESSIONS + 20; i++) rows.push({ game: 'g' + (i % 3), start: i * 1e6, end: i * 1e6 + 5 * MIN, avgFps: 60 + i });
  await gs.importData(rows);
  assert.equal(gs.exportData().length, MAX_SESSIONS);
  assert.equal(gs.list({ limit: 2 })[0].start, (MAX_SESSIONS + 19) * 1e6);
  assert.equal(gs.list({ limit: 999 }).length, MAX_SESSIONS);
  assert.ok(gs.list({ game: 'g1', limit: 50 }).every(s => s.game === 'g1'));
  assert.equal(await gs.importData('nope'), false);
  await gs.clear();
  assert.equal(gs.list().length, 0);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).sessions, []);
});

test('shutdown keeps a long enough session in progress', async () => {
  const { gs, fps, clock, file } = rig();
  gs.tick({ running: true, game: 'g' });
  fps.state.queue.push(tenMs(300));
  clock.t += 3 * MIN;
  gs.tick({ running: true, game: 'g' });
  await gs.flush();
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).sessions.length, 1);
});

const ON = { active: true, moved: 0 };
const OFF = { active: false, moved: 0 };

function playedGame(ticks) {
  const r = rig();
  ticks.forEach((perf) => {
    r.fps.state.queue.push(tenMs(300));
    r.clock.t += MIN;
    r.gs.tick({ running: true, game: 'g', perf });
  });
  r.gs.tick({ running: false });
  return r.ended[0];
}

test('a game played in a Performance session says so, with the apps it moved', () => {
  const s = playedGame([ON, { active: true, moved: 3 }, { active: true, moved: 1 }, ON]);
  assert.equal(s.perfMode, true);
  assert.equal(s.appsMoved, 3, 'the most at any moment: a moved app that closes still counted');
});

test('a session that covers only the end of a game does not take the credit', () => {
  assert.ok(!playedGame([OFF, OFF, OFF, ON]).perfMode);
  assert.ok(!playedGame([OFF, OFF, ON, ON]).perfMode, 'half is not most');
  assert.ok(playedGame([OFF, ON, ON, ON]).perfMode);
});

test('a game with no session has no tag at all', () => {
  const s = playedGame([OFF, OFF, OFF]);
  assert.ok(!('perfMode' in s) || s.perfMode === false);
  const r = rig();
  r.fps.state.queue.push(tenMs(300));
  r.gs.tick({ running: true, game: 'g' });
  r.clock.t += 4 * MIN;
  r.gs.tick({ running: true, game: 'g' });
  r.gs.tick({ running: false });
  assert.deepEqual(r.gs.list().map((x) => ('perfMode' in x)), [false], 'the old shape, on disk too');
});

test('the tag comes back from the file, and a bad one does not', async () => {
  const r = rig();
  const base = { game: 'g', end: 10, avgFps: 60 };
  writeFileSync(r.file, JSON.stringify({ sessions: [
    { ...base, start: 1, perfMode: true, appsMoved: 3 },
    { ...base, start: 2, perfMode: true, appsMoved: 5000 },
    { ...base, start: 3, perfMode: true, appsMoved: 'x' },
    { ...base, start: 4, perfMode: 'yes', appsMoved: 3 },
  ] }));
  await r.gs.load();
  const tags = r.gs.list().sort((a, b) => a.start - b.start).map((s) => [s.perfMode, s.appsMoved]);
  assert.deepEqual(tags, [[true, 3], [true, 99], [true, 0], [undefined, undefined]]);
});

test('the widget stream does not carry the tag', () => {
  const r = rig();
  r.fps.state.queue.push(tenMs(300));
  r.gs.tick({ running: true, game: 'g', perf: { active: true, moved: 2 } });
  r.clock.t += 4 * MIN;
  r.gs.tick({ running: true, game: 'g', perf: { active: true, moved: 2 } });
  r.gs.tick({ running: false });
  assert.equal(r.gs.list()[0].perfMode, true);
  const stream = widgetSnapshot(r.gs, { enabled: true });
  assert.ok(stream.sessions.length > 0);
  for (const session of stream.sessions) {
    assert.ok(!('perfMode' in session));
    assert.ok(!('appsMoved' in session));
  }
});
