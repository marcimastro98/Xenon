// capture-export.js and capabilities/export.js: copies of a video for sharing.
// Pinned here: a request is checked before the engine (kind, size, webcam),
// one copy at a time, progress and the end are told with the source id and
// who asked, the copy lands beside the original as a new capture (a GIF as
// kind "gif" with ".gif"), a copy past its time is stopped in the engine,
// "Stop" reaches the engine; the action answers at once and Bit's turn waits
// for the end; `mb` always means a smaller copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createCaptureExport, shape, suffixOf, timeoutFor } = require('../capture-export.js');
const { createCaptures } = require('../captures.js');
const exportCap = require('../capabilities/export.js');
const { CAPABILITIES } = require('../js/capability-catalog.js');
const { validateAction } = require('../js/deck-actions.js');

const ROOT = path.join(os.tmpdir(), 'exp');

function fakeHost({ available = true, answer } = {}) {
  const listeners = new Set();
  const sent = [];
  return {
    sent,
    available: () => available,
    onEvent: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    emit: (ev) => { for (const fn of listeners) fn(ev); },
    async request(cmd, body) {
      sent.push({ cmd, ...body });
      if (answer) return answer(cmd, body);
      return { ok: true, queued: true };
    },
  };
}

function fakeTimers() {
  const pending = new Map();
  let n = 0;
  return {
    pending,
    setTimeout: (fn, ms) => { pending.set(++n, { fn, ms }); return n; },
    clearTimeout: (id) => { pending.delete(id); },
    fire() { for (const [id, t] of [...pending]) { pending.delete(id); t.fn(); } },
  };
}

function setup({ host = fakeHost(), timers } = {}) {
  const disk = new Set();
  const sizes = new Map();
  let n = 0;
  let t = 1000;
  const store = createCaptures({
    file: path.join(ROOT, 'captures.json'),
    writeFileAtomic: async () => {},
    picturesDir: async () => ROOT,
    exists: async (p) => disk.has(p),
    now: () => (t += 1000),
    randomId: () => (++n).toString(16).padStart(16, '0'),
  });
  const progress = [];
  const ended = [];
  const exp = createCaptureExport({
    host, store, sizeOf: async (p) => (disk.has(p) ? sizes.get(p) ?? 80e6 : null),
    onProgress: (ev) => progress.push(ev), onDone: (ev) => ended.push(ev),
    ...(timers ? { timers } : {}),
  });
  const put = async (kind, extra = {}) => {
    const p = await store.plan({ kind, game: 'Game.exe' });
    disk.add(p.file);
    return store.get(store.add({ id: p.id, kind, file: p.file, game: 'Game.exe', width: 1920, height: 1080, seconds: 30, ...extra }).id);
  };
  return { host, store, exp, put, progress, ended, disk, sizes };
}

const exportReq = host => host.sent.find(s => s.cmd === 'export');

test('shape: checks the kind, the size and the webcam before the engine', () => {
  const e = { webcam: 'br' };
  assert.deepEqual(shape(e, { kind: 'nope' }), { error: 'bad_kind' });
  assert.deepEqual(shape(e, { kind: 'fit', mb: 0 }), { error: 'bad_size' });
  assert.deepEqual(shape(e, { kind: 'fit', mb: 2.5 }), { error: 'bad_size' });
  assert.deepEqual(shape(e, { kind: 'fit', mb: 4001 }), { error: 'bad_size' });
  assert.deepEqual(shape(e, { kind: 'fit', mb: '25' }), { body: { kind: 'fit', mb: 25 } });
  assert.deepEqual(shape(e, { kind: 'gif', focus: 'left' }), { body: { kind: 'gif' } });
  assert.deepEqual(shape(e, { kind: 'vertical', focus: 'up' }), { body: { kind: 'vertical', focus: 'center' } });
  assert.deepEqual(shape(e, { kind: 'vertical', webcam: true }), { body: { kind: 'vertical', focus: 'center', webcam: 'br' } });
  assert.deepEqual(shape({}, { kind: 'vertical', webcam: true }), { error: 'no_webcam' });
  // Only `true` asks for the webcam: a string from a careless client does not.
  assert.deepEqual(shape(e, { kind: 'vertical', webcam: 'yes' }), { body: { kind: 'vertical', focus: 'center' } });
});

test('names and time limits', () => {
  assert.equal(suffixOf('vertical'), 'Vertical');
  assert.equal(suffixOf('fit', 25), '25 MB');
  assert.equal(suffixOf('gif'), 'GIF');
  assert.equal(timeoutFor({ seconds: 30 }, 'vertical'), 120000 + 60000);
  assert.equal(timeoutFor({ seconds: 30 }, 'fit'), 3 * (120000 + 60000));
  assert.equal(timeoutFor({}, 'gif'), 120000 + 600 * 2000);
});

