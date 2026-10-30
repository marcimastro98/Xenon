// "Clips from marks": a short copy around each marked moment of a saved video.
// Pinned here: the stretches (15 s before to 5 after, merged up to 60 s, at
// most 20, the user's marks before the stutters), the gallery cuts them one
// after the other beside the original and holds the trim lock, a failure
// midway keeps what was made; the capability picks the video and the choice;
// the route, the phone, the Deck and the gallery button are wired.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { markWindows, MAX_CLIPS } = require('../capture-autoclips.js');
const { createCaptureGallery } = require('../capture-gallery.js');
const { createCaptures } = require('../captures.js');
const markClips = require('../capabilities/mark-clips.js');

const ROOT = path.join(os.tmpdir(), 'gal-clips');
const tick = () => new Promise((r) => setImmediate(r));
const mark = (at) => ({ at, kind: 'mark' });
const stutter = (at) => ({ at, kind: 'stutter' });

test('markWindows: 15 s before to 5 after, held inside the video', () => {
  assert.deepEqual(markWindows([mark(30)], 120), [{ start: 15, end: 35 }]);
  assert.deepEqual(markWindows([mark(4)], 120), [{ start: 0, end: 9 }], 'near the start');
  assert.deepEqual(markWindows([mark(118)], 120), [{ start: 103, end: 120 }], 'near the end');
  assert.deepEqual(markWindows([mark(30.04)], 120), [{ start: 15, end: 35 }], 'rounded to 0.1');
});

test('markWindows: close moments share one clip up to 60 s, far ones get their own', () => {
  assert.deepEqual(markWindows([mark(40), mark(30)], 300), [{ start: 15, end: 45 }], 'sorted and merged');
  assert.deepEqual(markWindows([mark(30), mark(100)], 300), [{ start: 15, end: 35 }, { start: 85, end: 105 }]);
  // A chain of marks every 10 s: each clip stops before 60 s.
  const chain = markWindows(Array.from({ length: 10 }, (_, i) => mark(20 + i * 10)), 600);
  assert.ok(chain.length > 1);
  for (const w of chain) assert.ok(w.end - w.start <= 60, JSON.stringify(w));
});

test('markWindows: the user\'s marks first, stutters only when asked or when there are none', () => {
  const both = [stutter(20), mark(100)];
  assert.deepEqual(markWindows(both, 300, 'auto'), [{ start: 85, end: 105 }]);
  assert.deepEqual(markWindows(both, 300, 'marks'), [{ start: 85, end: 105 }]);
  assert.deepEqual(markWindows(both, 300, 'all'), [{ start: 5, end: 25 }, { start: 85, end: 105 }]);
  assert.deepEqual(markWindows([stutter(20)], 300, 'auto'), [{ start: 5, end: 25 }]);
  assert.deepEqual(markWindows([stutter(20)], 300, 'marks'), []);
});

test('markWindows: no clip that would be the whole video, nothing from junk, at most 20', () => {
  assert.deepEqual(markWindows([mark(10)], 15), [], 'a 15 s video is already the clip');
  // Found on a real replay: a 21 s auto clip with its mark at 16.1 s gave a 20 s "clip".
  assert.deepEqual(markWindows([mark(16.1)], 21.07), []);
  assert.deepEqual(markWindows([mark(2), mark(14.1), mark(24.1)], 30.15), [], 'marks spread over the whole video');
  assert.deepEqual(markWindows([mark(16)], 24), [{ start: 1, end: 21 }], '3 s left out: a clip');
  assert.deepEqual(markWindows(null, 100), []);
  assert.deepEqual(markWindows([{ at: -1, kind: 'mark' }, { at: 'x', kind: 'mark' }, null], 100), []);
  const many = markWindows(Array.from({ length: 40 }, (_, i) => mark(30 + i * 60)), 3000);
  assert.equal(many.length, MAX_CLIPS);
});

