// Widget pages in the edit bar (js/layer-edit-pages.js): the chips, "+", and
// the sheet of the page shown, run against the real capabilities so a tap goes
// all the way to the saved layers and back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { makeDom } from './mini-dom.mjs';

const require = createRequire(import.meta.url);
const LayersModel = require('../js/layers-model.js');
const { createCapabilities } = require('../capabilities/index.js');
const EDIT = readFileSync(new URL('../js/layer-edit.js', import.meta.url), 'utf8');
const PAGES = readFileSync(new URL('../js/layer-edit-pages.js', import.meta.url), 'utf8');

const W = (id, widget) => ({ id, kind: 'tile', widget, surface: 'desktop', rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.3 } });

function boot({ surface = 'desktop', layers = { enabled: true, widgets: [W('lw_pg000001', 'weather')] }, preload = true, host = { available: () => true } } = {}) {
  const { document } = makeDom();
  document.head = document.createElement('head');
  document.documentElement.appendChild(document.head);
  const root = document.createElement('div');
  document.body.appendChild(root);
  const ctx = { window: {}, document, Math, Array, WeakMap, Set, JSON, String, hubSettings: { layers } };
  ctx.window.LayersModel = LayersModel;
  vm.createContext(ctx);
  const runs = [];
  // The server side for real: the capability runner over these layers.
  const store = {
    get: () => ctx.hubSettings.layers,
    update: async (editFn) => {
      const res = editFn(ctx.hubSettings.layers);
      if (!res || res.error || !res.layers) return res || { error: 'failed' };
      ctx.hubSettings.layers = LayersModel.normalize(res.layers);
      return { ...res, layers: ctx.hubSettings.layers };
    },
    catalog: async () => ({ tiles: ['weather'], packages: [] }),
  };
  const caps = createCapabilities({ layers: store, layersHost: host });
  const api = {
    root: () => root, surface, monitor: '', boxes: () => [], place() {},
    run: async (action) => {
      runs.push({ ...action });
      const res = await caps.run(action);
      edit.refresh();   // the settings broadcast redraws the window
      return res;
    },
  };
  vm.runInContext(EDIT, ctx);
  if (preload) vm.runInContext(PAGES, ctx);
  const edit = ctx.window.LayerEdit;
  edit.start(api);
  const loadPages = () => {
    const script = document.head.children.find((n) => n.tag === 'script');
    vm.runInContext(PAGES, ctx);
    (script._handlers.load || []).forEach((fn) => fn());
    return script;
  };
  const chips = () => root.querySelectorAll('.layer-page-chip');
  const names = () => chips().map((c) => c.textContent);
  const sheetRows = () => (root.querySelector('.layer-page-sheet') || { querySelectorAll: () => [] }).querySelectorAll('.layer-edit-pick');
  const hint = () => root.querySelector('.layer-edit-hint').textContent;
  const settle = () => new Promise((r) => setImmediate(r));
  return { ctx, root, runs, edit, chips, names, sheetRows, hint, settle, loadPages, document };
}

const strip = (b) => b.root.querySelector('.layer-page-strip');

test('without pages the bar offers one "New page" button, between the hint and Add', () => {
  const b = boot();
  const bar = b.root.querySelector('.layer-edit-bar');
  assert.deepEqual(bar.children.map((n) => n.className), ['layer-edit-hint', 'layer-page-strip', 'layer-edit-add', 'layer-edit-done']);
  assert.equal(b.chips().length, 0);
  assert.equal(strip(b).querySelector('.layer-page-new').textContent, 'New page');
});

test('the page script loads only when edit mode starts, once, and the strip appears after', () => {
  const b = boot({ preload: false });
  assert.equal(strip(b), null);
  assert.equal(b.document.head.children.length, 1);
  b.edit.refresh();
  assert.equal(b.document.head.children.length, 1, 'not twice');
  assert.equal(b.loadPages().src, 'js/layer-edit-pages.js');
  assert.ok(strip(b));
});

test('"New page" makes the first two pages and shows the new, empty one; "+" adds more', async () => {
  const b = boot();
  strip(b).querySelector('.layer-page-new').click();
  await b.settle();
  assert.deepEqual(b.runs.at(-1), { type: 'layerPageEdit', mode: 'create' });
  assert.deepEqual(b.names(), ['Page 1', 'Page 2']);
  assert.deepEqual(b.chips().map((c) => c.getAttribute('aria-pressed')), ['false', 'true']);
  const plus = strip(b).querySelector('.layer-page-new');
  assert.equal(plus.textContent, '+');
  assert.equal(plus.getAttribute('aria-label'), 'New page');
  plus.click();
  await b.settle();
  assert.deepEqual(b.names(), ['Page 1', 'Page 2', 'Page 3']);
});

