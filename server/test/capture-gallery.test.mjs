// capture-gallery.js: previews, trims, clipboard copy for the gallery.
// Pinned here: a preview is made once (two at a time, the same id asked twice
// shares the job), a file the engine cannot read is not asked again, the
// engine gets paths only from the index; a trim refuses bad ranges before the
// engine, runs one at a time, lands beside the original as a new capture and
// says where it really starts; deleting a capture deletes its preview.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createCaptureGallery } = require('../capture-gallery.js');
const { createCaptures } = require('../captures.js');

const ROOT = path.join(os.tmpdir(), 'gal');
const THUMBS = path.join(ROOT, 'thumbs');

function fakeHost({ available = true, answer } = {}) {
  const listeners = new Set();
  const sent = [];
  const held = [];
  return {
    sent, held,
    available: () => available,
    onEvent: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    emit: (ev) => { for (const fn of listeners) fn(ev); },
    async request(cmd, body) {
      sent.push({ cmd, ...body });
      if (answer) return answer(cmd, body, this);
      return { ok: true, queued: true };
    },
  };
}

function setup({ host = fakeHost(), files } = {}) {
  const disk = files || new Set();
  const unlinked = [];
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
  const gallery = createCaptureGallery({
    host, store, thumbDir: THUMBS,
    mkdir: async () => {},
    exists: async (p) => disk.has(p),
    unlink: async (p) => { unlinked.push(p); disk.delete(p); },
  });
  const put = async (kind, extra = {}) => {
    const p = await store.plan({ kind, game: 'Game.exe' });
    disk.add(p.file);
    return store.get(store.add({ id: p.id, kind, file: p.file, game: 'Game.exe', width: 1920, height: 1080, ...extra }).id);
  };
  return { host, store, gallery, disk, unlinked, put };
}

const tick = () => new Promise((r) => setImmediate(r));

test('a preview is made once: the engine gets the path from the index, the cache answers next time', async () => {
  const { host, gallery, disk, put } = setup();
  const shot = await put('screenshot');
  const p = gallery.thumb(shot.id);
  await tick();
  assert.equal(host.sent.length, 1);
  assert.deepEqual(host.sent[0], { cmd: 'thumb', src: shot.file, out: path.join(THUMBS, `${shot.id}.jpg`), width: 480, video: false, token: `thumb-${shot.id}` });
  disk.add(host.sent[0].out);
  host.emit({ event: 'thumb_done', token: host.sent[0].token, width: 1920, height: 1080 });
  assert.equal(await p, path.join(THUMBS, `${shot.id}.jpg`));
  assert.equal(await gallery.thumb(shot.id), path.join(THUMBS, `${shot.id}.jpg`));
  assert.equal(host.sent.length, 1, 'cached: no second job');
});

test('the same preview asked twice shares one job; at most two run at once', async () => {
  const { host, gallery, put } = setup();
  const v = [await put('recording', { seconds: 5 }), await put('recording', { seconds: 5 }), await put('screenshot')];
  const a = gallery.thumb(v[0].id);
  const a2 = gallery.thumb(v[0].id);
  const b = gallery.thumb(v[1].id);
  const c = gallery.thumb(v[2].id);
  await tick();
  assert.deepEqual(host.sent.map((s) => s.src), [v[0].file, v[1].file], 'the third waits');
  assert.equal(host.sent[0].video, true);
  host.emit({ event: 'thumb_done', token: host.sent[0].token, width: 1, height: 1 });
  await tick(); await tick();
  assert.equal(host.sent.length, 3, 'a slot freed: the third starts');
  host.emit({ event: 'thumb_done', token: host.sent[1].token, width: 1, height: 1 });
  host.emit({ event: 'thumb_done', token: host.sent[2].token, width: 1, height: 1 });
  const [ra, ra2] = await Promise.all([a, a2, b, c]);
  assert.equal(ra, ra2);
});

test('a file the engine cannot read is not asked again; an engine that went away is', async () => {
  const { host, gallery, put } = setup();
  const s = await put('screenshot');
  let p = gallery.thumb(s.id);
  await tick();
  host.emit({ event: 'engine_exited' });
  assert.equal(await p, null);
  p = gallery.thumb(s.id);
  await tick();
  assert.equal(host.sent.length, 2, 'asked again after the engine died');
  host.emit({ event: 'thumb_done', token: host.sent[1].token, error: 'thumb_failed' });
  assert.equal(await p, null);
  assert.equal(await gallery.thumb(s.id), null);
  assert.equal(host.sent.length, 2, 'not a third time');
});

test('no preview for an unknown id, a file deleted from disk, or without the engine', async () => {
  const { host, gallery, disk, put } = setup();
  const s = await put('screenshot');
  assert.equal(await gallery.thumb('../../etc/passwd'), null);
  assert.equal(await gallery.thumb('f'.repeat(16)), null);
  disk.delete(s.file);
  assert.equal(await gallery.thumb(s.id), null);
  assert.equal(host.sent.length, 0);
  const off = setup({ host: fakeHost({ available: false }) });
  const s2 = await off.put('screenshot');
  assert.equal(await off.gallery.thumb(s2.id), null);
});

