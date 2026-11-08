// One visit to the colour picker (js/color-picker.js). It used to close after every drag, so a
// hue and then a shade took two trips; these pin what closes it and what does not. The module
// builds itself with innerHTML, which mini-dom does not parse, so this rig has its own small DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../js/color-picker.js', import.meta.url), 'utf8');

function events(target) {
  const on = {};
  target.addEventListener = (type, fn) => { (on[type] ||= []).push(fn); };
  target.removeEventListener = (type, fn) => { on[type] = (on[type] || []).filter((x) => x !== fn); };
  target.fire = (type, ev = {}) => (on[type] || []).slice().forEach((fn) => fn({ preventDefault() {}, pointerId: 1, ...ev }));
  target.listening = (type) => (on[type] || []).length;
  return target;
}

function makeNode(document, tag, className = '') {
  const node = events({
    tag, className, children: [], parent: null, style: {}, title: '', value: '', type: '', tabIndex: 0,
    offsetWidth: 264, offsetHeight: 360, isConnected: true,
    classList: { add() {}, remove() {} },
    appendChild(child) { child.parent = node; node.children.push(child); return child; },
    remove() {
      if (node.parent) node.parent.children = node.parent.children.filter((c) => c !== node);
      node.parent = null;
    },
    contains: (x) => x === node || node.children.some((c) => c.contains(x)),
    querySelector: (sel) => node.all().find((n) => n.className.split(' ').includes(sel.slice(1))) || null,
    all: () => node.children.flatMap((c) => [c, ...c.all()]),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100, bottom: 100 }),
    setPointerCapture() {},
    // A field reports a typed value when it loses the focus, as a browser does.
    blur() {
      if (document.activeElement === node) document.activeElement = null;
      node.fire('change');
    },
  });
  // The markup is flat here: the module only looks parts up by class.
  Object.defineProperty(node, 'innerHTML', {
    set(html) { for (const [, cls] of html.matchAll(/class="([^"]+)"/g)) node.appendChild(makeNode(document, 'div', cls)); },
  });
  return node;
}

function rig({ focus = true, value = '#6ee787', recents = [] } = {}) {
  const document = events({ activeElement: null });
  document.createElement = (tag) => makeNode(document, tag);
  document.body = makeNode(document, 'body');
  const anchor = makeNode(document, 'button');
  document.body.appendChild(anchor);

  const window = events({ innerWidth: 1920, innerHeight: 1080 });
  const held = [];
  if (focus) {
    window.DialogFocus = {
      hold(root, { onEsc }) {
        const entry = { root, onEsc, seen: root.style.visibility };
        held.push(entry);
        return () => held.splice(held.indexOf(entry), 1);
      },
    };
  }
  const queue = [];
  const store = { 'xeneonedge.cp.recent.v1': JSON.stringify(recents) };
  const ctx = {
    window, document, Event: class {},
    localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
    setTimeout: (fn) => { queue.push(fn); return 0; },
    requestAnimationFrame: (fn) => { queue.push(fn); return 0; },
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);

  const picks = [];
  window.ColorPicker.open({ anchor, value, onPick: (hex) => picks.push(hex) });
  while (queue.length) queue.shift()();

  const pop = () => document.body.children.find((c) => c.className === 'cp-pop') || null;
  const part = (cls) => pop().querySelector(cls);
  const drag = (el, x, y) => { el.fire('pointerdown', { clientX: x, clientY: y }); el.fire('pointerup'); };
  const recent = () => JSON.parse(store['xeneonedge.cp.recent.v1']);
  return { window, document, anchor, held, picks, pop, part, drag, recent };
}

test('a drag applies at once and the popover stays', () => {
  const r = rig();
  r.drag(r.part('.cp-sv'), 50, 50);
  assert.equal(r.picks.length, 1);
  assert.ok(r.pop(), 'closing here is what cost a second trip for the shade');
});

test('a hue and then a shade are one visit, and leave one recent colour', () => {
  const r = rig();
  r.drag(r.part('.cp-hue'), 60, 0);
  r.drag(r.part('.cp-sv'), 40, 30);
  assert.equal(r.picks.length, 2);
  assert.deepEqual(r.recent(), [], 'nothing is saved while the visit goes on');
  r.window.ColorPicker.close();
  assert.deepEqual(r.recent(), [r.picks[1]]);
});

test('a visit that changed nothing leaves no recent colour', () => {
  const r = rig();
  r.window.ColorPicker.close();
  assert.deepEqual(r.recent(), []);
});

test('a swatch is a whole answer: it applies and closes', () => {
  const r = rig();
  r.pop().all().find((n) => n.className === 'cp-swatch').fire('click');
  assert.deepEqual(r.picks, ['#ff3b30']);
  assert.equal(r.pop(), null);
  assert.deepEqual(r.recent(), [], 'a preset is always one tap away');
});

test('a typed colour applies and stays open', () => {
  const r = rig();
  const hex = r.part('.cp-hex');
  hex.value = '123456';
  hex.fire('change');
  assert.deepEqual(r.picks, ['#123456']);
  assert.ok(r.pop());
});

test('a colour still in the field counts when the tap lands outside', () => {
  const r = rig();
  const hex = r.part('.cp-hex');
  hex.value = '#123456';
  r.document.activeElement = hex;
  r.document.fire('pointerdown', { target: r.document.body });
  assert.deepEqual(r.picks, ['#123456']);
  assert.equal(r.pop(), null);
});

test('a tap on the opener leaves it open, a tap inside too', () => {
  const r = rig();
  r.document.fire('pointerdown', { target: r.anchor });
  r.document.fire('pointerdown', { target: r.part('.cp-sv') });
  assert.ok(r.pop());
});

test('leaving the window closes it: a widget window takes no taps outside its tiles', () => {
  const r = rig();
  r.window.fire('blur');
  assert.equal(r.pop(), null);
  assert.equal(r.window.listening('blur'), 0, 'nothing keeps listening');
  assert.equal(r.window.listening('resize'), 0);
});

test('Esc belongs to the popover, and only once it can take the focus', () => {
  const r = rig();
  assert.equal(r.held.length, 1);
  assert.equal(r.held[0].root, r.pop());
  assert.equal(r.held[0].seen, '', 'a hidden popover cannot take the focus, and Esc would close what is under it');
  r.held[0].onEsc();
  assert.equal(r.pop(), null);
  assert.equal(r.held.length, 0, 'closing gives the keyboard back');
});

test('Esc works on a page without the keyboard helper', () => {
  const r = rig({ focus: false });
  r.document.fire('keydown', { key: 'Escape' });
  assert.equal(r.pop(), null);
});

test('a caller that redraws its row on a pick does not throw the popover into a corner', () => {
  const r = rig();
  const { left, top } = r.pop().style;
  r.anchor.isConnected = false;
  r.anchor.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0, bottom: 0 });
  r.window.fire('resize');
  assert.deepEqual([r.pop().style.left, r.pop().style.top], [left, top]);
});
