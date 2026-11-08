import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { makeDom, windowKeys } from './mini-dom.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '..', 'js', 'dialog-focus.js'), 'utf8');

// What a window that stops the page does with the keyboard. The share windows stack, so
// "the window" is always the one on top.

function rig() {
  const { document } = makeDom();
  const window = {};
  const keys = windowKeys(window);
  vm.runInNewContext(SRC, { window, document });
  const trigger = document.createElement('button');
  document.body.append(trigger);
  trigger.focus();
  const seen = { stopped: false };
  const press = (key, shiftKey = false) => {
    let prevented = false;
    keys.slice().forEach((fn) => fn({
      key, shiftKey, preventDefault() { prevented = true; }, stopPropagation() { seen.stopped = true; },
    }));
    return prevented;
  };
  const windowWith = (count) => {
    const root = document.createElement('div');
    const keys = Array.from({ length: count }, () => root.appendChild(document.createElement('button')));
    document.body.append(root);
    return { root, keys };
  };
  return { document, trigger, press, seen, keys, windowWith, hold: window.DialogFocus.hold };
}

test('the focus goes in and comes back', () => {
  const r = rig();
  const { root, keys } = r.windowWith(2);
  const letGo = r.hold(root, { start: keys[1], onEsc() {} });
  assert.equal(r.document.activeElement, keys[1]);
  letGo();
  assert.equal(r.document.activeElement, r.trigger);
});

test('with no key to offer the window itself takes it, and no ring appears', () => {
  const r = rig();
  const { root } = r.windowWith(1);
  let asked = null;
  root.focus = (options) => { asked = options; };
  r.hold(root, { onEsc() {} });
  assert.equal(asked.focusVisible, false);
});

test('a combination being recorded keeps every key: Tab and Esc are keys like the others', () => {
  const r = rig();
  const { root, keys } = r.windowWith(2);
  let recording = true;
  let closes = 0;
  r.hold(root, { start: keys[0], onEsc() { closes += 1; }, leavesKeys: () => recording });
  assert.equal(r.press('Tab'), false);
  assert.equal(r.document.activeElement, keys[0]);
  assert.equal(r.press('Escape'), false);
  assert.equal(closes, 0);
  recording = false;
  r.press('Tab');
  assert.equal(r.document.activeElement, keys[1]);
  r.press('Escape');
  assert.equal(closes, 1);
});

test('a list open in the window goes first: its own Esc sits below this one', () => {
  const r = rig();
  const { root } = r.windowWith(1);
  let closes = 0;
  let lists = 0;
  const open = { _csClose() { lists += 1; } };
  root.querySelector = (sel) => (sel === '.cs-wrap.cs-open' && lists === 0 ? open : null);
  r.hold(root, { onEsc() { closes += 1; } });
  r.press('Escape');
  assert.deepEqual([lists, closes], [1, 0]);
  r.press('Escape');
  assert.deepEqual([lists, closes], [1, 1]);
});

test('a trigger that left the page takes no focus back, and the window keeps none', () => {
  const r = rig();
  const { root, keys } = r.windowWith(1);
  const letGo = r.hold(root, { start: keys[0], onEsc() {} });
  r.trigger.remove();
  letGo();
  assert.equal(r.document.activeElement, r.document.body);
});

test('a window that stays in the page hidden keeps no focus: Enter would press a key nobody sees', () => {
  const r = rig();
  r.document.activeElement = r.document.body;
  const { root, keys } = r.windowWith(1);
  const letGo = r.hold(root, { start: keys[0], onEsc() {} });
  letGo();
  assert.equal(r.document.activeElement, r.document.body);
});

test('Tab goes round inside, both ways', () => {
  const r = rig();
  const { root, keys } = r.windowWith(3);
  r.hold(root, { start: keys[2], onEsc() {} });
  assert.equal(r.press('Tab'), true);
  assert.equal(r.document.activeElement, keys[0]);
  r.press('Tab', true);
  assert.equal(r.document.activeElement, keys[2]);
  r.press('Tab', true);
  assert.equal(r.document.activeElement, keys[1]);
});

test('from the window itself Tab takes the first key, Shift+Tab the last', () => {
  const r = rig();
  const { root, keys } = r.windowWith(2);
  r.hold(root, { onEsc() {} });
  r.press('Tab');
  assert.equal(r.document.activeElement, keys[0]);
  r.document.activeElement = root;
  r.press('Tab', true);
  assert.equal(r.document.activeElement, keys[1]);
});

