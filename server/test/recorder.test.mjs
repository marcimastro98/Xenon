// recorder.js: one screen/window recording at a time. Pinned here: the start
// asks the engine with an MP4 path in Videos/Xenon and says so over onChange;
// a second start is refused, a second press while the engine opens is not a
// stop; stop indexes the file with its length; a recording that ends by itself
// (window closed, engine gone) is still indexed; an empty one leaves nothing;
// an end that beats the start reply is not lost; shutdown finishes it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createRecorder, FPS, START_TIMEOUT_MS } = require('../recorder.js');
const { createCapabilities } = require('../capabilities/index.js');

function fakeHost({ startReply = { ok: true, width: 2560, height: 720, fps: 60, hdr: false, sound: 'system' } } = {}) {
  const listeners = new Set();
  const requests = [];
  const waiting = [];
  return {
    requests,
    available: () => true,
    onEvent: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    emit: (ev) => { for (const fn of listeners) fn(ev); },
    // A request waits for `answer()` when `hold` is set.
    hold: false,
    answer(reply) { waiting.shift()(reply); },
    request(cmd, body, opts) {
      requests.push({ cmd, body, opts });
      if (this.hold) return new Promise((r) => waiting.push(r));
      if (cmd === 'record_start') return Promise.resolve(startReply);
      if (cmd === 'record_stop') return Promise.resolve({ ok: true, reason: 'stopped', seconds: 12.5, frames: 750, dropped: 0, bytes: 1000 });
      return Promise.resolve({ ok: false, error: 'unknown' });
    },
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
      return { id: 'a'.repeat(16), dir: `${base}\\${game || 'Desktop'}`, file: `${base}\\${game || 'Desktop'}\\x.mp4`, name: 'x.mp4', kind };
    },
    prune: async (q) => { pruned.push(q); return { removed: removes, freed: removes * 10 }; },
    add: (e) => { added.push(e); return { id: e.id, kind: e.kind, name: 'x.mp4', game: e.game, seconds: e.seconds }; },
  };
}

function setup(opts = {}) {
  const host = fakeHost(opts);
  const store = fakeStore(opts);
  const changes = [];
  const saved = [];
  const dirs = [];
  let clock = 1000;
  const rec = createRecorder({
    host, store, game: () => opts.game || '',
    mkdir: async (d) => { dirs.push(d); },
    exists: async () => opts.fileExists !== false,
    now: () => clock,
    onChange: (s) => changes.push(s),
    onSaved: (e) => saved.push(e),
    ...(opts.options ? { options: opts.options } : {}),
    ...(opts.folder ? { folder: opts.folder } : {}),
  });
  return { host, store, rec, changes, saved, dirs, advance: (ms) => { clock += ms; } };
}

test('start asks the engine for an MP4 at 60 fps and tells the dashboards', async () => {
  const { host, rec, changes, dirs } = setup({ game: 'Game.exe' });
  const r = await rec.start({ target: 'window' });
  assert.deepEqual(r, { ok: true, recording: true, target: 'window', width: 2560, height: 720, fps: 60, hdr: false, sound: 'system', mic: false });
  assert.equal(host.requests[0].cmd, 'record_start');
  assert.deepEqual(host.requests[0].body, { target: 'window', path: 'C:\\V\\Xenon\\Game.exe\\x.mp4', fps: FPS, height: 0, quality: 'normal', badge: true, sound: true, mic: false });
  assert.equal(host.requests[0].opts.timeoutMs, START_TIMEOUT_MS);
  assert.deepEqual(dirs, ['C:\\V\\Xenon\\Game.exe']);
  assert.deepEqual(changes, [{ on: true, since: 1000, target: 'window' }]);
  assert.deepEqual(rec.status(), { on: true, since: 1000, target: 'window' });
});

test('an unknown target records the screen; a second start is refused', async () => {
  const { host, rec } = setup();
  await rec.start({ target: 'C:\\evil' });
  assert.equal(host.requests[0].body.target, 'screen');
  assert.deepEqual(await rec.start({}), { ok: false, error: 'running' });
});

