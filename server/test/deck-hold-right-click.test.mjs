// A deck key's Hold trigger, from a touchscreen on macOS.
//
// macOS has no touch input for USB touchscreens: a driver app (Touchscreen
// Gestures, reported on 4.11.9) turns touches into mouse events, and a long
// press into a right click. The key only armed its hold timer on the primary
// button, so on that setup Hold could never fire, and the right click's
// pointerup fell through to Tap instead. A right click now fires Hold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const JS = readFileSync(new URL('../js/deck.js', import.meta.url), 'utf8');

/** bindActionKey, cut out of deck.js and wired to stubs that record what fired. */
function loadBinder() {
  const start = JS.indexOf('  function bindActionKey(');
  assert.ok(start >= 0, 'bindActionKey not found');
  const end = JS.indexOf('\n  }\n', start) + 4;
  const src = JS.slice(start, end);
  const fired = [];
  const make = new Function('fired', `
    const bindPressFeedback = () => {};
    const fireFeedback = () => {};
    const runAction = () => {};
    const lightingAction = () => {};
    const flashError = () => {};
    const runTrigger = (t) => { fired.push(t.name); return Promise.resolve(true); };
    ${src}
    return bindActionKey;
  `);
  return { bindActionKey: make(fired), fired };
}

function fakeNode() {
  const handlers = {};
  return {
    dataset: {},
    classList: { remove() {} },
    addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
    emit(type, e = {}) { (handlers[type] || []).forEach((fn) => fn(e)); },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function keyWith(triggers) {
  const t = {};
  for (const name of triggers) t[name] = { name };
  return { kind: 'action', triggers: t };
}

test('a right click fires the hold trigger, and not tap', async () => {
  const { bindActionKey, fired } = loadBinder();
  const node = fakeNode();
  bindActionKey(node, keyWith(['tap', 'double', 'hold']), {});
  node.emit('pointerdown', { button: 2, pointerType: 'mouse' });
  node.emit('pointerup', { button: 2, pointerType: 'mouse' });
  await wait(300);                                     // past the double-tap window
  assert.deepEqual(fired, ['hold']);
});

test('a long press on the primary button still fires hold', async () => {
  const { bindActionKey, fired } = loadBinder();
  const node = fakeNode();
  bindActionKey(node, keyWith(['tap', 'hold']), {});
  node.emit('pointerdown', { button: 0, pointerType: 'touch' });
  await wait(550);
  node.emit('pointerup', { button: 0, pointerType: 'touch' });
  await settle();
  assert.deepEqual(fired, ['hold']);
});

test('a short primary press is still a tap', async () => {
  const { bindActionKey, fired } = loadBinder();
  const node = fakeNode();
  bindActionKey(node, keyWith(['tap', 'hold']), {});
  node.emit('pointerdown', { button: 0 });
  node.emit('pointerup', { button: 0 });
  await settle();
  assert.deepEqual(fired, ['tap']);
});

test('a key without a hold trigger keeps its old right click behaviour', async () => {
  const { bindActionKey, fired } = loadBinder();
  const node = fakeNode();
  bindActionKey(node, keyWith(['tap']), {});
  node.emit('pointerdown', { button: 2 });
  node.emit('pointerup', { button: 2 });
  await settle();
  assert.deepEqual(fired, ['tap']);
});