function setup({ available = true } = {}) {
  const listeners = new Set();
  const host = {
    sent: [],
    available: () => available,
    onEvent: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    emit: (ev) => { for (const fn of listeners) fn(ev); },
    async request(cmd, body) { this.sent.push({ cmd, ...body }); return { ok: true, queued: true }; },
  };
  const disk = new Set();
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
    host, store, thumbDir: path.join(ROOT, 'thumbs'),
    mkdir: async () => {}, exists: async (p) => disk.has(p), unlink: async (p) => { disk.delete(p); },
  });
  const put = async (kind, extra = {}) => {
    const p = await store.plan({ kind, game: 'Game.exe' });
    disk.add(p.file);
    return store.get(store.add({ id: p.id, kind, file: p.file, game: 'Game.exe', width: 1920, height: 1080, ...extra }).id);
  };
  // Answers each trim the engine is asked for, in order.
  async function answer(results) {
    for (const res of results) {
      const before = host.sent.length;
      for (let i = 0; i < 20 && host.sent.length === before; i++) await tick();
      const sent = host.sent[host.sent.length - 1];
      host.emit({ event: 'trim_done', token: sent.token, ...res });
    }
  }
  return { host, store, gallery, put, answer };
}

test('clips: one copy per stretch, one after the other, beside the original', async () => {
  const { host, store, gallery, put, answer } = setup();
  const v = await put('recording', { seconds: 300, markers: [mark(30), stutter(150), mark(200)] });
  const p = gallery.clips(v.id);
  await tick(); await tick();
  assert.deepEqual(await gallery.trim(v.id, { start: 0, end: 5 }), { ok: false, error: 'busy' }, 'the trim lock is held');
  await answer([{ start: 15, seconds: 20 }, { start: 185, seconds: 20 }]);
  const r = await p;
  assert.equal(r.ok, true);
  assert.equal(r.clips, 2);
  assert.equal(r.of, 2);
  assert.deepEqual(host.sent.map(s => [s.cmd, s.start, s.end]), [['trim', 15, 35], ['trim', 185, 205]]);
  for (const s of host.sent) {
    assert.equal(s.src, v.file);
    assert.match(path.basename(s.out), / Clip( \(\d+\))?\.mp4$/);
  }
  assert.equal(new Set(host.sent.map(s => s.out)).size, 2, 'two files, not one written twice');
  assert.ok(store.get(v.id), 'the original stays');
  assert.equal(r.entries.length, 2);
  assert.equal(r.entries[0].file, undefined, 'no path on the wire');
  assert.deepEqual(store.get(r.entries[0].id).markers, [{ at: 15, kind: 'mark' }], 'the mark moves with the copy');
});

test('clips: a failure midway keeps what was made; the first failing gives the error', async () => {
  const a = setup();
  const v = await a.put('replay', { seconds: 300, markers: [mark(30), mark(200)] });
  const p = a.gallery.clips(v.id);
  await a.answer([{ start: 15, seconds: 20 }, { error: 'disk_full' }]);
  const r = await p;
  assert.deepEqual([r.ok, r.clips, r.of, r.stopped], [true, 1, 2, 'disk_full']);

  const b = setup();
  const w = await b.put('replay', { seconds: 300, markers: [mark(30)] });
  const q = b.gallery.clips(w.id);
  await b.answer([{ error: 'disk_full' }]);
  assert.deepEqual(await q, { ok: false, error: 'disk_full' });
  // The lock is free again.
  const again = b.gallery.trim(w.id, { start: 0, end: 5 });
  await b.answer([{ start: 0, seconds: 5 }]);
  assert.equal((await again).ok, true);
});