test('audio: sound by default, the microphone only when asked, nothing when silent', async () => {
  const asked = async (audio) => {
    const { host, rec } = setup();
    await rec.start({ target: 'screen', audio });
    const { sound, mic } = host.requests[0].body;
    return { sound, mic };
  };
  assert.deepEqual(await asked(undefined), { sound: true, mic: false });
  assert.deepEqual(await asked('sound'), { sound: true, mic: false });
  assert.deepEqual(await asked('sound_mic'), { sound: true, mic: true });
  assert.deepEqual(await asked('silent'), { sound: false, mic: false });
  assert.deepEqual(await asked('everything'), { sound: true, mic: false }, 'unknown values fall back to the default');
});

test('what the engine opened is in the reply; a refused microphone is told, the video goes on', async () => {
  const { rec, changes } = setup({ startReply: { ok: true, width: 1, height: 1, fps: 60, hdr: false, sound: 'app', mic: false } });
  const r = await rec.start({ target: 'window', audio: 'sound_mic' });
  assert.equal(r.recording, true);
  assert.equal(r.sound, 'app');
  assert.equal(r.mic, false);
  assert.deepEqual(changes, [{ on: true, since: 1000, target: 'window', noMic: true }]);
  const ok = setup({ startReply: { ok: true, width: 1, height: 1, fps: 60, sound: 'system', mic: true } });
  const r2 = await ok.rec.start({ audio: 'sound_mic' });
  assert.equal(r2.sound, 'system');
  assert.equal(r2.mic, true);
  assert.equal(ok.changes[0].noMic, undefined);
  const odd = setup({ startReply: { ok: true, width: 1, height: 1, fps: 60, sound: '<b>', mic: 'yes' } });
  const r3 = await odd.rec.start({});
  assert.equal(r3.sound, null, 'only the known values pass');
  assert.equal(r3.mic, false);
});

test('stop indexes the file with its length, without a path on the way out', async () => {
  const { store, rec, changes, saved } = setup();
  await rec.start({});
  const r = await rec.stop();
  assert.deepEqual(r, { ok: true, saved: true, id: 'a'.repeat(16), name: 'x.mp4', game: '', seconds: 12.5, reason: 'stopped' });
  assert.equal(store.added[0].kind, 'recording');
  assert.equal(store.added[0].seconds, 12.5);
  assert.deepEqual(changes.at(-1), { on: false, reason: 'stopped' });
  assert.equal(saved.length, 1);
  assert.ok(!JSON.stringify(saved).includes('C:\\'), 'no path in what is broadcast');
  assert.deepEqual(rec.status(), { on: false });
  assert.deepEqual(await rec.stop(), { ok: false, error: 'not_recording' });
});

test('engine failures keep the codes a person can act on, the rest are "failed"', async () => {
  for (const [error, want] of [['no_window', 'no_window'], ['no_encoder', 'no_encoder'], ['disk_full', 'disk_full'], ['record_failed', 'failed'], ['timeout', 'failed']]) {
    const { rec, changes } = setup({ startReply: { ok: false, error } });
    assert.deepEqual(await rec.start({}), { ok: false, error: want });
    assert.deepEqual(changes, []);
    assert.deepEqual(rec.status(), { on: false });
  }
});

test('the desktop share dialog closed (GNOME, KDE): no error, nothing told, the next start works', async () => {
  const { rec, changes, host } = setup({ startReply: { ok: false, error: 'cancelled' } });
  assert.deepEqual(await rec.start({}), { ok: true, cancelled: true });
  assert.deepEqual(changes, []);
  assert.deepEqual(rec.status(), { on: false });
  // Long enough for the dialog the first time (the engine gives it 120 s).
  assert.ok(START_TIMEOUT_MS > 120000);
  assert.notDeepEqual(await rec.start({}), { ok: false, error: 'starting' });
  assert.equal(host.requests.filter((r) => r.cmd === 'record_start').length, 2);
});

