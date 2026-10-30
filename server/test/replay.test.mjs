// replay.js: Instant Replay. Pinned here: off by default and while no game
// is in front ("while gaming"); on, it asks the engine for a ring in its temp
// folder with the user's length and sound; a length change goes to the running
// replay, a picture or sound change restarts it; a save asks the engine for an
// MP4 in Videos/Xenon, waits for its event and indexes it as a "replay"; one
// save at a time; a failed start or a replay that dies is retried with a
// growing pause and the reason is reported; shutdown waits for a save, then
// stops the ring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createReplay, estimateBitrate, ringByteRate, RETRY_MS, START_TIMEOUT_MS } = require('../replay.js');

const START = { ok: true, width: 2560, height: 1440, fps: 60, hdr: false, bitrate: 26542080, sound: 'system', mic: false, monitor: 0 };

function fakeHost({ startReply = START, saveReply = { ok: true, saving: true } } = {}) {
  const listeners = new Set();
  const requests = [];
  return {
    requests,
    up: true,
    startReply,
    available() { return this.up; },
    onEvent: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    emit: (ev) => { for (const fn of listeners) fn(ev); },
    request(cmd, body, opts) {
      requests.push({ cmd, body, opts });
      if (cmd === 'replay_start') return Promise.resolve(this.startReply);
      if (cmd === 'replay_save') return Promise.resolve(saveReply);
      if (cmd === 'replay_keep') return Promise.resolve({ ok: true, seconds: body.seconds });
      if (cmd === 'replay_stop') return Promise.resolve({ ok: true, reason: 'stopped' });
      return Promise.resolve({ ok: false, error: 'unknown' });
    },
    cmds() { return this.requests.map(r => r.cmd); },
  };
}

function fakeStore({ removes = 0 } = {}) {
  const added = [];
  const planned = [];
  const pruned = [];
  return {
    added, planned, pruned,
    plan: async ({ kind, game, root }) => {
      planned.push({ kind, game, root });
      const base = root || 'C:\\V\\Xenon';
      return { id: 'b'.repeat(16), dir: `${base}\\${game || 'Desktop'}`, file: `${base}\\${game || 'Desktop'}\\r.mp4`, name: 'r.mp4' };
    },
    prune: async (q) => { pruned.push(q); return { removed: removes }; },
    add: (e) => { added.push(e); return { id: e.id, kind: e.kind, name: 'r.mp4', game: e.game, seconds: e.seconds }; },
  };
}

// Timers the test fires by hand.
function fakeTimers() {
  const list = [];
  return {
    list,
    setTimeout: (fn, ms) => { const t = { fn, ms, done: false }; list.push(t); return t; },
    clearTimeout: (t) => { if (t) t.done = true; },
    fire(ms) { for (const t of list.filter(x => !x.done && x.ms === ms)) { t.done = true; t.fn(); } },
    pending: () => list.filter(x => !x.done).map(x => x.ms),
  };
}

function setup(o = {}) {
  const host = fakeHost(o);
  const store = fakeStore(o);
  const timers = fakeTimers();
  const changes = [];
  const saved = [];
  const dirs = [];
  let settings = { replay: true, replaySeconds: 30, replayWhen: 'gaming', replayAudio: 'sound', fps: 60, height: 0, quality: 'normal', ...o.settings };
  let playing = o.gaming !== undefined ? o.gaming : true;
  const replay = createReplay({
    host, store, timers, ringDir: 'C:\\T\\Xenon Replay',
    options: () => settings,
    gaming: () => playing,
    game: () => (playing ? 'Game.exe' : ''),
    mkdir: async (d) => { dirs.push(d); },
    now: () => 5000,
    onChange: (s) => changes.push(s),
    onSaved: (e) => saved.push(e),
    ...(o.folder ? { folder: o.folder } : {}),
  });
  return {
    host, store, timers, replay, changes, saved, dirs,
    set: (patch) => { settings = { ...settings, ...patch }; },
    play: (on) => { playing = on; },
  };
}

test('off by default: nothing starts', async () => {
  const t = setup({ settings: { replay: false } });
  await t.replay.sync();
  assert.deepEqual(t.host.requests, []);
  assert.equal(t.replay.status().on, false);
  assert.equal(t.replay.status().enabled, false);
});