test('Tab skips what is hidden, disabled or out of the order', () => {
  const r = rig();
  const { root, keys } = r.windowWith(5);
  keys[1].hidden = true;
  keys[2].disabled = true;
  keys[3].tabIndex = -1;
  r.hold(root, { start: keys[0], onEsc() {} });
  r.press('Tab');
  assert.equal(r.document.activeElement, keys[4]);
});

test('a row that is shut hides its keys: focus() does nothing there and Tab would stop for good', () => {
  const r = rig();
  const { root, keys } = r.windowWith(1);
  const add = (parent, tag) => parent.appendChild(r.document.createElement(tag));
  const row = add(root, 'details');
  const head = add(row, 'summary');
  const inside = add(row, 'button');
  const last = add(root, 'button');
  r.hold(root, { start: keys[0], onEsc() {} });
  r.press('Tab');
  assert.equal(r.document.activeElement, head);
  r.press('Tab');
  assert.equal(r.document.activeElement, last);
  r.press('Tab', true);
  assert.equal(r.document.activeElement, head);
  row.open = true;
  r.press('Tab');
  assert.equal(r.document.activeElement, inside);
});

test('with nothing to reach Tab stays where it is, and does not leave', () => {
  const r = rig();
  const { root } = r.windowWith(0);
  r.hold(root, { onEsc() {} });
  assert.equal(r.press('Tab'), true);
  assert.equal(r.document.activeElement, root);
});

test('a layer raised above the window keeps its own keys', () => {
  const r = rig();
  const { root, keys } = r.windowWith(1);
  r.hold(root, { start: keys[0], onEsc() { assert.fail('Esc belongs to the layer'); } });
  const prompt = r.windowWith(1);
  prompt.keys[0].focus();
  assert.equal(r.press('Tab'), false);
  assert.equal(r.document.activeElement, prompt.keys[0]);
  assert.equal(r.press('Escape'), false);
  assert.equal(r.seen.stopped, false);
});

test('Esc goes no further: Settings or the Store under the window stay open', () => {
  const r = rig();
  const { root, keys } = r.windowWith(1);
  r.hold(root, { start: keys[0], onEsc() {} });
  r.press('Escape');
  assert.equal(r.seen.stopped, true);
});

test('Esc closes the window on top and only that one', () => {
  const r = rig();
  const closed = [];
  const under = r.windowWith(1);
  const over = r.windowWith(1);
  const letGoUnder = r.hold(under.root, { start: under.keys[0], onEsc: () => { closed.push('under'); letGoUnder(); } });
  const letGoOver = r.hold(over.root, { start: over.keys[0], onEsc: () => { closed.push('over'); letGoOver(); } });
  assert.equal(r.press('Escape'), true);
  assert.deepEqual(closed, ['over']);
  assert.equal(r.document.activeElement, under.keys[0], 'back to the window underneath');
  r.press('Escape');
  assert.deepEqual(closed, ['over', 'under']);
  assert.equal(r.document.activeElement, r.trigger);
});

test('a window closed from underneath leaves the focus with the one on top', () => {
  const r = rig();
  const under = r.windowWith(1);
  const over = r.windowWith(1);
  const letGoUnder = r.hold(under.root, { start: under.keys[0], onEsc() {} });
  r.hold(over.root, { start: over.keys[0], onEsc() {} });
  letGoUnder();
  assert.equal(r.document.activeElement, over.keys[0]);
  r.press('Tab');
  assert.equal(r.document.activeElement, over.keys[0], 'and Tab stays in it');
});

test('other keys pass through', () => {
  const r = rig();
  const { root, keys } = r.windowWith(1);
  r.hold(root, { start: keys[0], onEsc() { assert.fail('Esc was not pressed'); } });
  assert.equal(r.press('Enter'), false);
});

test('no key listener stays behind, and letting go twice is harmless', () => {
  const r = rig();
  const { root } = r.windowWith(1);
  const letGo = r.hold(root, { onEsc() {} });
  assert.equal(r.keys.length, 1);
  letGo();
  letGo();
  assert.equal(r.keys.length, 0);
  assert.equal(r.document.activeElement, r.trigger);
});
