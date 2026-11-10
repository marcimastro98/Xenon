// The Microsoft Store pictures' tool: the checks that keep other companies' names and
// wrong sizes off the Store page, and the invented data behind the pictures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SHOTS, SIZE, findBrands, pngSize, relabel, relabelScript } from '../../tools/store-shots/plan.mjs';
import { GALLERY_ART, galleryAnswer, menuState } from '../../tools/store-shots/fixtures.mjs';
import { SHEETS, sheetHtml } from '../../tools/store-shots/sheet.mjs';
import { pickShots } from '../../tools/store-shots/shoot.mjs';

test('the brand check catches other companies, in any case, once each', () => {
  assert.deepEqual(findBrands('NVIDIA GeForce and nvidia'), ['NVIDIA', 'GeForce', 'nvidia']);
  assert.deepEqual(findBrands('test the build on macOS'), ['macOS']);
  assert.deepEqual(findBrands('Lantern Trail at 239 FPS'), []);
});

test('the brand check catches a company in a ticker', () => {
  assert.deepEqual(findBrands('Corsair CRSR, Apple AAPL'), ['Corsair', 'Apple']);
});

test('every demo name the relabelling touches comes out clean', () => {
  const text = 'AMD Ryzen 9 9950X, NVIDIA GeForce RTX 5080, Cyberpunk2077.exe, Spotify, Discord, YouTube, Twitch, Steam, test on macOS';
  assert.deepEqual(findBrands(relabel(text)), []);
});

test('the page code also rewrites what fields hold', () => {
  const code = relabelScript();
  assert.match(code, /input,textarea/);
  assert.match(code, /window\.__relabel = fix/);
  assert.doesNotThrow(() => new Function(code));
});

test('a PNG header gives its size, anything else is refused', () => {
  const png = Buffer.alloc(24);
  png.write('\x89PNG', 0, 'latin1');
  png.writeUInt32BE(1920, 16);
  png.writeUInt32BE(1080, 20);
  assert.deepEqual(pngSize(png), { width: 1920, height: 1080 });
  assert.throws(() => pngSize(Buffer.from('not a picture, not at all a picture')), /not a PNG/);
});

test('the plan fits the Store: 1920x1080, at most 10 pictures, short plain captions', () => {
  assert.deepEqual(SIZE, { width: 1920, height: 1080 });
  assert.ok(SHOTS.length <= 10);
  assert.equal(new Set(SHOTS.map((s) => s.id)).size, SHOTS.length);
  for (const { caption } of SHOTS) {
    assert.ok(caption.length <= 200);
    assert.deepEqual(findBrands(caption), []);
    assert.doesNotMatch(caption, /—/);
  }
});

test('pickShots takes known ids, skips the out folder, refuses the rest', () => {
  assert.deepEqual(pickShots(['menu', '--out', 'dashboard']), ['menu']);
  assert.deepEqual(pickShots([]), SHOTS.map((s) => s.id));
  assert.throws(() => pickShots(['nope']), /unknown picture/);
});

test('the gallery fills a row of five on each day, at any hour', () => {
  for (const hour of [0, 6, 13, 23]) {
    const now = new Date(2026, 10, 5, hour, 30).getTime();
    const days = new Map();
    for (const e of galleryAnswer(now).entries) {
      const day = new Date(e.createdAt).toDateString();
      days.set(day, (days.get(day) || 0) + 1);
    }
    assert.deepEqual([...days.values()], [5, 5, 5, 5]);
  }
});

test('the invented data names nobody and every thumbnail is a picture', () => {
  const { entries } = galleryAnswer(0);
  assert.deepEqual(findBrands(JSON.stringify(entries)), []);
  assert.equal(GALLERY_ART.length, entries.length);
  const pictures = GALLERY_ART.map((art) => art());
  for (const picture of pictures) assert.match(picture, /^<svg/);
  assert.equal(new Set(pictures).size, pictures.length, 'no two captures show the same frame');
  assert.ok(menuState(0).layers.widgets.length > 0);
});

test('a sheet says the name and one line, with no dash and no list of three', () => {
  for (const [id, sheet] of Object.entries(SHEETS)) {
    assert.doesNotMatch(sheet.line, /—/);
    assert.doesNotMatch(sheet.line, /,[^,]+,[^,]+\band\b/);
    assert.deepEqual(findBrands(sheet.line), []);
    const html = sheetHtml(id);
    assert.match(html, new RegExp(`<h1>${sheet.title}</h1>`));
    assert.ok(sheet.box.left + sheet.box.width <= SIZE.width);
    assert.ok(sheet.box.top + sheet.box.height <= SIZE.height);
  }
});