test('"while gaming" waits for a game, then records with the user\'s length and sound', async () => {
  const t = setup({ gaming: false });
  await t.replay.sync();
  assert.deepEqual(t.host.requests, [], 'no game, no replay');
  assert.equal(t.replay.status().waiting, true, 'the pane can say it waits for a game');
  t.play(true);
  await t.replay.sync();
  const [start] = t.host.requests;
  assert.equal(start.cmd, 'replay_start');
  assert.deepEqual(start.body, { dir: 'C:\\T\\Xenon Replay', seconds: 30, fps: 60, height: 0, quality: 'normal', sound: true, mic: false });
  assert.equal(start.opts.timeoutMs, START_TIMEOUT_MS);
  assert.deepEqual(t.dirs, ['C:\\T\\Xenon Replay']);
  const s = t.replay.status();
  assert.equal(s.on, true);
  assert.equal(s.bitrate, 26542080);
  assert.equal(s.waiting, undefined);
  assert.equal(t.changes.at(-1).on, true, 'the dashboards hear it');
  // The game ends: the ring goes.
  t.play(false);
  await t.replay.sync();
  assert.equal(t.host.cmds().at(-1), 'replay_stop');
  assert.equal(t.replay.status().on, false);
});

test('"always" runs on the desktop too', async () => {
  const t = setup({ gaming: false, settings: { replayWhen: 'always' } });
  await t.replay.sync();
  assert.deepEqual(t.host.cmds(), ['replay_start']);
});

test('silent and microphone choices reach the engine; a refused microphone is reported', async () => {
  const silent = setup({ settings: { replayAudio: 'silent' } });
  await silent.replay.sync();
  assert.equal(silent.host.requests[0].body.sound, false);
  const mic = setup({ settings: { replayAudio: 'sound_mic' } });
  await mic.replay.sync();
  assert.equal(mic.host.requests[0].body.mic, true);
  assert.equal(mic.replay.status().noMic, true);
});

test('a new length goes to the running replay; new picture options restart it', async () => {
  const t = setup();
  await t.replay.sync();
  await t.replay.sync();
  assert.deepEqual(t.host.cmds(), ['replay_start'], 'nothing changed, nothing sent');
  t.set({ replaySeconds: 300 });
  await t.replay.sync();
  assert.deepEqual(t.host.requests.at(-1), { cmd: 'replay_keep', body: { seconds: 300 }, opts: undefined });
  assert.equal(t.replay.status().kept, 300);
  t.set({ fps: 30 });
  await t.replay.sync();
  assert.deepEqual(t.host.cmds().slice(-2), ['replay_stop', 'replay_start']);
  assert.equal(t.host.requests.at(-1).body.fps, 30);
});

test('two quick syncs never start two replays', async () => {
  const t = setup();
  await Promise.all([t.replay.sync(), t.replay.sync(), t.replay.sync()]);
  assert.deepEqual(t.host.cmds(), ['replay_start']);
});

test('a save writes an MP4 in Videos/Xenon and indexes it as a replay', async () => {
  const t = setup({ removes: 1, settings: { maxGB: 25 } });
  await t.replay.sync();
  const p = t.replay.save({ seconds: 20 });
  await new Promise(setImmediate);
  const req = t.host.requests.find(r => r.cmd === 'replay_save');
  assert.deepEqual(req.body, { path: 'C:\\V\\Xenon\\Game.exe\\r.mp4', seconds: 20, token: 'b'.repeat(16) });
  assert.deepEqual(t.store.planned, [{ kind: 'replay', game: 'Game.exe', root: undefined }]);
  assert.equal(t.replay.status().saving, true);
  t.host.emit({ event: 'replay_saved', token: 'b'.repeat(16), ok: true, seconds: 21.03, bytes: 9 });
  const r = await p;
  assert.deepEqual(r, { ok: true, saved: true, id: 'b'.repeat(16), name: 'r.mp4', game: 'Game.exe', seconds: 21.03, pruned: 1 });
  assert.equal(t.store.added[0].kind, 'replay');
  assert.equal(t.store.added[0].width, 2560);
  assert.deepEqual(t.store.pruned, [{ kind: ['recording', 'replay'], maxBytes: 25 * 1024 ** 3, keep: 'b'.repeat(16) }]);
  assert.equal(t.saved[0].kind, 'replay', 'the dashboards get the toast');
  assert.equal(t.replay.status().saving, undefined);
});

test('a save longer than the replay keeps asks for what is kept; none asks for all', async () => {
  const t = setup();
  await t.replay.sync();
  t.replay.save({ seconds: 600 });
  await new Promise(setImmediate);
  assert.equal(t.host.requests.find(r => r.cmd === 'replay_save').body.seconds, 30);
  t.host.emit({ event: 'replay_saved', token: 'b'.repeat(16), ok: true, seconds: 31 });
});

test('one save at a time; a failed save says why and indexes nothing', async () => {
  const t = setup();
  await t.replay.sync();
  const first = t.replay.save();
  assert.deepEqual(await t.replay.save(), { ok: false, error: 'saving' });
  await new Promise(setImmediate);
  t.host.emit({ event: 'replay_saved', token: 'b'.repeat(16), ok: false, error: 'disk_full' });
  assert.deepEqual(await first, { ok: false, error: 'disk_full' });
  assert.deepEqual(t.store.added, []);
  assert.deepEqual(t.saved, []);
});

