// The first-run tour (js/onboarding.js). Measured on the real dashboard before
// this was fixed: with the minimal top bar the Bit, Layout and Settings buttons
// sit in side rails that slide off screen, so the tour spotlit empty space past
// the edge; the media tile hidden behind its Chat tab got a 0x0 spotlight; on a
// phone every topbar button is hidden, so only three steps were left; and the
// last card sent people to Settings → Appearance, where the replay button is not.
//
// The tour runs here against a small fake DOM: each selector maps to a fake
// element with a fixed rect, so what is "on screen" is decided by the test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const TOUR = read('../js/onboarding.js');

function fakeEl(tag) {
  const cls = new Set();
  let text = '';
  const el = {
    tagName: tag, children: [], style: {},
    // Like the DOM: writing text replaces the children (renderCard relies on it).
    set textContent(v) { text = String(v); el.children = []; },
    get textContent() { return text; },
    set className(v) { cls.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => cls.add(c)); },
    get className() { return [...cls].join(' '); },
    classList: {
      add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c),
      toggle(c, on) { if (on ?? !cls.has(c)) cls.add(c); else cls.delete(c); },
    },
    setAttribute() {}, addEventListener() {}, remove() {},
    appendChild(c) { el.children.push(c); return c; },
    append(...c) { el.children.push(...c); },
    get offsetWidth() { return 320; }, get offsetHeight() { return 160; },
  };
  return el;
}

// A target: `rect` is [left, top, width, height]; `group` is the tab group it
// belongs to, `rail` the rail that holds it.
function target(rect, { group = null, rail = null } = {}) {
  const [left, top, width, height] = rect;
  return {
    getBoundingClientRect: () => ({ left, top, width, height, right: left + width, bottom: top + height }),
    closest: (sel) => (sel === '.tabgroup' ? group : sel === '.edge-rail' ? rail : sel === '.edge-rail.is-collapsed' && rail && rail.collapsed ? rail : null),
    scrollIntoView() { this.scrolled = true; },
  };
}

const IT = {
  ui_settings: 'Impostazioni', settings_cat_general: 'Generale', settings_cat_bit: 'Bit',
  onb_done_body: 'Puoi rivederlo da {path}.', onb_ai_body: 'Scegli chi risponde in {path}.',
};

function runTour(targets, extraWindow = {}) {
  const body = fakeEl('body');
  const docListeners = {};
  const document = {
    body,
    createElement: fakeEl,
    querySelector: (sel) => targets[sel] || null,
    addEventListener: (type, fn) => { docListeners[type] = fn; },
    removeEventListener: (type) => { delete docListeners[type]; },
  };
  const window = { innerWidth: 1440, innerHeight: 900, addEventListener() {}, removeEventListener() {}, ...extraWindow };
  const ctx = { window, document, requestAnimationFrame: (fn) => fn(), setTimeout, t: (k) => IT[k] || '<' + k + '>' };
  vm.createContext(ctx);
  vm.runInContext(TOUR, ctx);
  window.Onboarding.start();
  const overlay = body.children[0];
  const [spot, card] = overlay ? overlay.children : [];
  const state = () => {
    const [dots, title, text] = card.children;
    return { steps: dots.children.length, title: title.textContent, text: text.textContent, spot: { ...spot.style } };
  };
  // Advancing goes through the keyboard path the tour already listens on.
  const next = () => docListeners.keydown({ key: 'ArrowRight', preventDefault() {} });
  const escape = () => docListeners.keydown({ key: 'Escape', preventDefault() {} });
  return { window, overlay, state, next, escape, docListeners };
}

const SHOWN = [100, 100, 58, 58];
const HIDDEN = [0, 0, 0, 0];

function fullBar() {
  return {
    '.topbtn-xenon': target(SHOWN),
    '.chat-panel': target([500, 100, 450, 700]),
    '.qbtn-search': target(SHOWN),
    '#layout-edit-toggle': target(SHOWN),
    '#pager-dots': target([700, 10, 200, 40]),
    '.qbtn-settings': target(SHOWN),
  };
}

test('every step shows on the full top bar, and the last card names the real place of the replay', () => {
  const tour = runTour(fullBar());
  assert.equal(tour.state().steps, 8);
  for (let i = 0; i < 7; i++) tour.next();
  assert.equal(tour.state().text, 'Puoi rivederlo da Impostazioni → Generale.');
});

test('a step whose button is hidden, or whose tile is on another page, is skipped', () => {
  const t = fullBar();
  t['.qbtn-search'] = target(HIDDEN);
  t['.chat-panel'] = target([1600, 100, 450, 700]); // the next dashboard page, beside the viewport
  assert.equal(runTour(t).state().steps, 6);
});

test('a tile that is a tab of a group is spotlit as the whole group', () => {
  const t = fullBar();
  t['.chat-panel'] = target(HIDDEN);
  t['#media-panel'] = target([510, 160, 430, 640], { group: target([500, 100, 450, 700]) });
  const tour = runTour(t);
  tour.next(); tour.next();
  assert.equal(tour.state().title, '<onb_chat_title>');
  assert.equal(tour.state().spot.width, (450 + 16) + 'px');
  assert.equal(tour.state().spot.height, (700 + 16) + 'px');
});

