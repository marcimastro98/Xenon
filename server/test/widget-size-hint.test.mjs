// A widget package names the shape it was drawn for (manifest "size") and a new
// tile of it starts in that shape, measured on the screen it lands on, instead
// of the default span squeezed into whatever hole is free. The assistant's own
// widgets are put on the current page that way right after they are made.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const g = require('../js/dashboard-grid.js');
const SdkWidgets = require('../sdk-widgets.js');
const read = (p) => fs.readFileSync(path.join(HERE, '..', p), 'utf8');

const EDGE = { rows: 8, colPx: 2560 / 24, pageH: 650 };
const MONITOR = { rows: 8, colPx: 1920 / 24, pageH: 980 };
const pxRatio = (span, geo) => (span.w * geo.colPx) / (span.h * geo.pageH / Math.max(geo.rows, 8));

test('every shape keeps its pixel proportions on the Edge and on a monitor', () => {
  for (const geo of [EDGE, MONITOR]) {
    for (const [hint, spec] of Object.entries(g.TILE_SIZE_HINTS)) {
      const span = g.spanForSize(hint, geo);
      assert.ok(span.w >= 4 && span.w <= 24 && span.h >= 4, hint + ' ' + JSON.stringify(span));
      const ratio = pxRatio(span, geo);
      assert.ok(Math.abs(ratio - spec.ratio) / spec.ratio < 0.25, `${hint}: ratio ${ratio.toFixed(2)} for ${spec.ratio}`);
    }
  }
});

test('wide is a short strip, tall a full-height column, large the biggest', () => {
  const wide = g.spanForSize('wide', EDGE);
  const tall = g.spanForSize('tall', EDGE);
  const large = g.spanForSize('large', EDGE);
  assert.ok(wide.w > wide.h);
  assert.equal(tall.h, 8);
  assert.ok(tall.w < large.w);
  assert.ok(large.w * large.h > g.spanForSize('medium', EDGE).w * g.spanForSize('medium', EDGE).h);
  // Narrower columns on a 16:9 monitor: the same strip takes more of them.
  assert.ok(g.spanForSize('wide', MONITOR).w > wide.w);
});

test('a taller page gives the same shape more rows', () => {
  const span = g.spanForSize('medium', { ...EDGE, rows: 24 });
  assert.equal(span.h, 12);
});

test('no hint, an unknown one or no geometry keeps the default span', () => {
  assert.equal(g.spanForSize(undefined, EDGE), null);
  assert.equal(g.spanForSize('huge', EDGE), null);
  assert.equal(g.spanForSize('wide', { rows: 8, colPx: 0, pageH: 650 }), null);
  assert.equal(g.spanForSize('wide', null), null);
});

test('the widths stay inside the grid', () => {
  assert.equal(g.spanForSize('wide', { rows: 8, colPx: 10, pageH: 2000 }).w, 24);
  assert.equal(g.spanForSize('tall', { rows: 8, colPx: 500, pageH: 300 }).w, 4);
});

test('the manifest keeps a known size and drops anything else', () => {
  const m = (extra) => SdkWidgets.normalizeManifest({ api: 1, name: 'W', ...extra }, 'w-test');
  assert.equal(m({ size: 'wide' }).manifest.size, 'wide');
  for (const s of SdkWidgets.TILE_SIZES) assert.equal(m({ size: s }).manifest.size, s);
  assert.equal(m({ size: 'huge' }).manifest.size, null);
  assert.equal(m({ size: { w: 9 } }).manifest.size, null);
  assert.equal(m({}).manifest.size, null);
  assert.equal(m({ size: 'wide', surface: 'ambient' }).manifest.size, null);
});

function withLayout(layout, fn) {
  const DI = require('../js/dashboard-instances.js');
  const prev = { window: globalThis.window, get: globalThis.getDashboardLayout, save: globalThis.saveDashboardLayout };
  globalThis.window = { DashboardInstances: DI, CustomWidget: { clearAssign() {} } };
  globalThis.getDashboardLayout = () => layout;
  globalThis.saveDashboardLayout = () => {};
  try { return fn(); } finally {
    globalThis.window = prev.window;
    globalThis.getDashboardLayout = prev.get;
    globalThis.saveDashboardLayout = prev.save;
  }
}
const pageWith = (tiles) => ({
  pages: [{ id: 'p' }],
  widgets: { custom: { visible: false, page: 'p', x: 0, y: 0, w: 8, h: 6 }, ...tiles },
  copies: [],
  groups: {},
});

test('a sized tile lands with its own span where it fits', () => {
  const layout = pageWith({ media: { visible: true, page: 'p', x: 0, y: 0, w: 8, h: 8 } });
  withLayout(layout, () => g.addWidgetToPage('custom', 'p', { w: 11, h: 4 }));
  const t = layout.widgets.custom;
  assert.deepEqual({ w: t.w, h: t.h }, { w: 11, h: 4 });
  assert.ok(t.x >= 8, 'beside the tile already there');
});