test('start: refuses what it cannot copy, before the engine', async () => {
  const { exp, put, host, disk, sizes } = setup();
  assert.deepEqual(await exp.start('0000000000000099', { kind: 'gif' }), { ok: false, error: 'not_found' });
  const shot = await put('screenshot');
  assert.deepEqual(await exp.start(shot.id, { kind: 'gif' }), { ok: false, error: 'not_video' });
  const rec = await put('recording');
  assert.deepEqual(await exp.start(rec.id, { kind: 'fit', mb: -1 }), { ok: false, error: 'bad_size' });
  // Already under the size: a copy would only come out bigger (9.3 MB asked to fit 25 made 22.5 MB).
  sizes.set(rec.file, 9.3e6);
  assert.deepEqual(await exp.start(rec.id, { kind: 'fit', mb: 25 }), { ok: false, error: 'already_small' });
  disk.delete(rec.file);
  assert.deepEqual(await exp.start(rec.id, { kind: 'gif' }), { ok: false, error: 'not_found' });
  assert.equal(host.sent.length, 0);
  const off = setup({ host: fakeHost({ available: false }) });
  const r2 = await off.put('recording');
  assert.deepEqual(await off.exp.start(r2.id, { kind: 'gif' }), { ok: false, error: 'unavailable' });
});

test('a GIF: one at a time, progress, then a new capture beside the original', async () => {
  const { exp, put, host, store, progress, ended } = setup();
  const rec = await put('recording', { webcam: 'br' });
  const s = await exp.start(rec.id, { kind: 'gif' });
  assert.equal(s.ok, true);
  assert.equal(s.kind, 'gif');
  assert.deepEqual(await exp.start(rec.id, { kind: 'vertical' }), { ok: false, error: 'busy' });
  const req = exportReq(host);
  assert.equal(req.src, rec.file);
  assert.match(req.out, / GIF\.gif$/);
  assert.equal(req.seconds, 30);
  assert.equal(exp.status().exporting, true);
  assert.equal(exp.status().from, 'gallery');
  host.emit({ event: 'export_progress', token: 'someone-else', pct: 50 });
  host.emit({ event: 'export_progress', token: req.token, pct: 42.4 });
  assert.deepEqual(progress.map(p => p.pct), [0, 42]);
  assert.ok(progress.every(p => p.id === rec.id && p.from === 'gallery'));
  host.emit({ event: 'export_done', token: req.token, width: 480, height: 270, bytes: 1234 });
  const r = await s.done;
  assert.equal(r.ok, true);
  assert.equal(r.bytes, 1234);
  const copy = store.get(r.entry.id);
  assert.equal(copy.kind, 'gif');
  assert.equal(copy.width, 480);
  assert.equal(copy.webcam, undefined); // the picture is not the same any more
  assert.equal(store.get(rec.id).file, rec.file);
  assert.equal(ended.length, 1);
  assert.equal(ended[0].id, rec.id);
  assert.equal(exp.status().exporting, false);
});

test('a smaller copy keeps the kind and the webcam; `from` is told back', async () => {
  const { exp, put, host, store, ended } = setup();
  const rec = await put('recording', { webcam: 'tl' });
  const s = await exp.start(rec.id, { kind: 'fit', mb: 25, from: 'action' });
  const req = exportReq(host);
  assert.equal(req.mb, 25);
  assert.match(req.out, / 25 MB\.mp4$/);
  host.emit({ event: 'export_done', token: req.token, width: 1280, height: 720, bytes: 24e6 });
  const r = await s.done;
  const copy = store.get(r.entry.id);
  assert.equal(copy.kind, 'recording');
  assert.equal(copy.webcam, 'tl');
  assert.equal(ended[0].from, 'action');
});

test('engine errors are named; an unknown one is export_failed', async () => {
  const { exp, put, host } = setup();
  const rec = await put('recording');
  let s = await exp.start(rec.id, { kind: 'fit', mb: 10 });
  host.emit({ event: 'export_done', token: exportReq(host).token, error: 'too_long' });
  assert.deepEqual(await s.done, { ok: false, error: 'too_long' });
  host.sent.length = 0;
  s = await exp.start(rec.id, { kind: 'gif' });
  host.emit({ event: 'export_done', token: exportReq(host).token, error: 'weird' });
  assert.deepEqual(await s.done, { ok: false, error: 'export_failed' });
});

test('past its time the copy is stopped in the engine', async () => {
  const timers = fakeTimers();
  const { exp, put, host } = setup({ timers });
  const rec = await put('recording');
  const s = await exp.start(rec.id, { kind: 'gif' });
  timers.fire();
  assert.deepEqual(await s.done, { ok: false, error: 'timeout' });
  assert.ok(host.sent.some(x => x.cmd === 'export_cancel'));
  assert.equal(exp.status().exporting, false);
});