test('a button in a rail sliding in still counts; one in a rail the user closed does not', () => {
  const t = fullBar();
  t['.topbtn-xenon'] = target([-60, 350, 58, 58], { rail: { collapsed: false } });
  t['.qbtn-search'] = target([-60, 420, 58, 58], { rail: { collapsed: true } });
  assert.equal(runTour(t).state().steps, 7);
});

test('the tour holds the minimal bar\'s rails out and open, and lets go when it ends', () => {
  const calls = [];
  const TopbarMinimal = { holdRails: (on) => calls.push('hold:' + on), peekRails: (on) => calls.push('peek:' + on) };
  let seen = 0;
  const tour = runTour(fullBar(), { TopbarMinimal, setOnboardingSeen: (v) => { seen = v; } });
  assert.deepEqual(calls, ['hold:true', 'peek:true']);
  tour.escape();
  assert.deepEqual(calls, ['hold:true', 'peek:true', 'hold:false', 'peek:false']);
  assert.equal(seen, 1);
  assert.equal(tour.docListeners.transitionend, undefined, 'the rail listener goes with the tour');
});

test('on a phone the thumb dock stands in for the hidden topbar buttons', () => {
  const t = {
    '.topbtn-xenon': target(HIDDEN),
    '.ph-dock [data-ph-for=".topbtn-xenon"]': target([110, 744, 68, 68]),
    '.chat-panel': target([2, 900, 386, 690]), // below the fold: scrolled into view
    '#pager-dots': target(HIDDEN),
    '.ph-dock.has-pages .ph-pages': target([276, 744, 114, 68]),
  };
  const tour = runTour(t, { innerWidth: 390, innerHeight: 844 });
  assert.equal(tour.state().steps, 5);
  tour.next();
  assert.equal(tour.state().spot.left, (110 - 8) + 'px');
  tour.next();
  assert.ok(t['.chat-panel'].scrolled, 'the chat tile was brought on screen');
});

test('the dock names the button each forwarder stands in for', () => {
  assert.match(read('../js/phone-view.js'), /if \(spec\.sel\) b\.dataset\.phFor = spec\.sel;/);
});

test('peekRails opens closed rails on screen only, and puts each back as it was', () => {
  const SRC = read('../js/topbar-minimal.js');
  const cut = (from, to) => SRC.slice(SRC.indexOf(from), SRC.indexOf(to, SRC.indexOf(from)));
  const rail = (collapsed) => { const r = fakeEl('div'); if (collapsed) r.classList.add('is-collapsed'); return r; };
  const handle = () => ({ setAttribute() {} });
  const ctx = { ui: { left: { rail: rail(true), handle: handle() }, right: { rail: rail(false), handle: handle() } } };
  vm.createContext(ctx);
  vm.runInContext(cut('  function syncRail', '  function ensureUi') + cut('  let peekedRails', '  window.TopbarMinimal') + ';globalThis.peekRails = peekRails;', ctx);
  ctx.peekRails(true);
  assert.equal(ctx.ui.left.rail.classList.contains('is-collapsed'), false);
  ctx.peekRails(true); // a second hold must not overwrite what it remembered
  ctx.peekRails(false);
  assert.equal(ctx.ui.left.rail.classList.contains('is-collapsed'), true);
  assert.equal(ctx.ui.right.rail.classList.contains('is-collapsed'), false);
  assert.doesNotMatch(cut('  let peekedRails', '  window.TopbarMinimal'), /writeRailState/, 'the stored choice is never written');
});

test('every language carries the tour, translated, with the Settings path left to the code', () => {
  const SRC = read('../js/i18n.js');
  const ctx = { module: {} };
  vm.createContext(ctx);
  vm.runInContext(SRC.slice(0, SRC.search(/^function /m)) + ';globalThis.__i18n = i18n;', ctx);
  const langs = Object.keys(ctx.__i18n);
  assert.equal(langs.length, 11);
  const en = ctx.__i18n.en;
  const keys = Object.keys(en).filter((k) => k.startsWith('onb_'));
  for (const k of ['onb_search_title', 'onb_search_body']) assert.ok(keys.includes(k), k);
  for (const l of langs) {
    const d = ctx.__i18n[l];
    for (const k of keys) assert.ok(d[k] && d[k].trim(), `${l}.${k}`);
    for (const k of ['onb_search_body', 'onb_layout_body', 'onb_pager_body', 'onb_settings_body']) {
      if (l !== 'en') assert.notEqual(d[k], en[k], `${l}.${k} is still English`);
    }
    for (const k of ['onb_ai_body', 'onb_done_body']) assert.match(d[k], /\{path\}/, `${l}.${k}`);
    assert.doesNotMatch(d.onb_layout_body, /drag|trascina/i, `${l}: "+" is a tap, not a drag`);
  }
});