test('a recording that ends by itself (window closed) is indexed and told', async () => {
  const { host, rec, changes, saved } = setup();
  await rec.start({ target: 'window' });
  host.emit({ event: 'record_ended', reason: 'window_closed', seconds: 4.2, frames: 252, dropped: 0, bytes: 9 });
  await new Promise((r) => setImmediate(r));
  assert.equal(saved[0].reason, 'window_closed');
  assert.equal(saved[0].seconds, 4.2);
  assert.deepEqual(changes.at(-1), { on: false, reason: 'window_closed' });
  // The stop that raced the event gets the same result, not a second entry.
  assert.deepEqual(await rec.stop(), { ok: false, error: 'not_recording' });
});

test('a stop clicked on the engine badge is indexed and told like any stop', async () => {
  const { host, rec, changes, saved } = setup();
  await rec.start({ target: 'screen' });
  host.emit({ event: 'record_ended', reason: 'stopped', seconds: 2.6, frames: 158, dropped: 0, bytes: 9 });
  await new Promise((r) => setImmediate(r));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].reason, 'stopped');
  assert.deepEqual(changes.at(-1), { on: false, reason: 'stopped' });
  assert.deepEqual(rec.status(), { on: false });
});

test('an engine that dies mid-recording: the file on disk is kept, its length estimated', async () => {
  const { host, store, rec, advance } = setup();
  await rec.start({});
  advance(30000);
  host.emit({ event: 'engine_exited', code: null });
  await new Promise((r) => setImmediate(r));
  assert.equal(store.added.length, 1);
  assert.equal(store.added[0].seconds, 30);
});

test('an engine that dies before writing anything leaves no entry', async () => {
  const { host, store, rec, changes } = setup({ fileExists: false });
  await rec.start({});
  host.emit({ event: 'engine_exited', code: 1 });
  await new Promise((r) => setImmediate(r));
  assert.equal(store.added.length, 0);
  assert.deepEqual(changes.at(-1), { on: false, reason: 'engine_exited', error: 'too_short' });
});

test('an empty recording (0 frames) is not indexed', async () => {
  const { host, store, rec, changes } = setup();
  await rec.start({});
  host.emit({ event: 'record_ended', reason: 'capture_failed', seconds: 0, frames: 0 });
  await new Promise((r) => setImmediate(r));
  assert.equal(store.added.length, 0);
  assert.equal(changes.at(-1).error, 'too_short');
});

test('an end that arrives before the start reply is applied once the reply lands', async () => {
  const { host, rec, saved } = setup();
  host.hold = true;
  const p = rec.start({ target: 'window' });
  await new Promise((r) => setImmediate(r));
  host.emit({ event: 'record_ended', reason: 'window_closed', seconds: 0.1, frames: 6 });
  host.answer({ ok: true, width: 100, height: 100, fps: 60 });
  await p;
  await new Promise((r) => setImmediate(r));
  assert.equal(saved.length, 1);
  assert.deepEqual(rec.status(), { on: false });
});

test('a second press while the engine opens is not a stop', async () => {
  const { host, rec } = setup();
  host.hold = true;
  const first = rec.toggle({});
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(await rec.toggle({}), { ok: true, starting: true });
  assert.deepEqual(await rec.start({}), { ok: false, error: 'starting' });
  host.answer({ ok: true, width: 10, height: 10, fps: 60 });
  assert.equal((await first).recording, true);
  host.hold = false;
  assert.equal((await rec.toggle({})).saved, true);
});

test('flush (shutdown) stops and indexes a recording in progress', async () => {
  const { store, rec } = setup();
  assert.equal(await rec.flush(), null);
  await rec.start({});
  const r = await rec.flush();
  assert.equal(r.saved, true);
  assert.equal(store.added.length, 1);
});

