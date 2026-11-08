import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Map = require('../js/xenon-menu-map.js');
const { createLayersEdit } = require('../layers-edit.js');
const layers = require('../capabilities/layers.js');

const box = { x: 0.5, y: 0.5, w: 0.2, h: 0.3 };
const row = (monitor = '') => ({ at: { lead: 'lw_a', monitor } });

test('the window of an app goes where no widget covers it', () => {
  const widget = { x: 0, y: 0, w: 0.4, h: 0.5 };
  const [spot] = Map.windowSpots(1, [widget]);
  assert.ok(spot.x >= widget.w || spot.y >= widget.h);
  assert.equal(new Set(Map.windowSpots(3, []).map((s) => `${s.x},${s.y}`)).size, 3);
  assert.equal(Map.windowSpots(8, [{ x: 0, y: 0, w: 1, h: 1 }]).length, 8);
});

test('the map: the real screens where they stand, one main over one wide under it and one to the left', () => {
  const { screens, ratio } = Map.layout([
    { key: '', width: 3840, height: 2160, x: 0, y: 0 },
    { key: 'edge', width: 2560, height: 720, x: 573, y: 2160 },
    { key: 'side', width: 1920, height: 1080, x: -1920, y: 592 },
  ]);
  assert.ok(Math.abs(ratio - 5760 / 2880) < 1e-9);
  assert.equal(screens[2].left, 0, 'the one on the left starts the map, negative place and all');
  assert.equal(screens[0].left, (1920 / 5760) * 100);
  assert.equal(screens[1].top, 75);
});

test('the map: a shell that sends no place puts the screens in a row, none at all still draws one', () => {
  const { screens } = Map.layout([{ key: '', width: 1000, height: 500 }, { key: 'b', width: 1000, height: 500 }]);
  assert.deepEqual(screens.map((m) => m.left), [0, 50]);
  assert.equal(Map.layout([]).screens.length, 1);
});

test('a drop writes the exact box: never a corner, the size as it is', () => {
  const run = Map.moveFor(row(), box, '');
  assert.deepEqual(run, { type: 'layerMove', target: 'lw_a', position: 'keep', size: 'keep', rect: '0.5,0.5,0.2,0.3' });
});

test('a drop on another screen says which, back on the main one by name', () => {
  assert.equal(Map.moveFor(row(), box, 'edge').monitor, 'edge');
  assert.equal(Map.moveFor(row('edge'), box, '').screen, 'main');
  assert.equal(Map.moveFor(row('edge'), box, 'edge').monitor, undefined);
});

test('widgets in tabs share one box on the map', () => {
  const a = { at: { lead: 'x', rect: box } };
  const b = { at: { lead: 'x', rect: box } };
  const c = { at: { lead: 'y', rect: box } };
  assert.deepEqual(Map.boxesOf([a, b, c, { at: {} }]), [a, c]);
});

test('nothing jumps after the drop: the corner rule is gone from the menu', () => {
  const src = fs.readFileSync(new URL('../js/xenon-menu-widget-view.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /cornerNear|dropRect|clearSpot/);
});

test('the picture has no window drawn in it: the widget is alone on its screen', () => {
  const src = fs.readFileSync(new URL('../js/xenon-menu-widget-view.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../components/XenonMenu/XenonMenuWidgets.css', import.meta.url), 'utf8');
  assert.doesNotMatch(src + css, /xm-fakewin/);
});

function editDeps(start) {
  let saved = start;
  const edit = createLayersEdit({ setTimer: () => 0, clearTimer: () => {} });
  const d = {
    edit,
    layers: {
      get: () => saved,
      update: async (fn) => { saved = fn(saved).layers; return { layers: saved }; },
    },
  };
  return { d, read: () => saved, write: (next) => { saved = next; } };
}

test('"Put it back" returns everything as it was when editing began, and only then', async () => {
  const widget = { id: 'lw_pg000001', kind: 'tile', widget: 'weather', surface: 'overlay', rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } };
  const { d, read, write } = editDeps({ enabled: true, widgets: [widget] });
  assert.equal((await layers.undoEdit(d)).error, 'nothing_to_undo');
  await layers.edit(d, { mode: 'on' });
  const before = read();
  write({ ...before, enabled: false });
  assert.equal((await layers.undoEdit(d)).ok, true);
  assert.equal(read().enabled, before.enabled);
  assert.equal(d.edit.get(), true, 'editing goes on');
  await layers.edit(d, { mode: 'off' });
  assert.equal((await layers.undoEdit(d)).error, 'nothing_to_undo');
});

test('a drag never makes tabs: they come from their button alone', () => {
  const src = fs.readFileSync(new URL('../js/layer-edit.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /layerGroup[^\n]*join/);
});
