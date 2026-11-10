// The glass of the functional layer on a new install: island, top bar, rails, notification.
// Someone who updates on another look must see nothing change, a look chosen in Settings must
// still win, and the slow paths must never be left with a thin fill and no blur behind words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync as readFileSyncRaw } from 'node:fs';
// A Windows checkout (core.autocrlf) has CRLF; everything below matches on LF.
const read = (rel) => readFileSyncRaw(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const CSS = read('../styles/liquid-chrome.css');
const HTML = read('../index.html');
const PHONE = read('../components/PhoneView/PhoneView.css');
const MINI = read('../components/TopbarMinimal/TopbarMinimal.css');

const uncommented = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

// Every selector list in the file, with the @media wrappers taken off.
function selectors(css) {
  return [...css.matchAll(/([^{}]+)\{/g)]
    .map((m) => m[1].trim())
    .filter((s) => s && !s.startsWith('@'));
}

// The declarations of the first rule whose selector contains `part`.
function body(part) {
  const at = uncommented.indexOf(part);
  assert.notEqual(at, -1, `no rule with ${part}`);
  const open = uncommented.indexOf('{', at);
  return uncommented.slice(open, uncommented.indexOf('}', open));
}

test('it loads after the Liquid sheet and before the look chosen in Settings', () => {
  const at = (name) => {
    const found = HTML.indexOf(name);
    assert.notEqual(found, -1, `index.html does not load ${name}`);
    return found;
  };
  assert.ok(at('styles/themes-liquid.css') < at('styles/liquid-chrome.css'));
  assert.ok(at('styles/liquid-chrome.css') < at('components/Topbar/TopbarLook.css'));
});

test('every rule waits for the Liquid look, so other looks stay as they were', () => {
  for (const list of selectors(uncommented)) {
    assert.ok(list.startsWith(':root[data-style="liquid"]'), `not behind Liquid: ${list.slice(0, 80)}`);
    for (const one of list.split(/,\n/)) {
      if (one.includes(':root')) assert.ok(one.trim().startsWith(':root[data-style="liquid"]'), one);
    }
  }
});

test('nothing here loops: the chrome stays on screen all day', () => {
  assert.doesNotMatch(uncommented, /@keyframes|animation\s*:/);
});

test('the slow paths drop the blur and thicken the fill together', () => {
  const low = body('body.low-power-gpu {');
  assert.match(low, /--lg-blur:\s*none/);
  assert.match(low, /--lg-fill:\s*rgba\(var\(--panel-rgb\),\s*0\.86\)/);
  const reduced = uncommented.slice(uncommented.indexOf('prefers-reduced-transparency'));
  assert.match(reduced, /--lg-blur:\s*none/);
  assert.match(reduced, /--lg-fill:\s*rgba\(var\(--panel-rgb\),\s*0\.94\)/);
  assert.match(reduced, /--lg-sheen:\s*none/);
});

test('light has its own glass, with a dark mark instead of green on white', () => {
  const light = body('[data-appearance="light"] {');
  for (const token of ['--lg-fill', '--lg-sheen', '--lg-edge', '--lg-rim', '--lg-lift', '--lg-line', '--lg-hover', '--lg-mark', '--lg-grabber']) {
    assert.ok(light.includes(token), `${token} missing on light`);
  }
  assert.match(light, /--lg-mark:\s*var\(--accent-ink\)/);
});

test('the island, its notification skins and the rails share the one material', () => {
  const surface = uncommented.slice(uncommented.indexOf(':root[data-style="liquid"] :is('));
  for (const part of ['.topbar-mini', '.sdk-island', '.xisland-skin--pill', '.edge-rail-body']) {
    assert.ok(surface.slice(0, surface.indexOf('{')).includes(part), `${part} left out of the glass`);
  }
  // The hand-over from pill to notification must stay invisible: same box, same blur.
  const card = body('.xisland-skin--card');
  assert.match(card, /backdrop-filter:\s*var\(--lg-blur\)/);
  assert.match(card, /var\(--xt-fill\)/);
});

test('the grabber keeps the 22 x 62 target of the handle', () => {
  const handle = MINI.slice(MINI.indexOf('\n.edge-rail-handle {'));
  assert.match(handle.slice(0, 80), /width: 22px;\n\s*height: 62px;/);
  assert.doesNotMatch(body('.edge-rail-handle {'), /\b(width|height)\s*:/);
});

test('ghost takes the glass away and a chosen surface brings the old panel back', () => {
  const capsules = selectors(uncommented).find((s) => s.includes('> :is(.quickbar, .top-actions, .clock)'));
  assert.ok(capsules, 'no capsule rule');
  assert.ok(capsules.includes(':not([data-tb-surface])'));
  assert.ok(capsules.includes(':not([data-tb-button-style="ghost"])'));
  for (const list of selectors(uncommented).filter((s) => /\.topbar(?!-)/.test(s) && !s.includes('.topbtn-xenon') && !s.includes('.is-phone') && s.includes('.topbar >'))) {
    assert.ok(list.includes(':not([data-panel])'), `a page panel loses its own bar: ${list.slice(0, 90)}`);
  }
});

test('a phone shows no glass around nothing and no dot after the time', () => {
  assert.match(uncommented, /\.is-phone body:not\(\.topbar-minimal\):not\(\[data-panel\]\) \.topbar > \.top-actions \{ display: none; \}/);
  assert.match(PHONE, /\.is-phone \.topbar \.clock-meta-sep \{ display: none; \}/);
});

test('the phone dock is the same glass, keys without plates', () => {
  assert.match(body('.ph-dock {'), /backdrop-filter:\s*var\(--lg-blur\)/);
  assert.match(body('.ph-btn:not(.ph-btn-action) {'), /background:\s*transparent/);
  // The word under an icon was 8.5 px.
  assert.match(body('.ph-lab {'), /font-size:\s*10\.5px/);
});

test('the clock capsule keeps its size where the bar is a flex row', () => {
  // PhoneView.css makes the tablet's clock flex 1 1 auto: glass that wide reads as a panel.
  const clock = selectors(uncommented).find((s) => s.includes(':not(.is-phone)') && s.endsWith('.topbar > .clock'));
  assert.ok(clock, 'no clock rule');
  const rule = uncommented.slice(uncommented.indexOf(clock));
  assert.match(rule.slice(0, rule.indexOf('}')), /flex: 0 1 auto;/);
});

test('online is silent, only a problem shows a mark', () => {
  assert.match(uncommented, /\.clock-meta \.status-dot-inline:not\(\.offline\) \{ display: none; \}/);
});
