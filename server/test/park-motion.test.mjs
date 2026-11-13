import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './browser-source.mjs';
import vm from 'node:vm';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// Chromium keeps asking for a main frame on every vsync for a main-thread animation or
// transition left inside content-visibility: hidden, and for a loop on a hidden layer: 240 a
// second on a 240 Hz screen with nothing to draw. On a bare page: width, colour, filter, an SVG
// path or group; nothing for what the compositor runs. The real dashboard went from 20.7% to
// 8.1% of a core in the renderer with these two CSS rules together.

function classes(log, owner) {
  const set = new Set();
  return {
    contains: (name) => set.has(name),
    add: (...names) => names.forEach((name) => { set.add(name); log.push(`${owner} +${name}`); }),
    remove: (...names) => names.forEach((name) => { if (set.delete(name)) log.push(`${owner} -${name}`); }),
    toggle(name, on) {
      if (on === set.has(name)) return on;
      if (on) this.add(name); else this.remove(name);
      return on;
    },
  };
}

function loop(playState = 'running') {
  const a = {
    playState,
    calls: [],
    pause() { a.calls.push('pause'); a.playState = 'paused'; },
    play() { a.calls.push('play'); a.playState = 'running'; },
  };
  return a;
}

function makePager() {
  const log = [];
  const timers = [];
  const listeners = {};
  const body = { classList: classes(log, 'body'), dataset: {}, get offsetHeight() { log.push('flush'); return 0; } };
  class Element {}
  const element = (id) => Object.assign(new Element(), {
    id,
    offsetLeft: 0,
    hidden: false,
    classList: classes(log, id),
    anims: [],
    getAnimations(options) { log.push(`read ${id} ${options && options.subtree ? 'subtree' : ''}`.trim()); return this.anims; },
  });
  const viewport = {
    classList: classes(log, 'viewport'),
    scrollLeft: 0,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    scrollTo() {},
  };
  const dot = () => ({ dataset: {}, classList: classes([], 'dot'), setAttribute() {}, addEventListener() {}, appendChild() {} });
  const window = { dispatchEvent() {}, AmbientIdle: { sweep() { log.push('sweep'); } } };
  const sandbox = {
    window,
    document: { body, addEventListener() {}, createElement: dot, createElementNS: dot },
    CustomEvent: class {},
    Element,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    console,
  };
  vm.runInNewContext(read('js/dashboard-pager.js'), sandbox);
  const pager = window.DashboardPager;
  const home = element('home');
  const other = element('other');
  pager.registerPage({ id: 'home', label: 'Home', element: home });
  pager.registerPage({ id: 'other', label: 'Other', element: other });
  pager.init({ viewport, dots: { appendChild() {}, textContent: '' } });
  const settle = () => { while (timers.length) timers.shift()(); };
  const scroll = () => listeners.scroll.forEach((fn) => fn());
  return { pager, log, home, other, body, settle, scroll };
}

test('motion stops before the lock', () => {
  const { log, settle } = makePager();
  log.length = 0;
  settle();
  const at = (entry) => log.indexOf(entry);
  assert.ok(at('other +is-parking') >= 0, 'the page takes the class that stops its motion');
  assert.ok(at('other +is-parking') < at('flush'), 'the class comes before the flush');
  assert.ok(at('flush') < at('read other subtree'), 'style has landed when the page is read');
  assert.ok(at('read other subtree') < at('other +is-parked'), 'the lock is the last step');
  assert.equal(at('home +is-parked'), -1, 'the page on screen stays free');
  assert.equal(at('home +is-parking'), -1);
});

test('a loop only a script can stop is paused by hand and played on the way back', () => {
  const { other, settle, scroll } = makePager();
  const scripted = loop();
  const cssHeld = loop('paused');
  other.anims = [scripted, cssHeld];
  settle();
  assert.deepEqual(scripted.calls, ['pause']);
  assert.deepEqual(cssHeld.calls, [], 'what CSS holds stays with CSS');
  scroll();
  assert.deepEqual(scripted.calls, ['pause', 'play']);
  assert.deepEqual(cssHeld.calls, []);
  assert.equal(other.classList.contains('is-parked'), false);
  assert.equal(other.classList.contains('is-parking'), false);
});

