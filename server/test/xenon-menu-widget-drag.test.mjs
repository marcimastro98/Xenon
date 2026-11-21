import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { readFileSync } from './browser-source.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Map = require('../js/menu/xenon-menu-map.js');
const { createLayersEdit } = require('../layers/layers-edit.js');
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
  const src = readFileSync(new URL('../js/menu/xenon-menu-widget-view.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /cornerNear|dropRect|clearSpot/);
});

test('the picture has no window drawn in it: the widget is alone on its screen', () => {
  const src = readFileSync(new URL('../js/menu/xenon-menu-widget-view.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../components/XenonMenu/XenonMenuWidgets.css', import.meta.url), 'utf8');
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
  const src = readFileSync(new URL('../js/layer-edit/layer-edit.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /layerGroup[^\n]*join/);
});

const Drag = require('../js/layers/layer-drag.js');

test('an arrow moves a widget 1 px of its real screen, Shift 10, on the map as on the screen', () => {
  const px = { w: 2560, h: 720 };
  const at = { x: 0.5, y: 0.5, w: 0.2, h: 0.3 };
  const one = Drag.nudge(at, { key: 'ArrowRight' }, px);
  assert.ok(Math.abs((one.x - at.x) * 2560 - 1) < 1e-9, 'one pixel to the right');
  assert.equal(one.w, at.w);
  const ten = Drag.nudge(at, { key: 'ArrowUp', shiftKey: true }, px);
  assert.ok(Math.abs((at.y - ten.y) * 720 - 10) < 1e-9, 'ten pixels up');
  assert.equal(Drag.nudge({ ...at, x: 0 }, { key: 'ArrowLeft' }, px).x, 0, 'it stops at the edge of its screen');
});

test('Shift+Alt with an arrow changes the size by 1 px; Ctrl, Cmd and Alt alone are left alone', () => {
  const px = { w: 1920, h: 1080 };
  const at = { x: 0.1, y: 0.1, w: 0.2, h: 0.3 };
  const min = { w: 0.04, h: 0.05 };
  const wider = Drag.nudge(at, { key: 'ArrowRight', shiftKey: true, altKey: true }, px, { min });
  assert.ok(Math.abs((wider.w - at.w) * 1920 - 1) < 1e-9, 'one pixel wider');
  assert.equal(wider.x, at.x);
  const shorter = Drag.nudge(at, { key: 'ArrowUp', shiftKey: true, altKey: true }, px, { min });
  assert.ok(Math.abs((at.h - shorter.h) * 1080 - 1) < 1e-9, 'one pixel shorter');
  for (const mod of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
    assert.equal(Drag.nudge(at, { key: 'ArrowRight', ...mod }, px), null);
  }
  assert.equal(Drag.nudge(at, { key: 'a' }, px), null);
});

test('the screen reads the arrows with the same rule as the map', () => {
  const win = {};
  for (const file of ['../js/layers/layer-drag.js', '../js/layer-edit/nudge.js']) {
    vm.runInNewContext(readFileSync(new URL(file, import.meta.url), 'utf8'), { window: win, globalThis: win });
  }
  for (const e of [{ key: 'ArrowLeft' }, { key: 'ArrowDown', shiftKey: true }, { key: 'ArrowUp', shiftKey: true, altKey: true }, { key: 'ArrowRight', ctrlKey: true }]) {
    assert.equal(JSON.stringify(win.LayerEditNudge.stepOf(e)), JSON.stringify(Drag.keyStep(e)), JSON.stringify(e));
  }
  assert.deepEqual(Drag.keyStep({ key: 'ArrowRight' }), { dx: 1, dy: 0, mode: 'move' });
  assert.deepEqual(Drag.keyStep({ key: 'ArrowLeft', shiftKey: true }), { dx: -10, dy: 0, mode: 'move' });
});
