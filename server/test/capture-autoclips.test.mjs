// capture-autoclips.js: clips Instant Replay saves by itself around a marked
// moment. Pinned here: 15 s before to 5 s after, moments close together share
// one clip up to 60 s, stutters only with 'all' and one clip per 2 minutes,
// nothing while a recording runs or the replay is off, a busy replay is
// retried, stop() cancels; the setting, the AI, the toast and the server are wired.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const A = require('../capture-autoclips.js');
const { applyCaptureChange, normalizeCaptureSettings } = require('../capture-settings.js');
const replayCap = require('../capabilities/replay.js');
const { createCaptureMarkers } = require('../capture-markers.js');

function rig({ mode = 'marks', on = true, recording = false, answers = [] } = {}) {
  let clock = 1_000_000;
  let timers = [];
  const saves = [];
  const state = { on, recording, mode };
  const replay = {
    status: () => ({ on: state.on }),
    save: async (o) => { saves.push({ ...o, at: clock }); return answers.shift() || { ok: true }; },
  };
  const clips = A.createAutoClips({
    replay, recording: () => state.recording, mode: () => state.mode, now: () => clock,
    timers: {
      setTimeout: (fn, ms) => { const t = { fn, at: clock + ms }; timers.push(t); return t; },
      clearTimeout: (t) => { timers = timers.filter(x => x !== t); },
    },
  });
  async function advance(ms) {
    const end = clock + ms;
    for (;;) {
      const due = timers.filter(t => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter(t => t !== due);
      clock = due.at;
      due.fn();
      await new Promise(r => setImmediate(r));
    }
    clock = end;
  }
  return { clips, saves, state, advance, now: () => clock, pending: () => timers.length };
}

test('a marked moment becomes a clip from 15 s before to 5 s after', async () => {
  const r = rig();
  r.clips.onMark({ t: r.now(), kind: 'mark' });
  await r.advance(4999);
  assert.equal(r.saves.length, 0);
  await r.advance(1);
  assert.deepEqual(r.saves.map(s => [s.seconds, s.auto]), [[20, 'mark']]);
  assert.equal(r.clips.waiting(), false);
});

test('moments close together share one clip, which never grows past 60 s', async () => {
  const r = rig();
  const t0 = r.now();
  r.clips.onMark({ t: t0, kind: 'mark' });
  await r.advance(3000);
  r.clips.onMark({ t: r.now(), kind: 'mark' });
  await r.advance(4000);
  assert.equal(r.saves.length, 0, 'the second mark pushed the end');
  await r.advance(1000);
  assert.deepEqual(r.saves.map(s => s.seconds), [23]);

  const q = rig();
  const s0 = q.now();
  q.clips.onMark({ t: s0, kind: 'mark' });
  for (let i = 0; i < 20; i++) { await q.advance(4000); q.clips.onMark({ t: q.now(), kind: 'mark' }); }
  // The first clip closes at 45 s past the first moment (60 s with the 15 before).
  assert.equal(q.saves[0].at - s0, 45000);
  assert.equal(q.saves[0].seconds, 60);
  await q.advance(10000);
  assert.equal(q.saves.length, 2, 'the moments past it get their own clip');
});

test('stutters make clips only with "all", one every 2 minutes', async () => {
  const r = rig();
  r.clips.onMark({ t: r.now(), kind: 'stutter' });
  await r.advance(10000);
  assert.equal(r.saves.length, 0, '"marks" ignores stutters');

  const a = rig({ mode: 'all' });
  a.clips.onMark({ t: a.now(), kind: 'stutter' });
  await a.advance(5000);
  assert.deepEqual(a.saves.map(s => s.auto), ['stutter']);
  await a.advance(30000);
  a.clips.onMark({ t: a.now(), kind: 'stutter' });
  await a.advance(10000);
  assert.equal(a.saves.length, 1, 'too soon after the last stutter clip');
  a.clips.onMark({ t: a.now(), kind: 'mark' });
  await a.advance(5000);
  assert.deepEqual(a.saves.map(s => s.auto), ['stutter', 'mark'], 'a mark is never held back');
  await a.advance(A.STUTTER_GAP_MS);
  a.clips.onMark({ t: a.now(), kind: 'stutter' });
  await a.advance(5000);
  assert.equal(a.saves.length, 3);
});

test('a stutter inside a marked clip makes it a marked clip', async () => {
  const r = rig({ mode: 'all' });
  r.clips.onMark({ t: r.now(), kind: 'stutter' });
  await r.advance(2000);
  r.clips.onMark({ t: r.now(), kind: 'mark' });
  await r.advance(5000);
  assert.deepEqual(r.saves.map(s => [s.auto, s.seconds]), [['mark', 22]]);
});

test('nothing while off, with the replay stopped or a recording running', async () => {
  for (const opts of [{ mode: 'off' }, { on: false }, { recording: true }]) {
    const r = rig(opts);
    r.clips.onMark({ t: r.now(), kind: 'mark' });
    await r.advance(10000);
    assert.equal(r.saves.length, 0, JSON.stringify(opts));
    assert.equal(r.pending(), 0, 'no timer left behind');
  }
  // The replay stops before the clip is due: dropped, no save.
  const r = rig();
  r.clips.onMark({ t: r.now(), kind: 'mark' });
  r.state.on = false;
  await r.advance(10000);
  assert.equal(r.saves.length, 0);
  assert.equal(r.clips.waiting(), false);
});

test('a busy replay is tried again, a clip that keeps meeting it is given up', async () => {
  const r = rig({ answers: [{ ok: false, error: 'saving' }, { ok: true }] });
  r.clips.onMark({ t: r.now(), kind: 'mark' });
  await r.advance(5000 + A.RETRY_MS);
  assert.equal(r.saves.length, 2);
  assert.equal(r.saves[1].seconds, 22, 'the retry still reaches 15 s before the moment');

  const busy = Array.from({ length: 10 }, () => ({ ok: false, error: 'saving' }));
  const b = rig({ answers: busy });
  b.clips.onMark({ t: b.now(), kind: 'mark' });
  await b.advance(60000);
  assert.equal(b.saves.length, A.MAX_TRIES);
  assert.equal(b.clips.waiting(), false);
});

test('moments during a save get the next clip; stop() cancels', async () => {
  let release;
  const r = rig();
  const slow = { status: () => ({ on: true }), save: (o) => { r.saves.push(o); return new Promise(res => { release = res; }); } };
  let clock = 0;
  const tq = [];
  const c = A.createAutoClips({
    replay: slow, now: () => clock,
    timers: { setTimeout: (fn, ms) => { const t = { fn, at: clock + ms }; tq.push(t); return t; }, clearTimeout: (t) => { const i = tq.indexOf(t); if (i >= 0) tq.splice(i, 1); } },
  });
  c.onMark({ t: 0, kind: 'mark' });
  clock = 5000; tq.shift().fn();
  c.onMark({ t: 6000, kind: 'mark' });
  assert.equal(tq.length, 0, 'held while the save runs');
  release({ ok: true });
  await new Promise(res => setImmediate(res));
  assert.equal(tq.length, 1, 'then its own clip');
  c.stop();
  assert.equal(c.waiting(), false);
  c.onMark({ t: 7000, kind: 'mark' });
  assert.equal(c.waiting(), false, 'nothing after stop');
});

test('the marker log tells the clips about every moment it keeps', () => {
  const seen = [];
  const m = createCaptureMarkers({ fps: null, active: () => true, onAdd: (x) => seen.push(x.kind), now: () => 5000 });
  m.mark();
  assert.deepEqual(seen, ['mark']);
  const broken = createCaptureMarkers({ fps: null, active: () => true, onAdd: () => { throw new Error('x'); } });
  assert.deepEqual(broken.mark(), { ok: true }, 'a listener never breaks the log');
});

test('the setting: marks by default, the three choices, anything else refused', () => {
  assert.equal(normalizeCaptureSettings({}).replayClips, 'marks');
  assert.equal(normalizeCaptureSettings({ replayClips: 'nope' }).replayClips, 'marks');
  for (const v of ['marks', 'all', 'off']) assert.equal(applyCaptureChange({}, { replayClips: v }).next.replayClips, v);
  assert.deepEqual(applyCaptureChange({}, { replayClips: 'sometimes' }).bad, ['replayClips']);
  assert.deepEqual(replayCap.changeOf({ clips: 'all' }).change, { replayClips: 'all' });
  assert.deepEqual(replayCap.changeOf({ clips: 'keep' }).change, {});
  assert.equal(replayCap.describe({}, { replayClips: 'off' }).clips, 'off');
});

test('wired: server, Settings, the toast and the replay notice', () => {
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(server, /onAdd: \(m\) => _autoClips\.onMark\(m\)/);
  assert.match(server, /createAutoClips\(\{[\s\S]{0,200}recording: \(\) => _recorder\.status\(\)\.on === true/);
  assert.match(server, /\.\.\.\(e\.auto \? \{ auto: e\.auto \} : \{\}\)/);
  assert.match(server, /_autoClips\.stop\(\)/);
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /id="settings-replay-clips"[^>]*CaptureSettingsPane\.set\('replayClips'/);
  const toast = readFileSync(new URL('../js/capture-toast.js', import.meta.url), 'utf8');
  assert.match(toast, /d\.auto === 'stutter'\) return;/);
  assert.match(toast, /replay_clip_saved/);
  const replay = readFileSync(new URL('../replay.js', import.meta.url), 'utf8');
  assert.match(replay, /kind: 'replay', \.\.\.\(auto \? \{ auto \} : \{\}\)/);
});