test('a rebuilt page set gives held loops back and parks them again', () => {
  const { home, other, settle, pager } = makePager();
  const scripted = loop();
  other.anims = [scripted];
  settle();
  pager.setPages([{ id: 'home', label: 'Home', element: home }, { id: 'other', label: 'Other', element: other }]);
  assert.deepEqual(scripted.calls, ['pause', 'play']);
  settle();
  assert.deepEqual(scripted.calls, ['pause', 'play', 'pause']);
  pager.setPages([{ id: 'home', label: 'Home', element: home }, { id: 'other', label: 'Other', element: other }]);
  assert.deepEqual(scripted.calls, ['pause', 'play', 'pause', 'play'], 'once per hold, the list starts empty each time');
});

test('nothing stays held when the page that held it is gone', () => {
  const { home, other, settle, pager } = makePager();
  const scripted = loop();
  other.anims = [scripted];
  settle();
  pager.setPages([{ id: 'home', label: 'Home', element: home }]);
  assert.deepEqual(scripted.calls, ['pause', 'play']);
});

test('a browser with no element animations still parks', () => {
  const { other, settle } = makePager();
  delete other.getAnimations;
  settle();
  assert.equal(other.classList.contains('is-parked'), true);
});

test('coming back wakes the idle sweep once, and a scroll with nothing parked does nothing', () => {
  const { log, settle, scroll } = makePager();
  scroll();
  assert.equal(log.filter((e) => e === 'sweep').length, 0, 'nothing was parked yet');
  settle();
  log.length = 0;
  scroll();
  scroll();
  assert.equal(log.filter((e) => e === 'sweep').length, 1, 'every scroll tick lands here, the sweep must not');
});

test('editing a layout never parks', () => {
  const { other, body, settle } = makePager();
  body.classList.add('layout-editing');
  settle();
  assert.equal(other.classList.contains('is-parking'), false);
  assert.equal(other.classList.contains('is-parked'), false);
});

test('a loop the idle sweep froze waits for its page', () => {
  const { pager, other, settle, scroll } = makePager();
  settle();
  const inside = loop('paused');
  inside.effect = { target: { closest: (selector) => (selector === '.pager-page.is-parked' ? other : null) } };
  const outside = loop('paused');
  outside.effect = { target: { closest: () => null } };
  const noTarget = loop('paused');
  assert.equal(pager.holdIfParked(inside), true);
  assert.equal(pager.holdIfParked(outside), false);
  assert.equal(pager.holdIfParked(noTarget), false);
  scroll();
  assert.deepEqual(inside.calls, ['play']);
  assert.deepEqual(outside.calls, []);
});

function makeIdle(pager) {
  const windowListeners = {};
  const timers = [];
  const anims = [];
  const log = [];
  const sandbox = {
    window: { addEventListener(type, fn) { windowListeners[type] = fn; }, DashboardPager: pager },
    document: {
      hidden: false,
      body: { classList: classes(log, 'body'), offsetHeight: 0 },
      addEventListener(type, fn) { (windowListeners[`doc:${type}`] ||= []).push(fn); },
      getAnimations: () => anims,
    },
    navigator: { userAgent: 'Chrome' },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    Date,
    console,
  };
  vm.runInNewContext(read('js/ambient-idle.js'), sandbox);
  return { sandbox, windowListeners, timers, anims, run: () => { while (timers.length) timers.shift()(); } };
}

function infinite() {
  const a = loop();
  a.effect = { getComputedTiming: () => ({ iterations: Infinity }), target: { closest: () => null } };
  return a;
}

test('the wake plays what is on screen and leaves a parked page to the pager', () => {
  const parked = infinite();
  const shown = infinite();
  const idle = makeIdle({ holdIfParked: (a) => a === parked });
  idle.anims.push(parked, shown);
  idle.run();
  assert.deepEqual(parked.calls, ['pause']);
  assert.deepEqual(shown.calls, ['pause']);
  idle.windowListeners.pointerdown();
  assert.deepEqual(parked.calls, ['pause'], 'it would run behind the lock');
  assert.deepEqual(shown.calls, ['pause', 'play']);
});

