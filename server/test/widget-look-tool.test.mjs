// tools/widget-look: the shooter reads its flags and names its files predictably,
// the sheet escapes captions and keeps the picture types it knows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseArgs as shootArgs, shotName } from '../../tools/widget-look/shoot.mjs';
import { parseArgs as sheetArgs, mimeOf, sheetHtml } from '../../tools/widget-look/sheet.mjs';
import { WIDGET_CELLS } from '../../tools/site-shots/widgets.mjs';

test('a tile with a known size needs only its id', () => {
  const o = shootArgs(['discord']);
  assert.equal(o.tile, 'discord');
  assert.deepEqual(o.cells, WIDGET_CELLS.discord);
  assert.deepEqual(o.viewport, { width: 1920, height: 1080 });
  assert.equal(o.light, false);
  assert.equal(o.scale, 1);
});

test('flags change size, look, language and output', () => {
  const o = shootArgs(['--cells', '8x6', 'twitchwatch', '--light', '--lang', 'it', '--viewport', '2560x720', '--out', 'x', '--name', 'after', '--scale', '2']);
  assert.equal(o.tile, 'twitchwatch');
  assert.deepEqual(o.cells, [8, 6]);
  assert.deepEqual(o.viewport, { width: 2560, height: 720 });
  assert.equal(o.light, true);
  assert.equal(o.lang, 'it');
  assert.equal(o.out, path.resolve('x'));
  assert.equal(o.name, 'after');
  assert.equal(o.scale, 2);
});

test('a missing tile, an unknown size or a bad WxH is refused', () => {
  assert.throws(() => shootArgs([]), /usage/);
  assert.throws(() => shootArgs(['youtubelive']), /--cells/);
  assert.throws(() => shootArgs(['obs', '--cells', '11by5']), /WxH/);
  assert.throws(() => shootArgs(['../obs']), /usage/);
});

test('file names say tile, size or label, and light', () => {
  assert.equal(shotName({ tile: 'obs', cells: [11, 5], light: false, name: '' }), 'obs-11x5.png');
  assert.equal(shotName({ tile: 'obs', cells: [11, 5], light: true, name: 'after' }), 'obs-after-light.png');
});

test('--each takes a selector and names each shot by its place and words', () => {
  const o = shootArgs(['discord', '--each', '.dc-tab', '--name', 'tabs']);
  assert.equal(o.tile, 'discord');
  assert.equal(o.each, '.dc-tab');
  assert.equal(shootArgs(['discord']).each, '');
  assert.equal(shotName(o, { index: 0, words: 'Controls' }), 'discord-tabs-1-controls.png');
  assert.equal(shotName({ ...o, light: true }, { index: 3, words: '  Notifications 2 ' }), 'discord-tabs-4-notifications-2-light.png');
  // No words, or words with nothing a file name can hold: the place alone.
  assert.equal(shotName(o, { index: 1, words: '' }), 'discord-tabs-2.png');
  assert.equal(shotName(o, { index: 2, words: 'お気に入り' }), 'discord-tabs-3.png');
  assert.equal(shotName(o, { index: 4, words: 'A very long tab label that goes on' }), 'discord-tabs-5-a-very-long-tab-label-th.png');
  assert.equal(shotName(o, { index: 5, words: 'Twenty three letters ab c' }), 'discord-tabs-6-twenty-three-letters-ab.png');
});

test('--bare leaves the invented data out, to see a tile as a fresh install does', () => {
  assert.equal(shootArgs(['obs', '--bare']).bare, true);
  assert.equal(shootArgs(['obs']).bare, false);
  // A flag, not a value: the word after it is still the tile.
  assert.equal(shootArgs(['--bare', 'obs']).tile, 'obs');
});

test('--page shoots the whole screen, for a sheet that opens outside the tile', () => {
  assert.equal(shootArgs(['transfer', '--cells', '8x5', '--page']).page, true);
  assert.equal(shootArgs(['obs']).page, false);
  assert.equal(shootArgs(['--page', 'obs']).tile, 'obs');
});

test('sheet cells split on the first bar, out comes first', () => {
  const o = sheetArgs(['out.png', '--cols', '3', 'Before|a.webp', 'After|b|c.png', 'plain.png']);
  assert.equal(o.out, path.resolve('out.png'));
  assert.equal(o.cols, 3);
  assert.equal(o.width, 1600);
  assert.deepEqual(o.cells, [
    { caption: 'Before', file: 'a.webp' },
    { caption: 'After', file: 'b|c.png' },
    { caption: '', file: 'plain.png' },
  ]);
  assert.equal(sheetArgs(['o.png', 'a.png']).cols, 1);
  assert.equal(o.round, 0);
  assert.equal(sheetArgs(['o.png', '--round', '16', 'a.png']).round, 16);
  assert.throws(() => sheetArgs(['o.png']), /usage/);
  assert.throws(() => sheetArgs(['o.png', '--cols', '0', 'a.png']), /usage/);
  assert.throws(() => sheetArgs(['o.png', '--round', '-2', 'a.png']), /usage/);
});

test('rounded corners only when asked', () => {
  const cell = [{ caption: '', src: 'data:image/png;base64,AA' }];
  assert.doesNotMatch(sheetHtml(cell, { cols: 1, width: 900 }), /border-radius/);
  assert.match(sheetHtml(cell, { cols: 1, width: 900, round: 16 }), /img\{[^}]*border-radius:16px\}/);
});

test('only picture types the browser shows', () => {
  assert.equal(mimeOf('a.PNG'), 'image/png');
  assert.equal(mimeOf('a.webp'), 'image/webp');
  assert.equal(mimeOf('a.jpeg'), 'image/jpeg');
  assert.throws(() => mimeOf('a.svg'), /PNG/);
});

test('captions are escaped and the grid has the asked columns', () => {
  const html = sheetHtml([{ caption: '<b>"x"</b> & y', src: 'data:image/png;base64,AA' }, { caption: '', src: 'data:image/png;base64,BB' }], { cols: 2, width: 900 });
  assert.match(html, /&#60;b&#62;&#34;x&#34;&#60;\/b&#62; &#38; y/);
  assert.doesNotMatch(html, /<b>/);
  assert.match(html, /repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(html, /width:900px/);
  assert.equal((html.match(/<figcaption>/g) || []).length, 1);
  assert.equal((html.match(/<img /g) || []).length, 2);
});
