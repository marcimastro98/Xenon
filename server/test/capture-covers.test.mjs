// capture-covers.js + capture-jobs.js: the screenshot editor's server side.
// Pinned here: the engine gets paths only from the index; spots come back
// checked (known kinds, whole pixels inside the picture); a cover writes a copy
// beside the original only when something was found; a save takes only a PNG
// of the original's size, writes it through a .part file, and adds a new
// capture; one write at a time; an engine that dies or never answers settles
// the job instead of hanging it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createCaptureCovers, pngSize, cleanSpots, MAX_PNG_BYTES } = require('../capture-covers.js');
const { createEngineJobs } = require('../capture-jobs.js');
const { createCaptures } = require('../captures.js');

const ROOT = path.join(os.tmpdir(), 'covers');

function png(width, height, extra = 0) {
  const b = Buffer.alloc(33 + extra);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

// An engine that answers `cover` with `reply(body)` as the event, unless told
// to stay silent or to die.
function fakeHost({ available = true, reply, refuse } = {}) {
  const listeners = new Set();
  const sent = [];
  const host = {
    sent,
    available: () => available,
    onEvent: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    emit: (ev) => { for (const fn of listeners) fn(ev); },
    async request(cmd, body) {
      sent.push({ cmd, ...body });
      if (refuse) return { ok: false, error: refuse };
      if (reply) setImmediate(() => host.emit({ event: 'cover_done', token: body.token, ...reply(body) }));
      return { ok: true, queued: true };
    },
  };
  return host;
}

function setup({ host = fakeHost(), timers } = {}) {
  const disk = new Set();
  const writes = [];
  const renames = [];
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
  const covers = createCaptureCovers({
    host, store,
    exists: async (p) => disk.has(p),
    writeFile: async (p, buf) => { writes.push({ p, size: buf.length }); disk.add(p); },
    rename: async (a, b) => { renames.push([a, b]); disk.delete(a); disk.add(b); },
    unlink: async (p) => { disk.delete(p); },
    ...(timers ? { timers } : {}),
  });
  const put = async (kind = 'screenshot') => {
    const p = await store.plan({ kind, game: 'Game.exe' });
    disk.add(p.file);
    return store.get(store.add({ id: p.id, kind, file: p.file, game: 'Game.exe', width: 1920, height: 1080 }).id);
  };
  return { host, store, covers, disk, writes, renames, put };
}

const SPOT = { kind: 'email', x: 10, y: 20, w: 300, h: 40 };

test('pngSize reads a PNG header and nothing else', () => {
  assert.deepEqual(pngSize(png(1920, 1080)), { width: 1920, height: 1080 });
  assert.equal(pngSize(Buffer.from('GIF89a................................')), null);
  assert.equal(pngSize(png(0, 1080)), null);
  assert.equal(pngSize(Buffer.alloc(10)), null);
  assert.equal(pngSize('not a buffer'), null);
});

test('cleanSpots keeps known kinds with whole pixels inside the picture', () => {
  const list = [
    SPOT,
    { kind: 'iban', x: 0, y: 0, w: 1920, h: 1080 },
    { kind: 'name', x: 1, y: 1, w: 5, h: 5 },
    { kind: 'number', x: 1.5, y: 1, w: 5, h: 5 },
    { kind: 'number', x: 1900, y: 1, w: 50, h: 5 },
    { kind: 'number', x: -1, y: 1, w: 5, h: 5 },
    { kind: 'number', x: 1, y: 1, w: 0, h: 5 },
    null,
  ];
  assert.deepEqual(cleanSpots(list, 1920, 1080), [SPOT, { kind: 'iban', x: 0, y: 0, w: 1920, h: 1080 }]);
  assert.deepEqual(cleanSpots('nope', 100, 100), []);
  assert.equal(cleanSpots(Array.from({ length: 500 }, () => SPOT), 1920, 1080).length, 200);
});

test('spots: the engine reads the indexed file, rectangles come back without any text', async () => {
  const host = fakeHost({ reply: () => ({ width: 1920, height: 1080, spots: [{ ...SPOT, text: 'a@b.c' }] }) });
  const { covers, put } = setup({ host });
  const shot = await put();
  const r = await covers.spots(shot.id);
  assert.deepEqual(r, { ok: true, width: 1920, height: 1080, spots: [SPOT] });
  assert.equal(host.sent[0].cmd, 'cover');
  assert.equal(host.sent[0].src, shot.file);
  assert.equal('out' in host.sent[0], false);
});

test('spots: unknown id, a video, no engine, an engine error', async () => {
  const { covers, put } = setup();
  assert.deepEqual(await covers.spots('ffffffffffffffff'), { ok: false, error: 'not_found' });
  const video = await put('recording');
  assert.deepEqual(await covers.spots(video.id), { ok: false, error: 'not_picture' });

  const off = setup({ host: fakeHost({ available: false }) });
  assert.deepEqual(await off.covers.spots((await off.put()).id), { ok: false, error: 'unavailable' });

  const noLang = setup({ host: fakeHost({ reply: () => ({ error: 'no_ocr_language' }) }) });
  assert.deepEqual(await noLang.covers.spots((await noLang.put()).id), { ok: false, error: 'no_ocr_language' });

  const odd = setup({ host: fakeHost({ reply: () => ({ error: 'something_else' }) }) });
  assert.deepEqual(await odd.covers.spots((await odd.put()).id), { ok: false, error: 'cover_failed' });
});

test('cover: a copy beside the original when something was found, none otherwise', async () => {
  const host = fakeHost({ reply: () => ({ width: 1920, height: 1080, spots: [SPOT, { ...SPOT, kind: 'number' }, SPOT] }) });
  const { covers, store, put } = setup({ host });
  const shot = await put();
  const r = await covers.cover(shot.id);
  assert.equal(r.ok, true);
  assert.equal(r.covered, 3);
  assert.deepEqual(r.found, { email: 2, number: 1 });
  assert.equal(host.sent[0].out, path.join(path.dirname(shot.file), path.basename(shot.file, '.png') + ' Covered.png'));
  const copy = store.get(r.entry.id);
  assert.equal(copy.file, host.sent[0].out);
  assert.equal(copy.kind, 'screenshot');
  assert.equal('file' in r.entry, false, 'no path on the wire');

  const none = setup({ host: fakeHost({ reply: () => ({ width: 1920, height: 1080, spots: [] }) }) });
  const shot2 = await none.put();
  assert.deepEqual(await none.covers.cover(shot2.id), { ok: true, covered: 0, found: {} });
});

test('save: only a PNG of the original size, through a .part file, as a new capture', async () => {
  const { covers, store, put, writes, renames } = setup();
  const shot = await put();
  assert.deepEqual(await covers.save(shot.id, Buffer.from('not a png')), { ok: false, error: 'bad_image' });
  assert.deepEqual(await covers.save(shot.id, png(1280, 720)), { ok: false, error: 'bad_image' });
  assert.deepEqual(await covers.save(shot.id, 'text'), { ok: false, error: 'too_large' });
  assert.equal(writes.length, 0);

  const r = await covers.save(shot.id, png(1920, 1080));
  assert.equal(r.ok, true);
  const target = path.join(path.dirname(shot.file), path.basename(shot.file, '.png') + ' Edited.png');
  assert.deepEqual(writes, [{ p: target + '.part', size: 33 }]);
  assert.deepEqual(renames, [[target + '.part', target]]);
  assert.equal(store.get(r.entry.id).file, target);
  assert.equal(r.entry.width, 1920);
  assert.equal('file' in r.entry, false);

  // A second edit of the same picture does not overwrite the first.
  const again = await covers.save(shot.id, png(1920, 1080));
  assert.equal(store.get(again.entry.id).file, target.replace(' Edited.png', ' Edited (2).png'));
  assert.ok(MAX_PNG_BYTES >= 32 * 1024 * 1024);
});

test('save: a failed write leaves no .part and no entry; a video is refused', async () => {
  const s = setup();
  const shot = await s.put();
  const video = await s.put('recording');
  assert.deepEqual(await s.covers.save(video.id, png(1920, 1080)), { ok: false, error: 'not_picture' });
  assert.deepEqual(await s.covers.save('ffffffffffffffff', png(1920, 1080)), { ok: false, error: 'not_found' });

  const broken = createCaptureCovers({
    host: fakeHost(), store: s.store,
    exists: async (p) => s.disk.has(p),
    writeFile: async () => { throw new Error('disk full'); },
    rename: async () => {},
    unlink: async (p) => { s.disk.delete(p); },
  });
  assert.deepEqual(await broken.save(shot.id, png(1920, 1080)), { ok: false, error: 'write_failed' });
});

test('one write at a time: a second cover while one runs is busy', async () => {
  let release;
  const host = fakeHost();
  host.request = async (cmd, body) => {
    host.sent.push({ cmd, ...body });
    release = () => host.emit({ event: 'cover_done', token: body.token, width: 1920, height: 1080, spots: [] });
    return { ok: true, queued: true };
  };
  const { covers, put } = setup({ host });
  const shot = await put();
  const first = covers.cover(shot.id);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(await covers.cover(shot.id), { ok: false, error: 'busy' });
  assert.deepEqual(await covers.save(shot.id, png(1920, 1080)), { ok: false, error: 'busy' });
  release();
  assert.equal((await first).ok, true);
  // Free again once it is done.
  assert.equal((await covers.save(shot.id, png(1920, 1080))).ok, true);
});

test('engine jobs: the matching token settles, a refused request answers its code', async () => {
  const host = fakeHost();
  const { job } = createEngineJobs(host, ['cover_done']);
  const p = job('cover', { src: 'x' }, 't1', 5000);
  await new Promise((r) => setImmediate(r));
  host.emit({ event: 'cover_done', token: 'other', width: 1 });
  host.emit({ event: 'thumb_done', token: 't1', width: 2 });
  host.emit({ event: 'cover_done', token: 't1', width: 3 });
  assert.equal((await p).width, 3);

  const refused = createEngineJobs(fakeHost({ refuse: 'unsupported' }), ['cover_done']);
  assert.deepEqual(await refused.job('cover', {}, 't2', 5000), { error: 'unsupported' });
});

test('engine jobs: a dead engine or a silent one settles instead of hanging', async () => {
  const host = fakeHost();
  const { job } = createEngineJobs(host, ['cover_done']);
  const p = job('cover', {}, 'a', 5000);
  await new Promise((r) => setImmediate(r));
  host.emit({ event: 'engine_exited' });
  assert.deepEqual(await p, { error: 'engine_exited' });

  const fired = [];
  const timers = { setTimeout: (fn) => { fired.push(fn); return fired.length; }, clearTimeout: () => {} };
  const silent = createEngineJobs(fakeHost(), ['cover_done'], timers);
  const q = silent.job('cover', {}, 'b', 30000);
  await new Promise((r) => setImmediate(r));
  fired[0]();
  assert.deepEqual(await q, { error: 'timeout' });
});