test('cancel reaches the engine only while a copy runs', async () => {
  const { exp, put, host } = setup();
  assert.deepEqual(await exp.cancel(), { ok: false, error: 'not_exporting' });
  const rec = await put('recording');
  const s = await exp.start(rec.id, { kind: 'gif' });
  assert.deepEqual(await exp.cancel(), { ok: true });
  host.emit({ event: 'export_done', token: exportReq(host).token, error: 'cancelled' });
  assert.deepEqual(await s.done, { ok: false, error: 'cancelled' });
});

test('a refused request frees the slot', async () => {
  const host = fakeHost({ answer: cmd => (cmd === 'export' ? { ok: false, error: 'busy' } : { ok: true }) });
  const { exp, put } = setup({ host });
  const rec = await put('recording');
  const s = await exp.start(rec.id, { kind: 'gif' });
  assert.equal((await s.done).ok, false);
  assert.equal(exp.status().exporting, false);
});

test('capability: the Deck choice and Bit\'s size become the right request', () => {
  const o = exportCap.optionsOf;
  assert.deepEqual(o({ as: 'vertical' }), { kind: 'vertical' });
  assert.deepEqual(o({ as: 'vertical', focus: 'left' }), { kind: 'vertical', focus: 'left' });
  assert.deepEqual(o({ as: 'vertical', focus: 'sideways' }), { kind: 'vertical' });
  assert.deepEqual(o({ as: 'vertical_cam' }), { kind: 'vertical', webcam: true });
  assert.deepEqual(o({ as: 'fit25' }), { kind: 'fit', mb: 25 });
  assert.deepEqual(o({ as: 'gif' }), { kind: 'gif' });
  // validateAction fills a missing `as` with "vertical": `mb` still wins.
  assert.deepEqual(o({ as: 'vertical', mb: '8' }), { kind: 'fit', mb: 8 });
  const action = validateAction({ type: 'exportCapture', mb: 8 });
  assert.deepEqual(o(action), { kind: 'fit', mb: 8 });
  assert.equal(validateAction({ type: 'exportCapture', as: 'nope' }).as, 'vertical');
});

test('capability: answers at once, Bit waits for the copy', async () => {
  const { exp, put, host, store } = setup();
  const d = { capture: { store: () => store, exports: () => exp } };
  assert.deepEqual(await exportCap.run(d, {}), { ok: false, error: 'no_file' });
  const older = await put('recording');
  const newest = await put('replay');
  const r = await exportCap.run(d, { as: 'gif' });
  assert.deepEqual(r, { ok: true, id: newest.id, name: newest.name, kind: 'gif', working: true });
  assert.equal(exp.status().from, 'action');
  assert.deepEqual(await exportCap.run(d, { id: older.id }), { ok: false, error: 'busy' });
  const waiting = exportCap.waitFor(newest.id, 5000);
  host.emit({ event: 'export_done', token: exportReq(host).token, width: 480, height: 270, bytes: 999 });
  const end = await waiting;
  assert.equal(end.ok, true);
  assert.equal(end.bytes, 999);
  assert.match(end.copy, /GIF\.gif$/);
  assert.equal(await exportCap.waitFor(newest.id, 10), null); // nothing pending any more
  assert.deepEqual(await exportCap.run(d, { name: 'nothing like it' }), { ok: false, error: 'not_found' });
  assert.deepEqual(await exportCap.run({}, {}), { ok: false, error: 'unavailable' });
});

test('capability: a copy longer than the turn says it is still working', async () => {
  const { exp, put, store, host } = setup({ timers: fakeTimers() });
  const d = { capture: { store: () => store, exports: () => exp } };
  const rec = await put('recording');
  await exportCap.run(d, { id: rec.id });
  assert.deepEqual(await exportCap.waitFor(rec.id, 5), { working: true });
  host.emit({ event: 'export_done', token: exportReq(host).token, error: 'cancelled' });
});

test('catalog: a safe capture key, `as` is the Deck\'s only control', () => {
  const cap = CAPABILITIES.find(c => c.type === 'exportCapture');
  assert.equal(cap.capability.risk, 'safe');
  assert.equal(cap.capability.ai.name, 'export_capture');
  assert.deepEqual(cap.params.filter(p => p.kind !== 'hidden').map(p => p.name), ['as']);
  assert.deepEqual(Object.keys(exportCap.AS).sort(), cap.params[0].options.slice().sort());
  const list = CAPABILITIES.find(c => c.type === 'galleryList');
  assert.ok(list.params[0].options.includes('gif'));
});
