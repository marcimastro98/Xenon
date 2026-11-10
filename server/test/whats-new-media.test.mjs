// The moving pictures of What's New are built by tools/whats-new-media. The
// ffmpeg arguments are pure, so what a clip must keep is checked here, and the
// clips shipped in server/assets/whatsnew must exist and stay small.
import assert from 'node:assert/strict';
import { statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CLIP as MAKER_CLIP, STILLS, concatList, encodeArgs, stillArgs } from '../../tools/whats-new-media/maker.mjs';
import { CELLS, CLIP as MOSAIC_CLIP, cellSize, mosaicArgs } from '../../tools/whats-new-media/supporters.mjs';
import { CLIP as WIDGETS_CLIP, arrivals, tileBox, view, widgetsArgs } from '../../tools/whats-new-media/widgets.mjs';
import { SCREENS, assertSideCopy } from '../../tools/whats-new-media/map.mjs';
import { MAX_CLIP_BYTES, OUT_DIR, POSTER_AT, homePosterArgs, posterArgs } from '../../tools/whats-new-media/build.mjs';
import { SHEETS } from '../../tools/store-shots/sheet.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLAN = [['a', { x: 0.1, y: 0.1, w: 0.2, h: 0.3 }], ['b', { x: 0.4, y: 0.5, w: 0.2, h: 0.3 }]];
const VIEWPORT = { width: 1920, height: 1080, scale: 1 };
const after = (args, flag) => args[args.indexOf(flag) + 1];

test('concatList lasts each frame until the next and holds the last one', () => {
  const list = concatList([{ file: 'a.jpg', at: 10 }, { file: 'b.jpg', at: 10.5 }, { file: 'c.jpg', at: 11 }], 2);
  assert.deepEqual(list.trim().split('\n'), [
    'ffconcat version 1.0',
    "file 'a.jpg'", 'duration 0.500',
    "file 'b.jpg'", 'duration 0.500',
    "file 'c.jpg'", 'duration 2.000',
    "file 'c.jpg'",
  ]);
});

test('concatList never gives a frame no time, and has nothing to say with no frames', () => {
  const list = concatList([{ file: 'a.jpg', at: 5 }, { file: 'b.jpg', at: 5 }], 1);
  assert.match(list, /file 'a\.jpg'\nduration 0\.001/);
  assert.equal(concatList([]), 'ffconcat version 1.0\n');
});

test('every clip is H.264 in yuv420p with its index first, so a webview starts it at once', () => {
  const clips = [encodeArgs('l.txt', 'o.mp4'), mosaicArgs('root', 'o.mp4'), widgetsArgs('w.png', 'l.png', 'o.mp4')];
  for (const args of clips) {
    assert.equal(after(args, '-c:v'), 'libx264');
    assert.equal(after(args, '-movflags'), '+faststart');
    assert.ok(args.includes('-an'), 'a clip has no sound');
    assert.ok(args.join(' ').includes('yuv420p'));
    assert.equal(args.at(-1), 'o.mp4');
  }
  assert.match(after(encodeArgs('l.txt', 'o.mp4'), '-vf'), new RegExp(`scale=${MAKER_CLIP.width}:${MAKER_CLIP.height}`));
});

test('the four drops fill the sheet with a gap between them', () => {
  const { w, h } = cellSize();
  assert.equal(w * 2 + MOSAIC_CLIP.gap, MOSAIC_CLIP.width);
  assert.equal(h * 2 + MOSAIC_CLIP.gap, MOSAIC_CLIP.height);
  assert.equal(CELLS.length, 4);
  const filter = after(mosaicArgs('root', 'o.mp4'), '-filter_complex');
  assert.match(filter, /xstack=inputs=4/);
  for (const i of [0, 1, 2, 3]) assert.ok(filter.includes(`[c${i}]`));
});

test('a mosaic cell keeps the shape of the sheet, so nothing is stretched', () => {
  const { w, h } = cellSize();
  for (const cell of CELLS) {
    const off = Math.abs(cell.crop.w / cell.crop.h - w / h) / (w / h);
    assert.ok(off < 0.01, `${cell.name} is out of shape by ${off}`);
  }
});