test('a sized tile shrinks as a whole into a smaller hole, keeping its shape', () => {
  const layout = pageWith({ media: { visible: true, page: 'p', x: 0, y: 0, w: 12, h: 8 } });
  withLayout(layout, () => g.addWidgetToPage('custom', 'p', { w: 16, h: 8 }));
  const t = layout.widgets.custom;
  assert.deepEqual({ x: t.x, w: t.w, h: t.h }, { x: 12, w: 12, h: 6 });
});

test('without a size the default span and the old placement stand', () => {
  const layout = pageWith({ media: { visible: true, page: 'p', x: 0, y: 0, w: 12, h: 8 } });
  withLayout(layout, () => g.addWidgetToPage('custom', 'p'));
  const t = layout.widgets.custom;
  assert.deepEqual({ w: t.w, h: t.h }, { w: 8, h: 6 });
});

test('a shape fits a page only in its proportions and without adding rows', () => {
  const empty = pageWith({});
  withLayout(empty, () => assert.equal(g.fitsOnPage('p', { w: 11, h: 4 }), true));
  const half = pageWith({ media: { visible: true, page: 'p', x: 0, y: 0, w: 12, h: 8 } });
  withLayout(half, () => assert.equal(g.fitsOnPage('p', { w: 11, h: 4 }), true));
  // Full: the tile would go below and every tile on the page would shrink.
  const full = pageWith({ media: { visible: true, page: 'p', x: 0, y: 0, w: 24, h: 8 } });
  withLayout(full, () => assert.equal(g.fitsOnPage('p', { w: 11, h: 4 }), false));
  // A narrow column left free: a wide strip would turn into a square there.
  const column = pageWith({ media: { visible: true, page: 'p', x: 0, y: 0, w: 18, h: 8 } });
  withLayout(column, () => assert.equal(g.fitsOnPage('p', { w: 16, h: 4 }), false));
  withLayout(column, () => assert.equal(g.fitsOnPage('p', null), true));
});

test('sizeForHint measures the page, and leaves the phone view alone', () => {
  const prev = { window: globalThis.window, get: globalThis.getDashboardLayout };
  globalThis.getDashboardLayout = () => pageWith({});
  try {
    globalThis.window = { innerWidth: 2560, innerHeight: 650 };
    assert.deepEqual(g.sizeForHint('wide', 'p'), g.spanForSize('wide', EDGE));
    assert.equal(g.sizeForHint('huge', 'p'), null);
    globalThis.window = { innerWidth: 390, innerHeight: 800, PhoneView: { isActive: () => true } };
    assert.equal(g.sizeForHint('wide', 'p'), null);
  } finally {
    globalThis.window = prev.window;
    globalThis.getDashboardLayout = prev.get;
  }
});

test('the assistant puts a widget it made on the current page, in its shape', () => {
  const server = read('server.js');
  const at = server.indexOf("if (fnName === 'create_widget')");
  const body = server.slice(at, server.indexOf("} else if (fnName === 'preset_reference')", at));
  assert.match(body, /clientActions\.push\(\{ action: 'place_created_widget', args: \{ id: r\.id \} \}\)/);
  assert.match(read('js/ai.js'), /case 'place_created_widget':\s*\n\s*if \(window\.CustomWidget && window\.CustomWidget\.placeCreated/);
  const cw = read('js/custom-widget.js');
  assert.match(cw, /DG\.sizeForHint\(pkg\.size, page\)/);
  assert.match(cw, /DG\.addWidgetToPage\('custom', page, size\)/);
  assert.match(cw, /addToPage, addAsTab, bindPackages, placeCreated,/);
});

test('a widget made for a full page gets a page of its own, and is placed once per turn', () => {
  const cw = read('js/custom-widget.js');
  const body = cw.slice(cw.indexOf('async function placeCreated'), cw.indexOf('function addAsTab'));
  assert.match(body, /if \(_placing\.has\(pkgId\)\) return null;/);
  assert.match(body, /!DG\.fitsOnPage\(page, span\)/);
  assert.match(body, /const fresh = pages\.add\(\);/);
  assert.match(body, /pages\.rename\(fresh, pkg\.name\)/);
  assert.match(body, /return addToPage\(pkgId, fresh\);/);
  assert.match(body, /finally \{\s*_placing\.delete\(pkgId\);/);
  assert.match(read('js/dashboard-pages.js'), /goToPage\(id\);\s*return id;\s*\}/);
});

test('the model is told to fill the tile, not just to pick its shape', () => {
  const server = read('server.js');
  const at = server.indexOf("{ name: 'create_widget', description:");
  const desc = server.slice(at, server.indexOf('parameters:', at));
  assert.match(desc, /Fill the tile: html, body and the root at height 100% with container-type: size on the root/);
  assert.match(desc, /no empty band and nothing sunk to one edge/);
});