test('clips: refused before the engine', async () => {
  const { host, gallery, put } = setup();
  const shot = await put('screenshot');
  const bare = await put('recording', { seconds: 60 });
  const short = await put('recording', { seconds: 10, markers: [mark(6)] });
  const stutters = await put('recording', { seconds: 300, markers: [stutter(100)] });
  assert.deepEqual(await gallery.clips('nope'), { ok: false, error: 'not_found' });
  assert.deepEqual(await gallery.clips(shot.id), { ok: false, error: 'not_video' });
  assert.deepEqual(await gallery.clips(bare.id), { ok: false, error: 'no_marks' });
  assert.deepEqual(await gallery.clips(short.id), { ok: false, error: 'whole_video' });
  assert.deepEqual(await gallery.clips(stutters.id, { which: 'marks' }), { ok: false, error: 'whole_video' });
  assert.equal(host.sent.length, 0);
  const off = setup({ available: false });
  const v = await off.put('recording', { seconds: 300, markers: [mark(30)] });
  assert.deepEqual(await off.gallery.clips(v.id), { ok: false, error: 'unavailable' });
});

test('the list says how many clips a video would give, only when there are some', async () => {
  const { store, put } = setup();
  const long = await put('replay', { seconds: 300, markers: [mark(30), mark(200)] });
  const auto = await put('replay', { seconds: 21.07, markers: [mark(16.1)] });
  const bare = await put('recording', { seconds: 60 });
  const pub = (id) => store.list({ kind: '', limit: 50 }).find(e => e.id === id);
  assert.equal(pub(long.id).clips, 2);
  assert.equal(pub(auto.id).clips, undefined, 'an auto clip offers no clips of itself');
  assert.equal(pub(bare.id).clips, undefined);
});

test('capability: picks the newest video or the named one, passes only known choices', async () => {
  const calls = [];
  const entries = [
    { id: 'aaaaaaaaaaaaaaaa', kind: 'recording', name: 'Game 1.mp4', createdAt: 2 },
    { id: 'bbbbbbbbbbbbbbbb', kind: 'screenshot', name: 'Shot.png', createdAt: 3 },
  ];
  const d = {
    capture: {
      host: { available: () => true },
      store: () => ({
        list: () => entries, get: (id) => entries.find(e => e.id === id),
        last: async (kind) => entries.find(e => e.kind === kind) || null,
      }),
      clips: async (id, which) => { calls.push([id, which]); return { ok: true, clips: 1 }; },
    },
  };
  assert.deepEqual(await markClips.run(d, {}), { ok: true, clips: 1 });
  assert.deepEqual(await markClips.run(d, { which: 'all' }), { ok: true, clips: 1 });
  assert.deepEqual(await markClips.run(d, { which: 'everything' }), { ok: true, clips: 1 });
  assert.deepEqual(calls, [['aaaaaaaaaaaaaaaa', 'auto'], ['aaaaaaaaaaaaaaaa', 'all'], ['aaaaaaaaaaaaaaaa', 'auto']]);
  assert.deepEqual(await markClips.run(d, { name: 'Nope.mp4' }), { ok: false, error: 'not_found' });
  assert.deepEqual(await markClips.run({ capture: { host: { available: () => false } } }, {}), { ok: false, error: 'unavailable' });
  assert.deepEqual(markClips.WHICH, ['auto', 'marks', 'all']);
});

test('wired: route, CSRF, phone, Deck error words, gallery button', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const server = read('../server.js');
  assert.match(server, /'\/captures\/clips'/);
  assert.match(server, /json\(await makeMarkClips\(String\(\(body && body\.id\) \|\| ''\), body && body\.which\)\)/);
  assert.match(server, /broadcastSSE\('captures', \{ changed: true \}\)/);
  assert.match(read('../remote-access.js'), /'\/captures\/clips'/);
  assert.match(read('../capabilities/index.js'), /case 'markClips': return markClips\.run\(d, action\)/);
  const errors = read('../js/deck-error-text.js');
  assert.match(errors, /no_marks: \['capg_clips_err_none'/);
  assert.match(errors, /whole_video: \['capg_clips_err_whole'/);
  const viewer = read('../js/capture-gallery-viewer.js');
  assert.equal((viewer.match(/e\.clips > 0\) actions\.appendChild\(btn\(tr\('capg_clips'/g) || []).length, 2, 'on the PC and on the phone');
  assert.match(viewer, /act\('\/captures\/clips'/);
  assert.match(read('../js/deck-editor.js'), /markClips: _ai\(/);
});