test('the view keeps the clip shape and stays on the desktop', () => {
  const v = view(PLAN, VIEWPORT);
  assert.equal(v.h, 1080);
  assert.ok(Math.abs(v.w / v.h - WIDGETS_CLIP.width / WIDGETS_CLIP.height) < 0.01);
  assert.ok(v.x >= 0 && v.x + v.w <= v.W);
  const atEdge = view([['a', { x: 0, y: 0, w: 0.1, h: 0.1 }]], VIEWPORT);
  assert.equal(atEdge.x, 0);
});

test('a tile box is on even pixels and never leaves the clip', () => {
  const v = view(PLAN, VIEWPORT);
  for (const rect of [PLAN[0][1], PLAN[1][1], { x: 0.5, y: 0.9, w: 0.5, h: 0.5 }]) {
    const box = tileBox(rect, v);
    for (const n of Object.values(box)) assert.equal(n % 2, 0);
    assert.ok(box.x + box.w <= WIDGETS_CLIP.width);
    assert.ok(box.y + box.h <= WIDGETS_CLIP.height);
  }
});

test('each widget arrives after the one before, and all arrive before the clip ends', () => {
  const times = arrivals(PLAN);
  assert.ok(times[0] < times[1]);
  const filter = after(widgetsArgs('w.png', 'l.png', 'o.mp4', PLAN), '-filter_complex');
  assert.equal(filter.match(/overlay=/g).length, PLAN.length);
  assert.ok(times.at(-1) < WIDGETS_CLIP.seconds);
});

test('the map clip wipes widgets, so it refuses the real server', () => {
  assert.throws(() => assertSideCopy('http://127.0.0.1:3030/'), /side copy/);
  assert.doesNotThrow(() => assertSideCopy('http://127.0.0.1:3050/'));
  assert.equal(SCREENS.filter((m) => m.primary).length, 1);
});

test('a poster is one frame of the clip at the second asked for', () => {
  const args = posterArgs('v.mp4', 'p.webp', 4.4);
  assert.equal(after(args, '-ss'), '4.4');
  assert.equal(after(args, '-frames:v'), '1');
  assert.equal(after(args, '-c:v'), 'libwebp');
});

test('every clip the sheets name ships with its poster, small enough for the update', () => {
  const news = JSON.parse(readFileSync(path.join(ROOT, 'server', 'whatsnew.json'), 'utf8'));
  const named = news.highlights.filter((h) => h.mediaType === 'video').map((h) => path.basename(h.media, '.mp4'));
  assert.deepEqual(named.sort(), Object.keys(POSTER_AT).sort());
  for (const name of named) {
    assert.ok(statSync(path.join(OUT_DIR, `${name}.mp4`)).size <= MAX_CLIP_BYTES, `${name}.mp4 is too big`);
    assert.ok(statSync(path.join(OUT_DIR, `${name}.webp`)).size > 0);
  }
});

test('the Maker stills are kept at the size the pages state', () => {
  const [create, store] = STILLS;
  const page = readFileSync(path.join(ROOT, 'docs', 'create', 'index.html'), 'utf8');
  const tag = page.match(/<img[^>]*maker-still.webp[^>]*>/)?.[0] ?? '';
  assert.match(tag, new RegExp(`width="${create.size.width}" height="${create.size.height}"`));
  assert.equal(store.size.width, SHEETS.maker.box.width);
  assert.equal(store.size.height, SHEETS.maker.box.height);
});

test('a still is shot at least as large as it is kept, in its own shape', () => {
  for (const still of STILLS) {
    const { viewport, scale, size } = still;
    assert.ok(viewport.width * scale >= size.width);
    assert.equal(viewport.width / viewport.height, size.width / size.height);
    const args = stillArgs('s.png', 'o.webp', still);
    assert.match(args[args.indexOf('-vf') + 1], new RegExp(`scale=${size.width}:${size.height}`));
    assert.equal(args.at(-1), 'o.webp');
  }
});

test('the home page poster keeps the shape of the clip, smaller', () => {
  const args = homePosterArgs('v.mp4', 'p.jpg', POSTER_AT.maker);
  assert.equal(args[args.indexOf('-ss') + 1], String(POSTER_AT.maker));
  assert.match(args[args.indexOf('-vf') + 1], /scale=640:-1/);
  assert.ok(args.includes('-frames:v'));
});
