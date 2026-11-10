// layer-pin.js: one drag of a pinned screenshot is one save, and a finished
// drag leaves no listener behind (a later pointercancel must not save again).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../js/layer-pin.js', import.meta.url), 'utf8');

class FakeEl extends EventTarget {
  constructor(tag) {
    super();
    this.tag = tag;
    this.dataset = {};
    this.children = [];
    const classes = new Set();
    this.classList = { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) };
    const props = new Map();
    this.style = { getPropertyValue: k => props.get(k) || '', setProperty: (k, v) => props.set(k, v) };
  }
  setAttribute() {}
  appendChild(c) { this.children.push(c); return c; }
  append(...c) { this.children.push(...c); }
  insertBefore(c) { this.children.push(c); }
  querySelector() { return null; }
  setPointerCapture() {}
}

function load() {
  const saves = [];
  const timers = [];
  const document = { createElement: t => new FakeEl(t), createElementNS: (_, t) => new FakeEl(t) };
  const window = {};
  const ctx = vm.createContext({
    window, document, AbortController,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: (id) => { if (id) timers[id - 1] = null; },
    fetch: async (_, o) => { saves.push(JSON.parse(o.body)); return { json: async () => ({ ok: true }) }; },
  });
  vm.runInContext(SRC, ctx);
  const flush = () => { const fns = timers.splice(0); for (const fn of fns) if (fn) fn(); };
  return { LayerPin: window.LayerPin, saves, flush };
}

function pinned(LayerPin) {
  const pin = LayerPin.atom({ id: 'w1', instance: 'abc' });
  const slot = new FakeEl('div');
  for (const [k, v] of [['--layer-x', '10%'], ['--layer-y', '10%'], ['--layer-w', '20%'], ['--layer-h', '20%']]) slot.style.setProperty(k, v);
  slot.parentElement = { getBoundingClientRect: () => ({ width: 1000, height: 500 }) };
  pin.closest = () => slot;
  return { pin, slot };
}

const pointer = (type, x = 0, y = 0) => Object.assign(new Event(type, { cancelable: true }), { button: 0, clientX: x, clientY: y, pointerId: 1 });

test('a drag moves the box and saves once', () => {
  const { LayerPin, saves, flush } = load();
  const { pin, slot } = pinned(LayerPin);
  pin.dispatchEvent(pointer('pointerdown', 100, 100));
  pin.dispatchEvent(pointer('pointermove', 200, 150));
  pin.dispatchEvent(pointer('pointerup', 200, 150));
  flush();
  assert.equal(saves.length, 1);
  assert.equal(saves[0].type, 'layerMove');
  assert.equal(saves[0].target, 'w1');
  assert.equal(slot.style.getPropertyValue('--layer-x'), '20%');
  assert.equal(pin.classList.contains('is-moving'), false);
});

test('a finished drag leaves nothing behind: a later cancel or move does not save or move', () => {
  const { LayerPin, saves, flush } = load();
  const { pin, slot } = pinned(LayerPin);
  pin.dispatchEvent(pointer('pointerdown', 100, 100));
  pin.dispatchEvent(pointer('pointerup', 100, 100));
  flush();
  assert.equal(saves.length, 1);
  pin.dispatchEvent(pointer('pointercancel'));
  pin.dispatchEvent(pointer('pointermove', 900, 400));
  flush();
  assert.equal(saves.length, 1, 'no second save from the old drag');
  assert.equal(slot.style.getPropertyValue('--layer-x'), '10%');
});

test('a cancelled drag ends the same way, and the next drag works', () => {
  const { LayerPin, saves, flush } = load();
  const { pin } = pinned(LayerPin);
  pin.dispatchEvent(pointer('pointerdown', 100, 100));
  pin.dispatchEvent(pointer('pointercancel'));
  pin.dispatchEvent(pointer('pointerup'));
  flush();
  assert.equal(saves.length, 1);
  pin.dispatchEvent(pointer('pointerdown', 100, 100));
  pin.dispatchEvent(pointer('pointerup', 100, 100));
  flush();
  assert.equal(saves.length, 2);
});
