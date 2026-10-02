// "If I click the one on the right, sometimes the one on the left opens, and the
// other way round."
//
// Minimal top bar: two edge rails, each with a handle. After 10 idle seconds
// both tuck away and look exactly like a collapsed rail (the 22px handle). A
// touch on EITHER of them used to wake BOTH, so whichever side the user had left
// open slid back out while the handle they had actually tapped stayed put.
// A touch now wakes the side it landed on, and only that one.
//
// The rail logic is cut out of topbar-minimal.js and run against a small fake
// DOM, with the real timers replaced by a queue, so the 10 seconds cost nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// LF only, so the slices below find their markers on a CRLF (Windows) checkout too.
const SRC = readFileSync(new URL('../js/topbar-minimal.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function slice(from, to) {
  const a = SRC.indexOf(from);
  const b = SRC.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `cannot cut ${from.trim()} … ${to.trim()}`);
  return SRC.slice(a, b);
}

function fakeEl() {
  const cls = new Set();
  const handlers = {};
  return {
    className: '',
    classList: {
      add: (c) => cls.add(c),
      remove: (c) => cls.delete(c),
      contains: (c) => cls.has(c),
      toggle(c, force) { const on = force === undefined ? !cls.has(c) : !!force; if (on) cls.add(c); else cls.delete(c); return on; },
    },
    setAttribute() {}, append() {}, appendChild() {}, insertAdjacentElement() {},
    addEventListener(type, fn) { (handlers[type] = handlers[type] || []).push(fn); },
    emit(type, e) { (handlers[type] || []).forEach((fn) => fn(e || {})); },
  };
}

function rig(rails, extra = {}) {
  const code = slice('  let active = false;', '  // The reorderable island segments')
    + slice('  function buildRail(side) {', '  function enable() {')
    + `
    return {
      ui: () => ui, hub: () => hubSettings, setActive: (v) => { active = v; }, setEls: (v) => { els = v; },
      ensureUi, bindAutoHide, configureAutoHide, armAutoHide,
    };`;
  const timers = [];
  let nextId = 1;
  const docHandlers = {};
  const hub = { topbarRails: rails, topbarRailsAutoHide: true, ...extra };
  const env = {
    hubSettings: hub,
    normalizeSettings: (s) => s,
    saved: 0,
    saveHubSettings() { env.saved++; },
    t: (k) => k,
    window: { innerWidth: 1280 },
    document: {
      createElement: () => fakeEl(),
      body: fakeEl(),
      documentElement: { clientWidth: 1280 },
      addEventListener(type, fn) { (docHandlers[type] = docHandlers[type] || []).push(fn); },
    },
    setTimeout(fn, ms) { const id = nextId++; timers.push({ id, fn, ms }); return id; },
    clearTimeout(id) { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
  };
  const api = new Function('env', `
    const { normalizeSettings, saveHubSettings, t, window, document, setTimeout, clearTimeout } = env;
    let hubSettings = env.hubSettings;
    ${code}`)(env);
  api.setEls({ topbar: fakeEl() });
  api.ensureUi();
  api.setActive(true);
  api.bindAutoHide();
  api.configureAutoHide();
  const ui = api.ui();
  return {
    ui,
    // the code replaces the settings object on every write, so always read the current one
    get hub() { return api.hub(); },
    // let the idle countdown run out: every pending timer at or below its length
    idle() { timers.filter((t) => t.ms >= 10000).forEach((t) => { timers.splice(timers.indexOf(t), 1); t.fn(); }); },
    // a finger going down on a rail, then the click that ends the same tap
    tap(side) { ui[side].rail.emit('pointerdown'); ui[side].handle.emit('click'); },
    // a touch on the bare screen edge, where a tucked rail has slid off
    edge(x) { (docHandlers.pointerdown || []).forEach((fn) => fn({ clientX: x })); },
    hidden: (side) => ui[side].rail.classList.contains('is-auto-hidden'),
    collapsed: (side) => ui[side].rail.classList.contains('is-collapsed'),
  };
}

test('the idle timer tucks both rails away', () => {
  const r = rig({ left: false, right: true });
  assert.deepEqual([r.hidden('left'), r.hidden('right')], [false, false]);
  r.idle();
  assert.deepEqual([r.hidden('left'), r.hidden('right')], [true, true]);
});

test('tapping the right handle opens the right rail, and leaves the left one tucked away', () => {
  const r = rig({ left: false, right: true });   // left open, right collapsed
  r.idle();
  r.tap('right');
  assert.equal(r.hidden('right'), false, 'the right rail came back');
  assert.equal(r.collapsed('right'), false, 'and it opened: that is what the tap was for');
  assert.equal(r.hidden('left'), true, 'the left rail must not slide out because of a right tap');
  assert.deepEqual(r.hub.topbarRails, { left: false, right: false });
});

test('tapping the left handle brings the open left rail back, without closing it', () => {
  const r = rig({ left: false, right: true });
  r.idle();
  r.tap('left');
  assert.equal(r.hidden('left'), false);
  assert.equal(r.collapsed('left'), false, 'an open rail that was only tucked is revealed, not toggled');
  assert.equal(r.hidden('right'), true);
  assert.deepEqual(r.hub.topbarRails, { left: false, right: true }, 'nothing was saved: nothing changed');
});

test('the tap after that one does toggle, and only that side', () => {
  const r = rig({ left: false, right: false });
  r.idle();
  r.tap('right');
  assert.equal(r.collapsed('right'), false);
  r.tap('right');
  assert.equal(r.collapsed('right'), true);
  assert.equal(r.collapsed('left'), false, 'the left side was never touched');
});

test('touching the bare edge wakes that side only', () => {
  const r = rig({ left: false, right: true });
  r.idle();
  r.edge(1275);
  assert.deepEqual([r.hidden('left'), r.hidden('right')], [true, false]);
  r.edge(4);
  assert.deepEqual([r.hidden('left'), r.hidden('right')], [false, false]);
});

test('the middle of the screen wakes nothing', () => {
  const r = rig({ left: false, right: true });
  r.idle();
  r.edge(640);
  assert.deepEqual([r.hidden('left'), r.hidden('right')], [true, true]);
});

test('a plain tap, with nothing tucked away, still toggles just that side', () => {
  const r = rig({ left: true, right: true });
  r.tap('left');
  assert.deepEqual([r.collapsed('left'), r.collapsed('right')], [false, true]);
  assert.deepEqual(r.hub.topbarRails, { left: false, right: true });
});

test('the saved state for the other side comes from the rails on screen, not from a stale copy', () => {
  const r = rig({ left: true, right: true });
  r.ui.left.rail.classList.remove('is-collapsed');   // the left rail is open on screen…
  r.hub.topbarRails = { left: true, right: true };   // …while the stored copy still says closed
  r.tap('right');
  assert.deepEqual(r.hub.topbarRails, { left: false, right: false }, 'writing the right side must not close the left one behind its back');
});

test('with auto-hide off nothing is ever tucked away', () => {
  const r = rig({ left: false, right: true }, { topbarRailsAutoHide: false });
  r.idle();
  assert.deepEqual([r.hidden('left'), r.hidden('right')], [false, false]);
});
