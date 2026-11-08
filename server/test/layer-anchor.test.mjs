// "Attach a widget to an app" (capabilities/layer-anchor.js): the widget turns
// into a window that follows one app. Window titles are only matched against
// what the person said: never returned. Xenon's own windows are never offered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const LayersModel = require('../js/layers-model.js');
const Anchor = require('../capabilities/layer-anchor.js');
const { validateAction } = require('../js/deck-actions.js');
const { createCapabilities, aiFunctions, aiAction } = require('../capabilities/index.js');

const WINDOWS = [
  { app: 'XenonNative', title: 'Xenon', active: false },
  { app: 'msedgewebview2', title: '', active: false },
  { app: 'EXCEL', title: 'Budget 2026.xlsx - Excel', active: true },
  { app: 'Code', title: 'server.js - xenon - Visual Studio Code', active: false },
  { app: 'EXCEL', title: 'Second book', active: false },
  { app: 'krita.exe', title: 'Sketch', active: false },
];

function fakeLayers(initial) {
  const state = { layers: initial, writes: 0 };
  return {
    state,
    get: () => state.layers,
    update: async (edit) => {
      const res = edit(state.layers);
      if (!res || res.error || !res.layers) return res || { error: 'failed' };
      state.layers = LayersModel.normalize(res.layers);
      state.writes++;
      return { ...res, layers: state.layers };
    },
    catalog: async () => ({ tiles: ['weather', 'media'], packages: [] }),
  };
}

const host = (anchors = true) => ({ available: () => true, secondMonitor: () => '', anchors: () => anchors });
const caps = (layers, windows = async () => ({ windows: WINDOWS }), anchors = true) =>
  createCapabilities({ layers, layersHost: host(anchors), windows });