test('record capability: modes, audio, reveal of the last recording, unavailable without the engine', async () => {
  const { host, rec } = setup();
  const revealed = [];
  const caps = createCapabilities({
    capture: {
      host: { available: () => true },
      store: () => ({ last: async (kind) => (kind === 'recording' ? { file: 'C:\\V\\r.mp4', name: 'r.mp4' } : null) }),
      recorder: () => rec,
      reveal: (f) => revealed.push(f),
    },
  });
  assert.equal((await caps.run({ type: 'record', target: 'screen', audio: 'sound_mic' })).recording, true);
  assert.equal((await caps.run({ type: 'record', mode: 'stop' })).saved, true);
  assert.equal((await caps.run({ type: 'record', mode: 'start', audio: 'silent' })).recording, true);
  await caps.run({ type: 'record', mode: 'stop' });
  const starts = host.requests.filter((q) => q.cmd === 'record_start').map((q) => [q.body.sound, q.body.mic]);
  assert.deepEqual(starts, [[true, true], [false, false]], 'the Deck/AI audio choice reaches the engine');
  assert.deepEqual(await caps.run({ type: 'record', mode: 'reveal' }), { ok: true, shown: true, name: 'r.mp4' });
  assert.deepEqual(revealed, ['C:\\V\\r.mp4']);
  const off = createCapabilities({ capture: { host: { available: () => false } } });
  assert.deepEqual(await off.run({ type: 'record' }), { ok: false, error: 'unavailable' });
});

// Recording options (capture-settings.js): read at every start, sent to the engine.
test('the options in force go to the engine; a broken reader falls back to the defaults', async () => {
  const o = setup({ options: () => ({ fps: 30, height: 720, quality: 'small', badge: false }) });
  await o.rec.start({});
  const { fps, height, quality, badge } = o.host.requests[0].body;
  assert.deepEqual({ fps, height, quality, badge }, { fps: 30, height: 720, quality: 'small', badge: false });
  const broken = setup({ options: () => { throw new Error('settings unreadable'); } });
  await broken.rec.start({});
  const b = broken.host.requests[0].body;
  assert.deepEqual({ fps: b.fps, height: b.height, quality: b.quality, badge: b.badge }, { fps: FPS, height: 0, quality: 'normal', badge: true });
});

test('a chosen folder is the root; a missing one records in Videos and says so', async () => {
  const chosen = setup({ folder: async () => ({ dir: 'D:\\Clips' }) });
  await chosen.rec.start({});
  assert.equal(chosen.store.planned[0].root, 'D:\\Clips');
  assert.equal(chosen.host.requests[0].body.path, 'D:\\Clips\\Desktop\\x.mp4');
  assert.equal(chosen.changes[0].folderMissing, undefined);

  const gone = setup({ folder: async () => ({ dir: '', missing: true }) });
  const r = await gone.rec.start({});
  assert.equal(gone.store.planned[0].root, undefined, 'the default folder');
  assert.equal(r.folderMissing, true);
  assert.equal(gone.changes[0].folderMissing, true);

  const throws = setup({ folder: async () => { throw new Error('disk'); } });
  const r2 = await throws.rec.start({});
  assert.equal(r2.recording, true, 'a failing folder check never stops the recording');
  assert.equal(throws.store.planned[0].root, undefined);
});

test('the space limit prunes after a saved recording, never the new one', async () => {
  const none = setup({ options: () => ({ maxGB: 0 }), removes: 3 });
  await none.rec.start({});
  const r0 = await none.rec.stop();
  assert.deepEqual(none.store.pruned, [], 'no limit, nothing deleted');
  assert.equal(r0.pruned, undefined);

  const lim = setup({ options: () => ({ maxGB: 10 }), removes: 2 });
  await lim.rec.start({});
  const r = await lim.rec.stop();
  assert.deepEqual(lim.store.pruned, [{ kind: ['recording', 'replay'], maxBytes: 10 * 1024 ** 3, keep: 'a'.repeat(16) }]);
  assert.equal(r.pruned, 2);
  assert.equal(lim.saved[0].pruned, 2, 'the dashboards hear how many went');

  const short = setup({ options: () => ({ maxGB: 10 }), removes: 2, startReply: { ok: true, width: 1, height: 1, fps: 60 } });
  short.host.request = function (cmd) {
    if (cmd === 'record_start') return Promise.resolve({ ok: true, width: 1, height: 1, fps: 60 });
    return Promise.resolve({ ok: true, reason: 'stopped', seconds: 0, frames: 0 });
  };
  await short.rec.start({});
  await short.rec.stop();
  assert.deepEqual(short.store.pruned, [], 'nothing saved, nothing deleted');
});

