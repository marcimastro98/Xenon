// captures.js: the index of what Xenon captured. Pinned here: files land in
// Pictures/Xenon/<game or Desktop>, two shots in one second never collide,
// nothing that leaves the server carries a path, an id can only point at a
// file Xenon wrote, and a corrupt index is set aside instead of crashing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createCaptures, normalizeEntry, labelOf, stampOf, MAX_ENTRIES } = require('../captures.js');

const PICS = path.join(os.tmpdir(), 'pics');
const T0 = new Date(2026, 9, 26, 21, 5, 9).getTime();

function make({ exists = () => false, ids, file = path.join(os.tmpdir(), 'none', 'captures.json') } = {}) {
  const writes = [];
  let n = 0;
  const store = createCaptures({
    file,
    writeFileAtomic: async (_file, body) => { writes.push(JSON.parse(body)); },
    picturesDir: async () => PICS,
    exists,
    now: () => T0,
    randomId: () => (ids ? ids[n++] : (n++).toString(16).padStart(16, '0')),
  });
  return { store, writes };
}

test('a game names the folder and the file; outside a game it is Desktop', async () => {
  const { store } = make();
  const g = await store.plan({ kind: 'screenshot', game: 'Tabletop Simulator.exe' });
  assert.equal(g.dir, path.join(PICS, 'Xenon', 'Tabletop_Simulator'));
  assert.equal(g.name, 'Tabletop_Simulator 2026-10-26 21-05-09.png');
  const d = await store.plan({ kind: 'screenshot', game: '' });
  assert.equal(d.file, path.join(PICS, 'Xenon', 'Desktop', 'Desktop 2026-10-26 21-05-09.png'));
  assert.equal(labelOf('../../evil'), 'evil');
  assert.equal(stampOf(T0), '2026-10-26 21-05-09');
});

test('two shots in the same second get " (2)", never the same file', async () => {
  const taken = new Set([path.join(PICS, 'Xenon', 'Desktop', 'Desktop 2026-10-26 21-05-09.png')]);
  const { store } = make({ exists: p => taken.has(p) });
  const p = await store.plan({ kind: 'screenshot' });
  assert.equal(p.name, 'Desktop 2026-10-26 21-05-09 (2).png');
});

test('an unknown kind is refused before anything is planned', async () => {
  const { store } = make();
  await assert.rejects(store.plan({ kind: 'exe' }), /unknown capture kind/);
});

test('ids are opaque and unique; a colliding random id is drawn again', async () => {
  const { store } = make({ ids: ['aaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'] });
  const a = await store.plan({ kind: 'screenshot' });
  store.add({ id: a.id, kind: 'screenshot', file: a.file, width: 10, height: 10 });
  const b = await store.plan({ kind: 'screenshot' });
  assert.equal(b.id, 'bbbbbbbbbbbbbbbb');
});

test('what leaves the server has no path; get() by id is the only way to one', async () => {
  const { store, writes } = make();
  const p = await store.plan({ kind: 'screenshot', game: 'game.exe' });
  const pub = store.add({ id: p.id, kind: 'screenshot', file: p.file, game: 'game.exe', width: 3840, height: 2160, hdr: true });
  assert.deepEqual(Object.keys(pub).sort(), ['createdAt', 'game', 'hdr', 'height', 'id', 'kind', 'name', 'width']);
  assert.equal(pub.name, p.name);
  assert.ok(!JSON.stringify(store.list()).includes(PICS), 'list carries no path');
  assert.equal(store.get(p.id).file, p.file);
  assert.equal(store.get('../x'), null);
  assert.equal(store.get(p.file), null);
  assert.equal(store.get(42), null);
  await store.flush();
  assert.equal(writes.length, 1, 'saved once');
});