test('the list of apps: one row per app, names only, Xenon and shell windows left out', async () => {
  const res = await caps(fakeLayers()).run({ type: 'layerAnchor', mode: 'apps' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.apps.map(a => a.app), ['EXCEL', 'Code', 'krita.exe']);
  assert.deepEqual(res.apps[0], { app: 'EXCEL', active: true }, 'no title, no icon, no path');
  assert.ok(!JSON.stringify(res).includes('Budget'), 'a window title never leaves the server');
});

const ICON = 'data:image/png;base64,iVBORw0KGgo=';
const WITH_ICONS = [
  { app: 'Spotify', title: 'Song', active: true, icon: ICON },
  { app: 'krita', title: 'Sketch', active: false, icon: null },
  { app: 'bad', title: 'x', active: false, icon: 'javascript:alert(1)' },
];

test('the menu gets the app pictures it asks for, and an AI turn cannot ask', async () => {
  const windows = async () => ({ windows: WITH_ICONS });
  const res = await caps(fakeLayers(), windows).run({ type: 'layerAnchor', mode: 'apps', pictures: 'on' });
  assert.deepEqual(res.apps, [{ app: 'Spotify', active: true, icon: ICON }, { app: 'krita', active: false }, { app: 'bad', active: false }]);
  const plain = await caps(fakeLayers(), windows).run({ type: 'layerAnchor', mode: 'apps' });
  assert.ok(!JSON.stringify(plain).includes('base64'), 'names only unless asked');
  const fn = aiFunctions({}).find(f => f.name === 'attach_widget_to_app');
  assert.ok(!fn.parameters.properties.pictures, 'not among the parameters an AI turn sees');
  assert.equal(aiAction('attach_widget_to_app', { mode: 'apps', pictures: 'on' }).pictures, undefined, 'and a turn that sends it anyway loses it');
});

test('the real validator lets the ask through, whatever the value', () => {
  assert.equal(validateAction({ type: 'layerAnchor', mode: 'apps', pictures: 'on' }).pictures, 'on');
  assert.equal(validateAction({ type: 'layerAnchor', mode: 'apps' }).pictures, undefined);
});

test('the picture of an attached app stays with it, for the menu to show with the app closed', async () => {
  const L = fakeLayers();
  await caps(L, async () => ({ windows: WITH_ICONS })).run({ type: 'layerAnchor', widget: 'weather', app: 'spotify' });
  assert.equal(L.state.layers.widgets[0].anchor.icon, ICON);
  const big = 'data:image/png;base64,' + 'A'.repeat(20000);
  assert.equal(LayersModel.normalizeWidget({ ...L.state.layers.widgets[0], anchor: { app: 'x', icon: big } }).anchor.icon, undefined, 'too big: the name alone');
  assert.equal(LayersModel.normalizeWidget({ ...L.state.layers.widgets[0], anchor: { app: 'x', icon: 'data:text/html;base64,AAAA' } }).anchor.icon, undefined);
});

test('a top corner of an app starts under the strip with its buttons, a bottom corner keeps its margin', async () => {
  const L = fakeLayers();
  await caps(L).run({ type: 'layerAnchor', widget: 'weather', app: 'krita' });
  assert.equal(L.state.layers.widgets[0].anchor.corner, 'tr');
  assert.equal(L.state.layers.widgets[0].anchor.dy, 64, 'close and minimise stay reachable');
  const at = (corner, dy) => LayersModel.normalizeWidget({ ...L.state.layers.widgets[0], anchor: { app: 'x', corner, dy } }).anchor.dy;
  assert.equal(at('tr', 16), 64, 'one saved before this rule moves down too');
  assert.equal(at('tl', 16), 64);
  assert.equal(at('tl', 120), 120, 'lower than the strip already: left there');
  assert.equal(at('br', 16), 16);
  assert.equal(at('bl', 16), 16);
});

test('an attached widget changes corner and size, also with its app closed', async () => {
  const L = fakeLayers();
  await caps(L).run({ type: 'layerAnchor', widget: 'weather', app: 'krita' });
  const id = L.state.layers.widgets[0].id;
  const closed = caps(L, async () => ({ windows: [] }));
  const anchor = () => L.state.layers.widgets[0].anchor;
  assert.equal((await closed.run({ type: 'layerAnchor', widget: id, mode: 'corner', corner: 'bottom-left' })).ok, true);
  assert.deepEqual([anchor().app, anchor().corner, anchor().dy], ['krita.exe', 'bl', 16]);
  assert.equal((await closed.run({ type: 'layerAnchor', widget: id, mode: 'corner', corner: 'top-left' })).ok, true);
  assert.deepEqual([anchor().corner, anchor().dy], ['tl', 64]);
  assert.equal((await closed.run({ type: 'layerAnchor', widget: id, mode: 'size', size: 'small' })).ok, true);
  assert.deepEqual([anchor().corner, anchor().w, anchor().h], ['tl', 240, 180], 'the size leaves the corner alone');
  assert.equal(L.state.layers.widgets[0].surface, 'anchor');
});

test('another app keeps the corner and the size the person chose', async () => {
  const layers = fakeLayers();
  const c = caps(layers);
  await c.run(validateAction({ type: 'layerAnchor', widget: 'weather', app: 'EXCEL', corner: 'bottom-left', size: 'large' }));
  const { id } = layers.state.layers.widgets[0];
  await c.run(validateAction({ type: 'layerAnchor', widget: id, app: 'Code' }));
  const { app, corner, w, h } = layers.state.layers.widgets[0].anchor;
  assert.deepEqual({ app, corner, size: [w, h] }, { app: 'Code', corner: 'bl', size: Anchor.SIZE_PX.large });
});

test('a corner or a size named for the new app wins, and a first attachment starts top right, medium', async () => {
  const layers = fakeLayers();
  const c = caps(layers);
  await c.run(validateAction({ type: 'layerAnchor', widget: 'weather', app: 'EXCEL' }));
  const first = layers.state.layers.widgets[0];
  assert.deepEqual([first.anchor.corner, first.anchor.w, first.anchor.h], ['tr', ...Anchor.SIZE_PX.medium]);
  await c.run(validateAction({ type: 'layerAnchor', widget: first.id, app: 'Code', corner: 'top-left', size: 'small' }));
  const { corner, w, h } = layers.state.layers.widgets[0].anchor;
  assert.deepEqual([corner, w, h], ['tl', ...Anchor.SIZE_PX.small]);
});

test('corner and size are for an attached widget only', async () => {
  const L = fakeLayers(LayersModel.normalize({ widgets: [{ id: 'lw_free0001', kind: 'tile', widget: 'weather', surface: 'desktop' }] }));
  const res = await caps(L).run({ type: 'layerAnchor', widget: 'lw_free0001', mode: 'corner', corner: 'top-left' });
  assert.deepEqual([res.ok, res.error], [false, 'not_attached']);
  assert.equal(L.state.writes, 0);
});

test('an app is found by its name, with or without .exe, by part of it, or by a word of a title', () => {
  const w = WINDOWS.filter(x => !/xenon|webview/i.test(x.app));
  assert.equal(Anchor.matchApp(w, 'excel.exe').app, 'EXCEL');
  assert.equal(Anchor.matchApp(w, 'KRITA').app, 'krita.exe');
  assert.equal(Anchor.matchApp(w, 'vis').app, 'Code', 'a title word, when no app name has it');
  assert.equal(Anchor.matchApp(w, 'cod').app, 'Code');
  assert.equal(Anchor.matchApp(w, '').app, 'EXCEL', 'no name = the app in front');
  assert.equal(Anchor.matchApp(w, 'photoshop'), null);
});

test('attaching a widget not on the screen adds it as a window that follows the app', async () => {
  const L = fakeLayers();
  const res = await caps(L).run({ type: 'layerAnchor', widget: 'weather', app: 'excel', corner: 'bottom-left', size: 'small' });
  assert.equal(res.ok, true);
  assert.equal(res.app, 'EXCEL');
  const w = L.state.layers.widgets[0];
  assert.equal(w.surface, 'anchor');
  assert.deepEqual(w.anchor, { app: 'EXCEL', title: '', corner: 'bl', dx: 16, dy: 16, w: 240, h: 180 }, 'no window title stored');
  assert.equal(L.state.layers.enabled, true);
  assert.equal(L.state.writes, 1, 'one write');
});

test('a widget already on the screen moves to the app, and back to the desktop', async () => {
  const L = fakeLayers();
  const run = caps(L).run;
  await run({ type: 'layerPlace', widget: 'media', surface: 'overlay', position: 'center', size: 'medium' });
  const id = L.state.layers.widgets[0].id;
  const on = await run({ type: 'layerAnchor', widget: id, app: 'krita' });
  assert.equal(on.ok, true);
  assert.equal(L.state.layers.widgets.length, 1, 'moved, not copied');
  assert.equal(L.state.layers.widgets[0].surface, 'anchor');
  assert.equal(L.state.layers.widgets[0].anchor.app, 'krita.exe');
  const off = await run({ type: 'layerAnchor', mode: 'off', widget: id });
  assert.equal(off.ok, true);
  const back = L.state.layers.widgets[0];
  assert.equal(back.surface, 'desktop');
  assert.ok(!back.anchor);
  assert.equal((await run({ type: 'layerAnchor', mode: 'off', widget: id })).error, 'not_attached');
});

test('refusals say why, and offer only app names', async () => {
  const run = caps(fakeLayers()).run;
  const none = await run({ type: 'layerAnchor', widget: 'weather', app: 'photoshop' });
  assert.equal(none.error, 'no_app');
  assert.deepEqual(none.choices, ['EXCEL', 'Code', 'krita.exe']);
  assert.equal((await run({ type: 'layerAnchor', widget: 'nothing-like-this', app: 'excel' })).error, 'unknown_widget');
  const blind = caps(fakeLayers(), async () => { throw new Error('helper missing'); }).run;
  assert.equal((await blind({ type: 'layerAnchor', mode: 'apps' })).error, 'no_windows');
});

test('offered only where the shell follows an app, and edit mode learns it from layerList', async () => {
  assert.equal(caps(fakeLayers(), undefined, false).probes().layerAnchor, false);
  assert.equal((await caps(fakeLayers(), undefined, false).run({ type: 'layerAnchor', mode: 'apps' })).error, 'unavailable');
  assert.equal((await caps(fakeLayers()).run({ type: 'layerList' })).attach, true);
  assert.equal((await caps(fakeLayers(), undefined, false).run({ type: 'layerList' })).attach, false);
  assert.equal(Anchor.available(null), false);
});

test('the shell report keeps a clean screen name and sane sizes, and works without them', () => {
  const { createLayersHost } = require('../layers-host.js');
  const h = createLayersHost({ now: () => 0 });
  const long = 'x'.repeat(80);
  h.accept({ layers: true, monitors: [
    { key: 'a', primary: true, name: '  DELL\u0007 U2720Q\n ', width: 3840, height: 2160 },
    { key: 'b', name: long, width: -1, height: 1080 },
    { key: 'c', name: 7, width: 1.5, height: 99999 },
    { key: 'd' },
  ] });
  const screens = h.monitors();
  assert.deepEqual(screens[0], { key: 'a', primary: true, name: 'DELL U2720Q', width: 3840, height: 2160 });
  assert.deepEqual(screens[1], { key: 'b', primary: false, name: 'x'.repeat(48) }, 'a name is capped, a bad size dropped');
  assert.deepEqual(screens[2], { key: 'c', primary: false });
  assert.deepEqual(screens[3], { key: 'd', primary: false });
});

test('the shell report keeps where each screen stands, left of the main one too, and drops a place that is not one', () => {
  const { createLayersHost } = require('../layers-host.js');
  const h = createLayersHost({ now: () => 0 });
  h.accept({ layers: true, monitors: [
    { key: 'a', primary: true, x: 0, y: 0 },
    { key: 'b', x: -1920, y: 592 },
    { key: 'c', x: 1.5, y: 'top' },
    { key: 'd', x: 9e9, y: 0 },
  ] });
  const screens = h.monitors();
  assert.deepEqual([screens[0].x, screens[0].y], [0, 0]);
  assert.deepEqual([screens[1].x, screens[1].y], [-1920, 592]);
  assert.equal('x' in screens[2] || 'y' in screens[2], false);
  assert.equal('x' in screens[3], false);
});

test('the shell report: `anchor` counts only with layers, and expires with the report', () => {
  const { createLayersHost } = require('../layers-host.js');
  let t = 0;
  const h = createLayersHost({ now: () => t });
  assert.equal(h.anchors(), false, 'no report yet');
  h.accept({ layers: true, anchor: true, monitors: [] });
  assert.equal(h.anchors(), true);
  h.accept({ layers: false, anchor: true });
  assert.equal(h.anchors(), false);
  h.accept({ layers: true, anchor: 'yes' });
  assert.equal(h.anchors(), false);
  h.accept({ layers: true, anchor: true });
  t = 11 * 60 * 1000;
  assert.equal(h.anchors(), false);
});