test('a tap on another chip shows that page; a tap on the shown one opens its sheet', async () => {
  const b = boot();
  strip(b).querySelector('.layer-page-new').click();
  await b.settle();
  b.chips()[0].click();
  await b.settle();
  assert.deepEqual(b.runs.at(-1), { type: 'layerPage', page: b.ctx.hubSettings.layers.pages[0].id });
  assert.equal(b.chips()[0].getAttribute('aria-pressed'), 'true');
  b.chips()[0].click();
  assert.deepEqual(b.sheetRows().map((r) => r.textContent), ['When I play', 'Rename', 'Delete page']);
  assert.equal(b.chips()[0].getAttribute('aria-expanded'), 'true');
  b.chips()[0].click();
  assert.equal(b.root.querySelector('.layer-page-sheet'), null, 'a second tap closes it');
});

test('"When I play" marks the page with a gamepad and the toggle reads checked', async () => {
  const b = boot();
  strip(b).querySelector('.layer-page-new').click();
  await b.settle();
  b.chips()[1].click();
  b.sheetRows()[0].click();
  await b.settle();
  assert.equal(b.ctx.hubSettings.layers.pages[1].gaming, true);
  assert.ok(b.chips()[1].querySelector('.layer-page-pad'));
  assert.equal(b.chips()[0].querySelector('.layer-page-pad'), null);
  assert.equal(b.sheetRows()[0].getAttribute('aria-checked'), 'true', 'the open sheet follows the save');
  b.sheetRows()[0].click();
  await b.settle();
  assert.equal(b.ctx.hubSettings.layers.pages[1].gaming, undefined);
});

test('rename picks from a list (no keyboard in a layer window), skipping names in use', async () => {
  const b = boot();
  strip(b).querySelector('.layer-page-new').click();
  await b.settle();
  b.chips()[1].click();
  b.sheetRows()[1].click();
  const offered = b.sheetRows().map((r) => r.textContent);
  assert.deepEqual(offered, ['Work', 'Games', 'Study', 'Relax', 'Home', 'Music', 'Evening']);
  b.sheetRows()[1].click();
  await b.settle();
  assert.deepEqual(b.names(), ['Page 1', 'Games']);
  b.chips()[0].click(); await b.settle();
  b.chips()[0].click();
  b.sheetRows()[1].click();
  assert.ok(!b.sheetRows().map((r) => r.textContent).includes('Games'));
});

test('deleting a page with widgets asks a second tap that says how many go with it', async () => {
  const b = boot();
  strip(b).querySelector('.layer-page-new').click();
  await b.settle();
  b.chips()[0].click(); await b.settle();
  b.chips()[0].click();
  const del = () => b.sheetRows()[2];
  del().click();
  assert.equal(del().textContent, 'Delete it and its {n} widgets'.replace('{n}', '1'));
  assert.equal(b.runs.filter((r) => r.mode === 'delete').length, 0);
  del().click();
  await b.settle();
  assert.deepEqual(b.runs.at(-1).mode, 'delete');
  assert.deepEqual(b.ctx.hubSettings.layers.pages, [], 'one page left is no pages');
  assert.deepEqual(b.ctx.hubSettings.layers.widgets, []);
  assert.equal(strip(b).querySelector('.layer-page-new').textContent, 'New page');
});

test('an empty page goes at the first tap', async () => {
  const b = boot();
  strip(b).querySelector('.layer-page-new').click();
  await b.settle();
  b.chips()[1].click();
  b.sheetRows()[2].click();
  await b.settle();
  assert.deepEqual(b.ctx.hubSettings.layers.pages, []);
  assert.equal(b.ctx.hubSettings.layers.widgets.length, 1, 'the widgets of the other page stay');
});

test('opening Add closes the page sheet and the other way round; a full set of pages is said, not tried', async () => {
  const b = boot();
  strip(b).querySelector('.layer-page-new').click();
  await b.settle();
  b.chips()[1].click();
  assert.ok(b.root.querySelector('.layer-page-sheet'));
  b.root.querySelector('.layer-edit-add').click();
  await b.settle();
  assert.equal(b.root.querySelector('.layer-page-sheet'), null);
  assert.ok(b.root.querySelector('.layer-edit-sheet'));
  b.chips()[1].click();
  assert.equal(b.root.querySelectorAll('.layer-edit-sheet').length, 1);
  for (let i = 0; i < 10; i++) { strip(b).querySelector('.layer-page-new').click(); await b.settle(); }
  assert.equal(b.chips().length, LayersModel.MAX_PAGES);
  assert.equal(b.runs.filter((r) => r.mode === 'create').length, LayersModel.MAX_PAGES - 1);
  assert.equal(b.hint(), 'There are 8 pages already');
});

