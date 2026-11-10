// js/layer-tiles.js: one row per dashboard tile, saying what the light layer
// page needs to draw it or why only the whole dashboard can. A new tile with no
// row fails here, so it is born light or says why it is not; the recorded
// memory (tools/measure-layer-tiles.mjs --write) keeps "light" a number.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const LayerTiles = require('../js/layer-tiles.js');
const LayerPage = require('../layer-page.js');
const { layersFor, pageFootprint, verdict } = await import('../../tools/measure-layer-tiles.mjs');

const ROOT = new URL('../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, ROOT), 'utf8');
const INDEX = read('index.html');
const MEMORY = JSON.parse(read('test/fixtures/layer-tile-memory.json'));
// The ceilings: a tile over its empty page, and the empty light page itself.
const TILE_BUDGET_MB = 40;
const PAGE_BUDGET_MB = 55;

// The dashboard's tiles: every primary tile index.html carries.
const DASHBOARD_TILES = [...new Set([...INDEX.matchAll(/data-dashboard-widget="([a-z]+)"/g)].map((m) => m[1]))].sort();

test('every dashboard tile has a row, and no row is for a tile that does not exist', () => {
  assert.deepEqual(Object.keys(LayerTiles.TILES).sort(), DASHBOARD_TILES);
  const server = read('server.js');
  const ids = JSON.parse(server.match(/const DASHBOARD_WIDGET_IDS = Object\.freeze\((\[[^\]]+\])\)/)[1].replace(/'/g, '"'));
  assert.deepEqual([...ids].sort(), DASHBOARD_TILES, 'the server knows the same tiles');
});

test('a tile the light page does not carry says why', () => {
  for (const [name, row] of Object.entries(LayerTiles.TILES)) {
    if (!row.full) continue;
    assert.equal(typeof row.full, 'string', name);
    assert.ok(row.full.length > 20, name + ': a real reason');
    assert.deepEqual(Object.keys(row), ['full'], name + ': a full row carries nothing else');
  }
  // The tiles a layer never places (server.js LAYER_TILE_EXCLUDED) are not light.
  const excluded = read('server.js').match(/const LAYER_TILE_EXCLUDED = new Set\(\[([^\]]+)\]\)/)[1].match(/[a-z]+/g);
  for (const name of excluded) assert.ok(LayerTiles.TILES[name].full, name);
});

test("a light tile's files exist and its markup is in index.html", () => {
  for (const name of LayerTiles.LITE) {
    const row = LayerTiles.lite(name);
    for (const file of [...(row.css || []), ...(row.js || [])]) assert.ok(existsSync(new URL(file, ROOT)), name + ': ' + file);
    for (const ref of row.markup || []) assert.notEqual(LayerPage.sliceTile(INDEX, ref), '', name + ': ' + ref);
    assert.ok(row.markup || row.copies, name + ': cut from index.html or built by the page');
  }
});

test("a light tile's object and stream methods are in its own files, and its events are real", () => {
  const events = new Set([...read('js/main.js').matchAll(/(?:on|addEventListener)\('([a-z_]+)'/g)].map((m) => m[1]));
  for (const name of LayerTiles.LITE) {
    const row = LayerTiles.lite(name);
    if (!row.global) { assert.equal(row.streams, undefined, name + ': streams need an object'); continue; }
    const src = row.js.map((f) => read(f)).join('\n');
    assert.match(src, new RegExp('(window\\.' + row.global + '\\s*=|(const|let)\\s+' + row.global + '\\s*=)'), name + ': ' + row.global);
    assert.match(src, /renderWidgets/, name + ': renderWidgets');
    for (const [event, method] of Object.entries(row.streams || {})) {
      assert.ok(events.has(event), name + ': main.js relays ' + event);
      assert.match(src, new RegExp('\\b' + method + '\\b'), name + ': ' + method);
    }
  }
});

test('a light tile that draws every copy finds the copy a layer slot holds', () => {
  for (const name of LayerTiles.LITE) {
    const row = LayerTiles.lite(name);
    for (const file of row.js || []) {
      const src = read(file);
      // The copies a tile draws are picked with filter(n => n.closest(...)): limited
      // to the dashboard's pages, that lookup would never find a layer slot. (A
      // parked-page check reads null on a layer page, which is right.)
      for (const m of src.matchAll(/filter\(\s*\(?(\w+)\)?\s*=>\s*\1\.closest\('([^']*)'\)\s*\)/g)) {
        if (m[2].includes('.pager-page')) assert.match(m[2], /\.layer-slot/, name + ': ' + file);
      }
    }
  }
});

test('every page that decides light or full loads the table first', () => {
  for (const page of readdirSync(new URL('.', ROOT)).filter((f) => f.endsWith('.html'))) {
    const html = read(page);
    const model = html.indexOf('js/layers-model.js');
    if (model < 0) continue;
    const table = html.indexOf('js/layer-tiles.js');
    assert.ok(table >= 0 && table < model, page);
  }
});

test('copies are carried only for tiles the page builds itself', () => {
  // A '#id' (the weather's details) is not the tile: the page still builds that.
  for (const name of LayerTiles.COPIES) {
    assert.deepEqual((LayerTiles.lite(name).markup || []).filter((ref) => !ref.startsWith('#')), [], name);
  }
});

test('the recorded memory covers every light tile and stays under the ceiling', () => {
  assert.deepEqual(Object.keys(MEMORY.tiles).sort(), [...LayerTiles.LITE].sort(),
    'run node tools/measure-layer-tiles.mjs --write server/test/fixtures/layer-tile-memory.json');
  for (const [name, mb] of Object.entries(MEMORY.tiles)) {
    assert.ok(Number.isFinite(mb) && mb <= TILE_BUDGET_MB, name + ': ' + mb + ' MB');
  }
  assert.ok(MEMORY.emptyPageMB <= PAGE_BUDGET_MB, 'empty light page: ' + MEMORY.emptyPageMB + ' MB');
});

test('compose cuts a shared element once', () => {
  const html = '<html lang="en"><head><!-- tile styles --></head><body><!-- tile markup --><!-- tile scripts --></body></html>';
  const page = LayerPage.compose(html, ['agenda', 'calendar', 'tasks'], INDEX);
  assert.equal(page.split('data-dashboard-widget="agenda"').length - 1, 1, 'the Agenda once');
  assert.equal(page.split('src="js/calendar.js"').length - 1, 1, 'its code once');
  assert.match(page, /data-dashboard-widget="calendar"/);
  assert.match(page, /data-dashboard-widget="tasks"/);
});

test('the probe: one tile on its surface, the page renderer, what counts as drawn', () => {
  assert.deepEqual(layersFor('').widgets, []);
  const w = layersFor('news').widgets[0];
  assert.equal(w.widget, 'news');
  assert.equal(w.kind, 'tile');
  assert.match(w.id, /^lw_[a-z0-9]{4,24}$/);
  assert.equal(pageFootprint([{ pid: 1, mb: 90 }, { pid: 2, mb: 40 }, { pid: 3, mb: 60 }], [2, 3]), 60, 'the largest new renderer');
  assert.equal(pageFootprint([{ pid: 1, mb: 90 }], [2]), null);
  const s = (o) => ({ errors: [], slots: 1, text: 10, elements: 10, ...o });
  assert.equal(verdict(s({})), 'ok');
  assert.equal(verdict(s({ errors: ['x'] })), 'errors');
  assert.equal(verdict(s({ slots: 0 })), 'not placed');
  assert.equal(verdict(s({ text: 0, elements: 2 })), 'empty');
  assert.equal(verdict(s({ text: 0, elements: 5 })), 'ok', 'a picture or a control counts');
});

test('on a page without the dashboard layout tasks.js leaves the Agenda tabs where that page put them', () => {
  const src = read('js/tasks.js').replace(/\r\n/g, '\n');
  for (const tab of ['Tasks', 'Notes', 'Calendar', 'Timer']) {
    const body = src.slice(src.indexOf('function sync' + tab + 'WidgetPlacement('));
    const head = body.slice(0, body.indexOf('\n}\n'));
    assert.match(head, /getDashboardLayout\(\) : null;\n(?:\s*\/\/.*\n)*\s*if \(!layout\) return;/, tab);
  }
});

test('a light tile that draws a custom select carries it, or its dropdown is the white native one', () => {
  for (const name of Object.keys(LayerTiles.TILES)) {
    const row = LayerTiles.lite(name);
    if (!row || !row.js) continue;
    const uses = row.js.some((src) => src !== 'js/custom-select.js' && /initCustomSelect\(/.test(read(src)));
    if (!uses) continue;
    assert.ok(row.js.includes('js/custom-select.js'), name + ' js');
    assert.ok((row.css || []).includes('components/CustomSelect/CustomSelect.css'), name + ' css');
  }
});

test('the search tile on a layer page does not arm the overlay it cannot show', () => {
  const init = read('js/spotlight.js').split('function init() {')[1].slice(0, 400);
  assert.match(init, /if \(typeof isLayerPage === 'function' && isLayerPage\(\)\) return;\n    attachGesture\(\);/);
});