test('a save with the replay off or waiting says which', async () => {
  const off = setup({ settings: { replay: false } });
  assert.deepEqual(await off.replay.save(), { ok: false, error: 'off' });
  const waiting = setup({ gaming: false });
  await waiting.replay.sync();
  assert.deepEqual(await waiting.replay.save(), { ok: false, error: 'no_game' });
});

test('the engine dying during a save fails it instead of hanging', async () => {
  const t = setup();
  await t.replay.sync();
  const p = t.replay.save();
  await new Promise(setImmediate);
  t.host.emit({ event: 'engine_exited', code: 1 });
  assert.deepEqual(await p, { ok: false, error: 'save_failed' });
  assert.equal(t.replay.status().on, false);
  assert.equal(t.replay.status().error, 'engine_exited');
});

test('a failed start is retried with a growing pause, and the reason is shown', async () => {
  const t = setup({ startReply: { ok: false, error: 'no_encoder' } });
  await t.replay.sync();
  assert.equal(t.replay.status().error, 'no_encoder');
  assert.deepEqual(t.timers.pending(), [RETRY_MS[0]]);
  await t.replay.sync();
  assert.deepEqual(t.host.cmds(), ['replay_start'], 'no new attempt before the pause ends');
  t.timers.fire(RETRY_MS[0]);
  await t.replay.sync();
  assert.deepEqual(t.timers.pending(), [RETRY_MS[1]], 'the pause grows');
  t.host.startReply = START;
  t.timers.fire(RETRY_MS[1]);
  await t.replay.sync();
  assert.equal(t.replay.status().on, true);
  assert.equal(t.replay.status().error, undefined);
});

test('a replay that ends by itself is restarted after a pause', async () => {
  const t = setup();
  await t.replay.sync();
  t.host.emit({ event: 'replay_ended', reason: 'gpu_lost' });
  assert.equal(t.replay.status().on, false);
  assert.equal(t.replay.status().error, 'gpu_lost');
  t.timers.fire(RETRY_MS[0]);
  await t.replay.sync();
  assert.deepEqual(t.host.cmds(), ['replay_start', 'replay_start']);
});

test('turning it off clears an error and a pending retry', async () => {
  const t = setup({ startReply: { ok: false, error: 'failed' } });
  await t.replay.sync();
  t.set({ replay: false });
  await t.replay.sync();
  assert.equal(t.replay.status().error, undefined);
  assert.deepEqual(t.timers.pending(), []);
});

test('shutdown waits for a save, then stops the ring, and nothing restarts', async () => {
  const t = setup();
  await t.replay.sync();
  const p = t.replay.save();
  await new Promise(setImmediate);
  const f = t.replay.flush();
  await new Promise(setImmediate);
  assert.ok(!t.host.cmds().includes('replay_stop'), 'the save comes first');
  t.host.emit({ event: 'replay_saved', token: 'b'.repeat(16), ok: true, seconds: 30 });
  await p;
  await f;
  assert.equal(t.host.cmds().at(-1), 'replay_stop');
  await t.replay.sync();
  assert.equal(t.host.cmds().filter(c => c === 'replay_start').length, 1);
});

test('without the engine nothing starts and a save says unavailable', async () => {
  const t = setup();
  t.host.up = false;
  await t.replay.sync();
  assert.deepEqual(t.host.requests, []);
  assert.deepEqual(await t.replay.save(), { ok: false, error: 'unavailable' });
});

test('the chosen folder is used, a missing one is reported', async () => {
  const t = setup({ folder: async () => ({ dir: '', missing: true }) });
  await t.replay.sync();
  const p = t.replay.save();
  await new Promise(setImmediate);
  t.host.emit({ event: 'replay_saved', token: 'b'.repeat(16), ok: true, seconds: 30 });
  assert.equal((await p).folderMissing, true);
});

test('the disk estimate follows the engine\'s bitrate formula', () => {
  assert.equal(estimateBitrate({ width: 1920, height: 1080 }, { fps: 60 }), 14929920);
  assert.equal(estimateBitrate({ width: 3840, height: 2160 }, { fps: 60 }), 59719680);
  // Brought down to 1080: as a 1080p screen.
  assert.equal(estimateBitrate({ width: 3840, height: 2160 }, { fps: 60, height: 1080 }), 14929920);
  assert.equal(estimateBitrate({ width: 640, height: 480 }, { fps: 30 }), 4e6);
  assert.equal(estimateBitrate({}, {}), 0);
  // 15 Mbps + raw sound: about 2 MB a second, 66 MB for 30 s; silent leaves the sound out.
  assert.equal(ringByteRate(14929920), 2058240);
  assert.equal(ringByteRate(14929920, { sound: false }), 1866240);
  assert.equal(ringByteRate(0), 0);
});