test('an anchored window has no pages, and stopping edit mode takes the strip away', () => {
  assert.equal(strip(boot({ surface: 'anchor' })), null);
  const b = boot();
  b.edit.stop();
  assert.equal(strip(b), null);
  assert.equal(b.root.querySelector('.layer-page-sheet'), null);
});

test('a page name is shown as text, never as markup', async () => {
  const layers = { enabled: true, pages: [{ id: 'lp_aaaa0001', name: '<img src=x onerror=alert(1)>' }, { id: 'lp_aaaa0002', name: '' }], page: 'lp_aaaa0001', widgets: [] };
  const b = boot({ layers });
  assert.equal(b.names()[0], '<img src=x onerror=alert(1)>');
  assert.equal(b.chips()[0].querySelector('img'), null);
  assert.doesNotMatch(PAGES, /innerHTML/);
});

// A shell that says which virtual desktop is shown (layers/desks.rs).
const deskHost = (shown) => ({ available: () => true, desks: () => true, shownDesk: () => shown });

async function sheetOfSecondPage(b) {
  await b.settle();   // start's layerList says whether desktops are known
  strip(b).querySelector('.layer-page-new').click();
  await b.settle();
  b.chips()[1].click();
}

test('"Show on a desktop" ties the page to a desktop, says it on the chip and unties with "Every desktop"', async () => {
  const b = boot({ host: deskHost({ current: 1, count: 2 }) });
  await sheetOfSecondPage(b);
  assert.deepEqual(b.sheetRows().map((r) => r.textContent), ['When I play', 'Show on a desktop', 'Rename', 'Delete page']);
  b.sheetRows()[1].click();
  const sheet = b.root.querySelector('.layer-page-sheet');
  assert.match(sheet.querySelector('.layer-edit-sheet-note').textContent, /virtual desktop/);
  assert.deepEqual(b.sheetRows().map((r) => r.textContent), ['Every desktop', 'Desktop 1', 'Desktop 2', 'Desktop 3'], 'the two desktops and one about to be made');
  assert.deepEqual(b.sheetRows().map((r) => r.getAttribute('aria-checked')), ['true', 'false', 'false', 'false']);
  b.sheetRows()[2].click();
  await b.settle();
  assert.deepEqual(b.runs.at(-1), { type: 'layerPageEdit', mode: 'desktop', page: b.ctx.hubSettings.layers.pages[1].id, desktop: '2' });
  assert.equal(b.ctx.hubSettings.layers.pages[1].desktop, 2);
  assert.equal(b.root.querySelector('.layer-page-sheet'), null, 'a pick closes the sheet');
  assert.equal(b.chips()[1].title, 'On desktop 2');
  b.chips()[1].click();
  assert.equal(b.sheetRows()[1].textContent, 'On desktop 2');
  b.sheetRows()[1].click();
  assert.equal(b.sheetRows()[2].getAttribute('aria-checked'), 'true');
  const before = b.runs.length;
  b.sheetRows()[2].click();
  await b.settle();
  assert.equal(b.runs.length, before, 'picking the desktop it has changes nothing');
  b.chips()[1].click();
  b.sheetRows()[1].click();
  b.sheetRows()[0].click();
  await b.settle();
  assert.equal(b.ctx.hubSettings.layers.pages[1].desktop, undefined);
  assert.equal(b.chips()[1].title, '');
});

test('desktops not counted yet offer four, and a page tied further up keeps its own', async () => {
  const b = boot({ host: deskHost(null) });
  await sheetOfSecondPage(b);
  b.sheetRows()[1].click();
  assert.equal(b.sheetRows().length, 5, 'Every desktop and 1 to 4');
  b.sheetRows()[0].click();   // nothing changes: it is untied already
  b.ctx.hubSettings.layers = LayersModel.normalize({ ...b.ctx.hubSettings.layers, pages: b.ctx.hubSettings.layers.pages.map((p, i) => (i === 1 ? { ...p, desktop: 7 } : p)) });
  b.edit.refresh();
  b.chips()[1].click();
  b.sheetRows()[1].click();
  assert.equal(b.sheetRows().length, 8);
  assert.equal(b.sheetRows()[7].getAttribute('aria-checked'), 'true');
});

test('where the shell cannot say the desktop, the sheet has no desktop row', async () => {
  const b = boot({ host: { available: () => true, desks: () => false } });
  await sheetOfSecondPage(b);
  assert.deepEqual(b.sheetRows().map((r) => r.textContent), ['When I play', 'Rename', 'Delete page']);
});