// Webcam (item 20): a corner turns the bubble on, the engine says whether a
// camera opened; never in a timelapse, never a value the engine does not know.
test('webcam: the corner reaches the engine, a missing camera is told, never in a timelapse', async () => {
  const sent = async (start, reply) => {
    const s = setup(reply ? { startReply: reply } : {});
    const r = await s.rec.start(start);
    return { webcam: s.host.requests[0].body.webcam, r, change: s.changes[0] };
  };
  assert.equal((await sent({})).webcam, undefined, 'no webcam unless asked');
  assert.equal((await sent({ webcam: 'off' })).webcam, undefined);
  assert.equal((await sent({ webcam: 'middle' })).webcam, undefined, 'unknown corners are no webcam');
  assert.equal((await sent({ webcam: 'br', every: 5 })).webcam, undefined, 'a timelapse has no webcam');
  const on = await sent({ webcam: 'tl' }, { ok: true, width: 1, height: 1, fps: 60, camera: true });
  assert.equal(on.webcam, 'tl');
  assert.equal(on.r.camera, true);
  assert.equal(on.change.noCamera, undefined);
  const none = await sent({ webcam: 'br' }, { ok: true, width: 1, height: 1, fps: 60, camera: false });
  assert.equal(none.r.recording, true, 'the video goes on without the camera');
  assert.equal(none.r.camera, false);
  assert.equal(none.r.noCamera, true);
  assert.equal(none.change.noCamera, true);
  const plain = await sent({}, { ok: true, width: 1, height: 1, fps: 60, camera: true });
  assert.equal(plain.r.camera, undefined, 'camera is only reported when asked for');
});

test('record capability: the webcam choice reaches the recorder, "off" is no webcam', async () => {
  const { host, rec } = setup();
  const caps = createCapabilities({
    capture: { host: { available: () => true }, store: () => ({ last: async () => null }), recorder: () => rec, reveal: () => {} },
  });
  await caps.run({ type: 'record', mode: 'start', webcam: 'bl' });
  await caps.run({ type: 'record', mode: 'stop' });
  await caps.run({ type: 'record', mode: 'start', webcam: 'off' });
  await caps.run({ type: 'record', mode: 'stop' });
  const corners = host.requests.filter((q) => q.cmd === 'record_start').map((q) => q.body.webcam);
  assert.deepEqual(corners, ['bl', undefined]);
});

// The macOS engine records no computer sound at all: asked for it, it answers
// without `sound`, and the card says so instead of a silent video surprising.
test('computer sound that did not come is told; asked for silence, nothing is said', async () => {
  const mac = setup({ startReply: { ok: true, width: 1, height: 1, fps: 60, mic: false } });
  await mac.rec.start({ target: 'screen', audio: 'sound' });
  assert.equal(mac.changes[0].noSound, true);
  const quiet = setup({ startReply: { ok: true, width: 1, height: 1, fps: 60 } });
  await quiet.rec.start({ target: 'screen', audio: 'silent' });
  assert.equal(quiet.changes[0].noSound, undefined);
  const win = setup({ startReply: { ok: true, width: 1, height: 1, fps: 60, sound: 'system' } });
  await win.rec.start({ target: 'screen', audio: 'sound' });
  assert.equal(win.changes[0].noSound, undefined);
});
