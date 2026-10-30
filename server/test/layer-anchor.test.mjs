// "Attach a widget to an app" (capabilities/layer-anchor.js): the widget turns
// into a window that follows one app. Window titles are only matched against
// what the person said: never returned. Xenon's own windows are never offered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const LayersModel = require('../js/layers-model.js');
const Anchor = require('../capabilities/layer-anchor.js');
const { createCapabilities } = require('../capabilities/index.js');

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
