import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../js/menu-gamepad.js');

const pad = (pressedIdx = [], axes = [0, 0]) => ({
  connected: true,
  axes,
  buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressedIdx.includes(i), value: pressedIdx.includes(i) ? 1 : 0 })),
});

test('readPad maps the standard layout, and the stick counts past the dead zone', () => {
  const s = P.readPad(pad([0, 13]));
  assert.equal(s.a, true);
  assert.equal(s.down, true);
  assert.equal(s.b, false);
  assert.equal(P.readPad(pad([], [0.3, -0.2])).left, false);
  assert.equal(P.readPad(pad([], [-0.8, 0])).left, true);
  assert.equal(P.readPad(pad([], [0, -0.9])).up, true);
  assert.deepEqual(P.readPad(null), {});
});

test('two pads read as one', () => {
  const s = P.merge([P.readPad(pad([0])), P.readPad(pad([5]))]);
  assert.equal(s.a, true);
  assert.equal(s.rb, true);
});

test('a press fires once; a held direction fires, waits, then repeats', () => {
  const memo = { prev: {}, next: {} };
  assert.deepEqual(P.step(memo, { a: true }, 0), ['a']);
  assert.deepEqual(P.step(memo, { a: true }, 16), []);
  assert.deepEqual(P.step(memo, { a: false, down: true }, 32), ['down']);
  assert.deepEqual(P.step(memo, { down: true }, 32 + P.REPEAT_FIRST_MS - 1), []);
  assert.deepEqual(P.step(memo, { down: true }, 32 + P.REPEAT_FIRST_MS), ['down']);
  assert.deepEqual(P.step(memo, { down: true }, 32 + P.REPEAT_FIRST_MS + P.REPEAT_EVERY_MS), ['down']);
  assert.deepEqual(P.step(memo, { down: false }, 2000), []);
  assert.deepEqual(P.step(memo, { down: true }, 2001), ['down']);
});

const R = (left, top, width = 100, height = 44) => ({ left, top, width, height });

test('nearest picks the control that way, preferring the one in line', () => {
  const from = R(0, 0);
  const rects = [R(0, 60), R(200, 50), R(0, 120), R(0, -60), R(150, 0)];
  assert.equal(P.nearest(from, rects, 'down'), 0);
  assert.equal(P.nearest(from, rects, 'up'), 3);
  assert.equal(P.nearest(from, rects, 'right'), 4);
  assert.equal(P.nearest(from, rects, 'left'), -1);
});

test('nextSection wraps over the nav buttons', () => {
  const btn = (id, cur) => ({ dataset: { section: id }, getAttribute: (n) => (n === 'aria-current' && cur ? 'true' : null) });
  const list = [btn('now'), btn('widgets', true), btn('mode')];
  const root = { querySelectorAll: () => list };
  assert.equal(P.nextSection(root, 1), 'mode');
  assert.equal(P.nextSection(root, -1), 'now');
  list[1] = btn('widgets');
  list[2] = btn('mode', true);
  assert.equal(P.nextSection(root, 1), 'now');
  assert.equal(P.nextSection({ querySelectorAll: () => [] }, 1), '');
});

test('B stops a key row waiting for keys, and only then closes the menu', () => {
  let waiting = true; let closed = 0;
  const view = { recording: () => waiting, cancelRecording: () => { waiting = false; } };
  P.back(view, () => { closed += 1; });
  assert.equal(waiting, false);
  assert.equal(closed, 0);
  P.back(view, () => { closed += 1; });
  assert.equal(closed, 1);
});

test('attach does nothing where the webview has no Gamepad API', () => {
  const detach = P.attach({ navigator: {} }, { root: {} });
  assert.equal(typeof detach, 'function');
  detach();
});

test('the menu page and the dashboard panel load it', async () => {
  const fs = await import('node:fs/promises');
  const menu = await fs.readFile(new URL('../menu.html', import.meta.url), 'utf8');
  const index = await fs.readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(menu, /js\/menu-gamepad\.js/);
  assert.match(index, /js\/menu-gamepad\.js[\s\S]*js\/xenon-menu-panel\.js/);
});
