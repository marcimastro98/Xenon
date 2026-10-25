// A switch key's tap runs tap or tapOff by its current face and flips its own
// state; a confirm key needs a second tap within the window. The real
// bindActionKey is cut out of deck.js and wired to stubs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const M = require('../js/deck-model.js');

const JS = readFileSync(new URL('../js/deck.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function loadBinder() {
  const start = JS.indexOf('  function bindActionKey(');
  const end = JS.indexOf('\n  }\n', start) + 4;
  assert.ok(start > 0 && end > start, 'bindActionKey not found');
  const fired = [];
  const own = [];
  const make = new Function('fired', 'own', 'window', `
    const bindPressFeedback = () => {};
    const fireFeedback = () => {};
    const runAction = () => {};
    const lightingAction = () => {};
    const flashError = () => {};
    const tr = (k, fb) => fb;
    const el = (tag, cls, text) => ({ cls, text, remove() { this.gone = true; } });
    const setOwnState = (name, on) => own.push([name, on]);
    const scheduleAutoOff = () => {};
    const cancelAutoOff = () => {};
    const stateSnapshot = {};
    const runTrigger = (t) => { fired.push(t.name); return Promise.resolve(true); };
    ${JS.slice(start, end)}
    return bindActionKey;
  `);
  return { bindActionKey: make(fired, own, { DeckModel: M }), fired, own };
}

function fakeNode(on) {
  const handlers = {};
  const classes = new Set(on ? ['is-on'] : []);
  const kids = [];
  return {
    dataset: {},
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
    appendChild: (k) => kids.push(k),
    querySelector: () => kids.find((k) => !k.gone) || null,
    kids,
    addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
    emit(type, e = {}) { (handlers[type] || []).forEach((fn) => fn(e)); },
  };
}
const tap = (node) => { node.emit('pointerdown', { button: 0 }); node.emit('pointerup', { button: 0 }); };
const settle = () => new Promise((r) => setTimeout(r, 0));

test('a switch runs tap while off and tapOff while on, flipping its own state', async () => {
  const key = { id: 'k_sw', kind: 'action', toggle: true, triggers: { tap: { name: 'tap' }, tapOff: { name: 'tapOff' } } };
  const { bindActionKey, fired, own } = loadBinder();
  const off = fakeNode(false);
  bindActionKey(off, key, {});
  tap(off); await settle();
  const on = fakeNode(true);
  bindActionKey(on, key, {});
  tap(on); await settle();
  assert.deepEqual(fired, ['tap', 'tapOff']);
  assert.deepEqual(own, [['deck.k_sw', true], ['deck.k_sw', false]]);
});

test('a switch bound to a real state follows it and keeps no state of its own', async () => {
  const key = { id: 'k_mic', kind: 'action', toggle: true, state: { source: 'micMuted' }, triggers: { tap: { name: 'mute' } } };
  const { bindActionKey, fired, own } = loadBinder();
  const node = fakeNode(true);
  bindActionKey(node, key, {});
  tap(node); await settle();
  assert.deepEqual(fired, ['mute'], 'no tapOff: tap runs again');
  assert.deepEqual(own, []);
});

test('a switch with no action still flips, so it can drive other keys', async () => {
  const { bindActionKey, fired, own } = loadBinder();
  const node = fakeNode(false);
  bindActionKey(node, { id: 'k_x', kind: 'action', toggle: true, triggers: {} }, {});
  tap(node); await settle();
  assert.deepEqual(fired, []);
  assert.deepEqual(own, [['deck.k_x', true]]);
});

test('a confirm key arms on the first tap and runs on the second', async () => {
  const { bindActionKey, fired } = loadBinder();
  const node = fakeNode(false);
  bindActionKey(node, { id: 'k_c', kind: 'action', confirm: true, triggers: { tap: { name: 'shutdown' } } }, {});
  tap(node); await settle();
  assert.deepEqual(fired, [], 'first tap only arms');
  assert.equal(node.classList.contains('is-arming'), true);
  assert.equal(node.kids[0].text, 'Tap again');
  tap(node); await settle();
  assert.deepEqual(fired, ['shutdown']);
  assert.equal(node.classList.contains('is-arming'), false);
});