test('a refused request (engine missing) answers null at once', async () => {
  const host = fakeHost({ answer: () => ({ ok: false, error: 'unavailable' }) });
  const { gallery, put } = setup({ host });
  const s = await put('screenshot');
  assert.equal(await gallery.thumb(s.id), null);
});

test('trim: bad ranges are refused before the engine; the end is held to the clip', async () => {
  const { host, gallery, put } = setup();
  const v = await put('recording', { seconds: 10 });
  const s = await put('screenshot');
  assert.deepEqual(await gallery.trim(s.id, { start: 0, end: 1 }), { ok: false, error: 'not_video' });
  assert.deepEqual(await gallery.trim('nope', { start: 0, end: 1 }), { ok: false, error: 'not_found' });
  assert.deepEqual(await gallery.trim(v.id, { start: -1, end: 4 }), { ok: false, error: 'bad_range' });
  assert.deepEqual(await gallery.trim(v.id, { start: 'a', end: 4 }), { ok: false, error: 'bad_range' });
  assert.deepEqual(await gallery.trim(v.id, { start: 3, end: 3.2 }), { ok: false, error: 'too_short' });
  assert.deepEqual(await gallery.trim(v.id, { start: 9.8, end: 60 }), { ok: false, error: 'too_short' }, 'past the end');
  assert.equal(host.sent.length, 0);
});

test('trim: a new capture beside the original, real start reported, one at a time', async () => {
  const { host, store, gallery, put } = setup();
  const v = await put('replay', { seconds: 30, hdr: true });
  const p = gallery.trim(v.id, { start: 4.4, end: 12 });
  await tick(); await tick();
  assert.deepEqual(await gallery.trim(v.id, { start: 1, end: 3 }), { ok: false, error: 'busy' });
  const sent = host.sent[0];
  assert.equal(sent.cmd, 'trim');
  assert.equal(sent.src, v.file);
  assert.equal(path.dirname(sent.out), path.dirname(v.file));
  assert.match(path.basename(sent.out), / Trim\.mp4$/);
  assert.deepEqual([sent.start, sent.end], [4.4, 12]);
  host.emit({ event: 'trim_done', token: sent.token, start: 4, seconds: 8.02 });
  const r = await p;
  assert.equal(r.ok, true);
  assert.equal(r.start, 4);
  assert.equal(r.entry.kind, 'replay');
  assert.equal(r.entry.game, 'Game.exe');
  assert.equal(r.entry.seconds, 8.02);
  assert.equal(r.entry.hdr, true);
  assert.equal(r.entry.file, undefined, 'no path on the wire');
  assert.notEqual(r.entry.id, v.id);
  assert.ok(store.get(v.id), 'the original stays');
  assert.equal(store.get(r.entry.id).file, sent.out);
  // Free again.
  const q = gallery.trim(v.id, { start: 0, end: 2 });
  await tick(); await tick();
  host.emit({ event: 'trim_done', token: host.sent[1].token, error: 'disk_full' });
  assert.deepEqual(await q, { ok: false, error: 'disk_full' });
});

test('trim: a trimmed timelapse is still a timelapse', async () => {
  const { host, store, gallery, put } = setup();
  const v = await put('recording', { seconds: 20, lapse: 5 });
  assert.equal(v.lapse, 5);
  const p = gallery.trim(v.id, { start: 2, end: 10 });
  await tick(); await tick();
  host.emit({ event: 'trim_done', token: host.sent[0].token, start: 2, seconds: 8 });
  const r = await p;
  assert.equal(r.entry.lapse, 5);
  assert.equal(store.get(r.entry.id).lapse, 5);
});

test('trim: an engine error code outside the known ones becomes trim_failed', async () => {
  const { host, gallery, put } = setup();
  const v = await put('recording', { seconds: 30 });
  const p = gallery.trim(v.id, { start: 0, end: 5 });
  await tick(); await tick();
  host.emit({ event: 'trim_done', token: host.sent[0].token, error: 'C:\\secret\\path' });
  assert.deepEqual(await p, { ok: false, error: 'trim_failed' });
});

test('copy: the path goes to the engine, never back; unknown ids refused', async () => {
  const { host, gallery, put } = setup();
  const v = await put('recording', { seconds: 3 });
  assert.deepEqual(await gallery.copy(v.id), { ok: true });
  assert.deepEqual(host.sent[0], { cmd: 'copy_files', paths: [v.file] });
  assert.deepEqual(await gallery.copy('x'), { ok: false, error: 'not_found' });
  const busy = setup({ host: fakeHost({ answer: () => ({ ok: false, error: 'clipboard_busy' }) }) });
  const w = await busy.put('screenshot');
  assert.deepEqual(await busy.gallery.copy(w.id), { ok: false, error: 'copy_failed' });
});

test('forget deletes the preview of a capture that is gone', async () => {
  const { gallery, unlinked } = setup();
  gallery.forget('a'.repeat(16));
  await tick();
  assert.deepEqual(unlinked, [path.join(THUMBS, `${'a'.repeat(16)}.jpg`)]);
});