test('the wake still works on a page with no pager', () => {
  const shown = infinite();
  const idle = makeIdle(undefined);
  idle.anims.push(shown);
  idle.run();
  idle.windowListeners.pointerdown();
  assert.deepEqual(shown.calls, ['pause', 'play']);
});

test('sweep() catches what started again while idle, and nothing while awake', () => {
  const idle = makeIdle(undefined);
  idle.sandbox.window.AmbientIdle.sweep();
  assert.equal(idle.timers.length, 1, 'awake, only the idle countdown is pending');
  idle.run();
  const late = infinite();
  idle.anims.push(late);
  idle.sandbox.window.AmbientIdle.sweep();
  idle.sandbox.window.AmbientIdle.sweep();
  assert.equal(idle.timers.length, 1, 'one sweep for a batch');
  idle.run();
  assert.deepEqual(late.calls, ['pause']);
  const later = infinite();
  idle.anims.push(later);
  idle.sandbox.window.AmbientIdle.sweep();
  idle.run();
  assert.deepEqual(later.calls, ['pause'], 'and the next batch too');
});

// A tile that re-renders cancels the loop on its old element, and play() does not fail on that: it
// starts the loop again on an element out of the page, where document.getAnimations() cannot see it
// and no sweep can stop it. Measured on the real dashboard: one of these kept 240 style passes a
// second going until the page reloaded, 11.4% against 5.7% of a core in the renderer.
test('a wake leaves dead a loop whose tile re-rendered', () => {
  const gone = infinite();
  const shown = infinite();
  const held = [];
  const idle = makeIdle({ holdIfParked: (a) => { held.push(a); return false; } });
  idle.anims.push(gone, shown);
  idle.run();
  gone.playState = 'idle';
  idle.windowListeners.pointerdown();
  assert.deepEqual(gone.calls, ['pause']);
  assert.deepEqual(shown.calls, ['pause', 'play']);
  assert.deepEqual(held, [shown], 'a dead loop is not handed to the pager either');
});

test('a page coming back leaves dead a loop cancelled behind the lock', () => {
  const { other, settle, scroll } = makePager();
  const gone = loop();
  const kept = loop();
  other.anims = [gone, kept];
  settle();
  gone.playState = 'idle';
  scroll();
  assert.deepEqual(gone.calls, ['pause']);
  assert.deepEqual(kept.calls, ['pause', 'play']);
});

test('a long idle forgets dead loops at each sweep, a tile re-rendering all night pins nothing', () => {
  const gone = infinite();
  const alive = infinite();
  const idle = makeIdle(undefined);
  idle.anims.push(gone, alive);
  idle.run();
  gone.playState = 'idle';
  idle.anims.length = 0;
  idle.sandbox.window.AmbientIdle.sweep();
  idle.run();
  gone.playState = 'paused'; // only a list that dropped it leaves it alone now
  idle.windowListeners.pointerdown();
  assert.deepEqual(gone.calls, ['pause']);
  assert.deepEqual(alive.calls, ['pause', 'play'], 'what is still frozen stays on the list');
});

test('parked pages stop motion and only .is-parked holds the lock', () => {
  const css = read('components/DashboardPager/DashboardPager.css');
  const rule = css.match(/body:not\(\.layout-editing\) \.pager-page\.is-parking \*,\s+body:not\(\.layout-editing\) \.pager-page\.is-parking \*::before,\s+body:not\(\.layout-editing\) \.pager-page\.is-parking \*::after \{([^}]*)\}/);
  assert.ok(rule, 'the rule covers the tiles and their pseudo-elements');
  assert.match(rule[1], /animation-play-state: paused !important;/);
  assert.match(rule[1], /transition: none !important;/);
  assert.match(css, /\.pager-page\.is-parked \{ content-visibility: hidden; \}/);
  assert.doesNotMatch(css, /\.is-parking[^{]*\{[^}]*content-visibility/, 'one class stops motion, the next one locks');
});

test('a switched-off background layer stops its loop', () => {
  const css = read('styles/backgroundfx.css');
  assert.match(css, /body:not\(\.aurora-on\) \.aurora-blob,\s+body:not\(\.grid-on\) \.grid-plane \{ animation-play-state: paused; \}/);
});