test('"show the last one" skips screenshots deleted from disk, and says none when all are gone', async () => {
  const onDisk = new Set();
  const { store } = make({ exists: p => onDisk.has(p), ids: ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'] });
  const older = await store.plan({ kind: 'screenshot' });
  store.add({ id: older.id, kind: 'screenshot', file: older.file + '.old', width: 10, height: 10 });
  const newer = await store.plan({ kind: 'screenshot' });
  store.add({ id: newer.id, kind: 'screenshot', file: newer.file, width: 10, height: 10 });
  onDisk.add(newer.file).add(older.file + '.old');
  assert.equal((await store.last('screenshot')).id, newer.id);
  onDisk.delete(newer.file);
  assert.equal((await store.last('screenshot')).id, older.id, 'the newest was deleted: the one before it');
  onDisk.clear();
  assert.equal(await store.last('screenshot'), null);
});

test('entries that are not what add() writes are dropped', () => {
  const ok = { id: 'aaaaaaaaaaaaaaaa', kind: 'screenshot', file: path.join(PICS, 'a.png'), createdAt: 1 };
  assert.ok(normalizeEntry(ok));
  assert.equal(normalizeEntry({ ...ok, file: 'relative.png' }), null);
  assert.equal(normalizeEntry({ ...ok, id: 'x' }), null);
  assert.equal(normalizeEntry({ ...ok, kind: 'exe' }), null);
  assert.equal(normalizeEntry({ ...ok, createdAt: 'now' }), null);
  assert.equal(normalizeEntry({ ...ok, width: -1 }).width, null);
  assert.equal(normalizeEntry({ ...ok, hdr: 'yes' }).hdr, false);
});

test('a corrupt index is set aside and the store starts empty', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'captures-'));
  const file = path.join(dir, 'captures.json');
  try {
    fs.writeFileSync(file, '{not json');
    const { store } = make({ file });
    await store.load();
    assert.deepEqual(store.list(), []);
    assert.ok(fs.readdirSync(dir).some(f => f.startsWith('captures.json.corrupt-')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a saved index loads back newest first, bad rows dropped', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'captures-'));
  const file = path.join(dir, 'captures.json');
  try {
    const row = (id, t) => ({ id, kind: 'screenshot', file: path.join(PICS, id + '.png'), createdAt: t });
    fs.writeFileSync(file, JSON.stringify({ version: 1, entries: [row('aaaaaaaaaaaaaaaa', 1), row('bbbbbbbbbbbbbbbb', 2), { id: 'bad' }] }));
    const { store } = make({ file });
    await store.load();
    assert.deepEqual(store.list().map(e => e.id), ['bbbbbbbbbbbbbbbb', 'aaaaaaaaaaaaaaaa']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test(`the index keeps the newest ${MAX_ENTRIES}`, () => {
  const { store } = make();
  for (let i = 0; i < MAX_ENTRIES + 5; i++) {
    store.add({ id: i.toString(16).padStart(16, '0'), kind: 'screenshot', file: path.join(PICS, i + '.png') });
  }
  assert.equal(store.list({ limit: 1e6 }).length, 200, 'a list page is capped');
  assert.equal(store.get((0).toString(16).padStart(16, '0')), null, 'the oldest fell off');
  assert.ok(store.get((MAX_ENTRIES + 4).toString(16).padStart(16, '0')));
});

test('recordings land in Videos/Xenon as .mp4 and keep their length', async () => {
  const VIDS = path.join(os.tmpdir(), 'vids');
  const store = createCaptures({
    file: path.join(os.tmpdir(), 'none', 'captures.json'),
    writeFileAtomic: async () => {},
    picturesDir: async () => PICS,
    videosDir: async () => VIDS,
    exists: async () => false,
    now: () => T0,
    randomId: (() => { let n = 0; return () => (++n).toString(16).padStart(16, 'b'); })(),
  });
  const plan = await store.plan({ kind: 'recording', game: 'Game.exe' });
  assert.equal(plan.dir, path.join(VIDS, 'Xenon', 'Game'));
  assert.equal(plan.name, 'Game 2026-10-26 21-05-09.mp4');
  const e = store.add({ id: plan.id, kind: 'recording', file: plan.file, game: 'Game.exe', width: 1920, height: 1080, seconds: 12.3456 });
  assert.equal(e.seconds, 12.35);
  assert.equal(e.file, undefined);
  assert.equal(normalizeEntry({ ...e, file: plan.file, seconds: -1 }).seconds, null);
  assert.equal('seconds' in normalizeEntry({ id: 'c'.repeat(16), kind: 'screenshot', file: plan.file, createdAt: T0, seconds: 5 }), false);
  assert.equal((await store.plan({ kind: 'screenshot' })).dir, path.join(PICS, 'Xenon', 'Desktop'));
});

// The gallery: pages, filters, edited copies, deletion.
function gallery({ onDisk, unlinkFails } = {}) {
  const removed = [];
  const unlinked = [];
  let t = T0;
  let n = 0;
  const store = createCaptures({
    file: path.join(os.tmpdir(), 'none', 'captures.json'),
    writeFileAtomic: async () => {},
    picturesDir: async () => PICS,
    exists: async p => (onDisk ? onDisk.has(p) : true),
    now: () => t,
    randomId: () => (++n).toString(16).padStart(16, '0'),
    unlink: async (p) => {
      if (unlinkFails) { const e = new Error('busy'); e.code = unlinkFails; throw e; }
      unlinked.push(p);
    },
    stat: async () => ({ size: 100 }),
    onRemove: id => removed.push(id),
  });
  const put = async (kind, game, step = 1000) => {
    t += step;
    const p = await store.plan({ kind, game });
    return store.add({ id: p.id, kind, file: p.file, game, width: 10, height: 10, seconds: kind === 'screenshot' ? undefined : 5 });
  };
  return { store, put, removed, unlinked };
}

test('browse: newest first, a page at a time with a cursor, no paths', async () => {
  const { store, put } = gallery();
  for (let i = 0; i < 5; i++) await put('screenshot', 'Game.exe');
  const first = await store.browse({ limit: 2 });
  assert.equal(first.entries.length, 2);
  assert.equal(first.more, true);
  assert.ok(first.entries[0].createdAt > first.entries[1].createdAt);
  const next = await store.browse({ limit: 2, before: first.entries[1].createdAt });
  assert.ok(next.entries.every(e => e.createdAt < first.entries[1].createdAt));
  const last = await store.browse({ limit: 2, before: next.entries[1].createdAt });
  assert.equal(last.entries.length, 1);
  assert.equal(last.more, false);
  assert.ok(!JSON.stringify([first, next, last]).includes(PICS), 'no path in a page');
});

test('browse: filters by kind ("video" = recordings and replays) and by game folder', async () => {
  const { store, put } = gallery();
  await put('screenshot', 'Game.exe');
  await put('recording', 'Game.exe');
  await put('replay', '');
  assert.deepEqual((await store.browse({ kind: 'video' })).entries.map(e => e.kind), ['replay', 'recording']);
  assert.deepEqual((await store.browse({ kind: 'screenshot' })).entries.map(e => e.kind), ['screenshot']);
  assert.equal((await store.browse({ kind: 'exe' })).entries.length, 3, 'an unknown kind = all');
  assert.deepEqual((await store.browse({ game: 'Game' })).entries.map(e => e.kind), ['recording', 'screenshot']);
  assert.deepEqual((await store.browse({ game: 'Desktop' })).entries.map(e => e.kind), ['replay']);
  assert.deepEqual(store.games(), [{ label: 'Game', count: 2 }, { label: 'Desktop', count: 1 }]);
});

test('browse skips files deleted in the file manager without forgetting them', async () => {
  const onDisk = new Set();
  const { store, put } = gallery({ onDisk });
  const a = await put('screenshot', '');
  const b = await put('screenshot', '');
  onDisk.add(store.get(a.id).file);
  assert.deepEqual((await store.browse()).entries.map(e => e.id), [a.id]);
  onDisk.add(store.get(b.id).file);
  assert.deepEqual((await store.browse()).entries.map(e => e.id), [b.id, a.id], 'back when the file is');
});

test('an edited copy goes beside the original as "<name> Trim", never over another file', async () => {
  const { store, put } = gallery({ onDisk: new Set() });
  const v = await put('recording', 'Game.exe');
  const src = store.get(v.id);
  const p = await store.planBeside(src, 'Trim');
  assert.equal(p.dir, path.dirname(src.file));
  assert.equal(p.name, `${path.basename(src.file, '.mp4')} Trim.mp4`);
  assert.notEqual(p.id, v.id);
  const taken = new Set([p.file]);
  const s2 = createCaptures({
    file: path.join(os.tmpdir(), 'none', 'captures.json'), writeFileAtomic: async () => {},
    picturesDir: async () => PICS, exists: async f => taken.has(f), now: () => T0, randomId: () => 'f'.repeat(16),
  });
  assert.equal((await s2.planBeside(src, 'Trim')).name, `${path.basename(src.file, '.mp4')} Trim (2).mp4`);
});

test('remove: deletes the file and the entry, tells the listener, refuses what it does not know', async () => {
  const { store, put, removed, unlinked } = gallery();
  const a = await put('screenshot', '');
  const file = store.get(a.id).file;
  assert.deepEqual(await store.remove(a.id), { ok: true, name: path.basename(file) });
  assert.deepEqual(unlinked, [file]);
  assert.deepEqual(removed, [a.id]);
  assert.equal(store.get(a.id), null);
  assert.deepEqual(await store.remove(a.id), { ok: false, error: 'not_found' });
  assert.deepEqual(await store.remove('../../x'), { ok: false, error: 'not_found' });
  assert.deepEqual(unlinked, [file], 'nothing else touched');
});

test('remove: a file already gone still drops the entry; a locked one keeps it', async () => {
  const gone = gallery({ unlinkFails: 'ENOENT' });
  const a = await gone.put('screenshot', '');
  assert.equal((await gone.store.remove(a.id)).ok, true);
  assert.equal(gone.store.get(a.id), null);
  const locked = gallery({ unlinkFails: 'EBUSY' });
  const b = await locked.put('screenshot', '');
  assert.deepEqual(await locked.store.remove(b.id), { ok: false, error: 'delete_failed' });
  assert.ok(locked.store.get(b.id), 'kept: the file is still there');
  assert.deepEqual(locked.removed, []);
});

test('prune tells the listener about every capture it deletes', async () => {
  const { store, put, removed } = gallery();
  const a = await put('recording', '');
  const b = await put('recording', '');
  const c = await put('recording', '');
  const r = await store.prune({ kind: ['recording'], maxBytes: 150, keep: c.id });
  assert.equal(r.removed, 2);
  assert.deepEqual(removed.sort(), [a.id, b.id].sort());
});

test('a GIF copy: kind "gif" with ".gif" beside the video, found by "video" but never pruned as one', async () => {
  const { store, put } = gallery({ onDisk: new Set() });
  const v = await put('recording', 'Game.exe');
  const src = store.get(v.id);
  const p = await store.planBeside(src, 'GIF', '.gif');
  assert.equal(p.name, `${path.basename(src.file, '.mp4')} GIF.gif`);
  const g = store.add({ id: p.id, kind: 'gif', file: p.file, game: 'Game.exe', width: 480, height: 270, webcam: 'br' });
  assert.equal(g.kind, 'gif');
  assert.equal(g.webcam, undefined, 'only a recording keeps where its bubble is');
  assert.equal(store.add({ id: 'a'.repeat(16), kind: 'recording', file: path.join(PICS, 'x.mp4'), webcam: 'tl' }).webcam, 'tl');
  assert.equal(store.add({ id: 'b'.repeat(16), kind: 'recording', file: path.join(PICS, 'y.mp4'), webcam: 'middle' }).webcam, undefined);
});

test('browse "video" includes GIFs', async () => {
  const { store, put } = gallery();
  await put('recording', 'Game.exe');
  await put('gif', 'Game.exe');
  await put('screenshot', 'Game.exe');
  assert.deepEqual((await store.browse({ kind: 'video' })).entries.map(e => e.kind), ['gif', 'recording']);
  assert.deepEqual((await store.browse({ kind: 'gif' })).entries.map(e => e.kind), ['gif']);
});
