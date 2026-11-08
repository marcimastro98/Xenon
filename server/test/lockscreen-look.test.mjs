// The built-in Ambient scene: a clock cut out of glass over a still wallpaper, on a screen
// that may stay on for hours. Three things broke the old one and must not come back.
//
// The cards never blurred anything. The overlay kept a filling opacity animation, which
// made it a backdrop root, so backdrop-filter sampled an empty layer and the sharp
// wallpaper showed straight through.
//
// The glass and its lit edge came out shifted. A <text> in a clipPath scaled to a 0-1 box
// is laid out with rounded advances, so the digits are outlines now.
//
// It never stopped moving: eight loops on a page that sits idle all evening.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync as readFileSyncRaw } from 'node:fs';
import vm from 'node:vm';
// A Windows checkout (core.autocrlf) has CRLF; everything below matches on LF.
const readFileSync = (p, enc) => { const s = readFileSyncRaw(p, enc); return typeof s === 'string' ? s.replace(/\r\n/g, '\n') : s; };

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const CSS = read('../components/LockScreen/LockScreen.css');
const SCENE_CSS = read('../components/ScreenScene/ScreenScene.css');
const LOCK = read('../js/lockscreen.js');
const HTML = read('../index.html');
const SCENE_HTML = read('../scene.html');

// The rule whose selector list is exactly `selector`.
function rule(css, selector) {
  const at = css.indexOf(`\n${selector} {`);
  assert.notEqual(at, -1, `no rule for ${selector}`);
  return css.slice(at, css.indexOf('\n}', at));
}

function load(file, extra = {}) {
  const window = {};
  vm.runInNewContext(read(file), { window, ...extra });
  return window;
}

function fakeNode() {
  return {
    children: [],
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    replaceChildren(...nodes) { this.children = nodes; },
  };
}

function fakeClock() {
  const shade = fakeNode();
  const rim = fakeNode();
  const box = fakeNode();
  const svg = fakeNode();
  const vars = {};
  return {
    shade, rim, box, svg, vars,
    root: {
      style: { setProperty(name, value) { vars[name] = value; } },
      querySelectorAll(selector) { return selector === 'svg' ? [svg] : [shade, rim]; },
      querySelector() { return box; },
    },
  };
}

const digits = () => load('../js/lock-digits.js', {
  document: { createElementNS: () => fakeNode() },
}).LockDigits;

test('nothing in the scene runs forever', () => {
  assert.doesNotMatch(CSS, /\binfinite\b/);
  // The two keyframes that loop in the old scene; a canvas scene keeps its own stylesheet.
  for (const gone of ['lock-aurora', 'clock-breathe', 'digit-tick']) assert.ok(!CSS.includes(gone), gone);
  for (const gone of ['lockscreen-glass', 'lock-time-ampm', 'lock-events-count']) assert.ok(!HTML.includes(gone), gone);
});

test('the overlay and the stage never become a backdrop root', () => {
  for (const selector of ['.lockscreen-overlay', '.lockscreen-stage']) {
    const body = rule(CSS, selector);
    assert.doesNotMatch(body, /\n\s*(opacity|filter|mask|clip-path|mix-blend-mode|backdrop-filter)\s*:/, selector);
  }
  // Its entrance only touches the background colour.
  assert.match(rule(CSS, '.lockscreen-overlay'), /animation: lockscreen-dim [^;]*backwards;/);
  assert.match(CSS, /@keyframes lockscreen-dim \{ from \{ background-color: transparent; \} \}/);
});

test('an entrance never stays filled', () => {
  const scene = CSS.slice(CSS.indexOf('.lockscreen-exit {'));
  const fills = [...scene.matchAll(/animation:[^;]*;/g)].map((m) => m[0]).filter((a) => a !== 'animation: none;');
  assert.ok(fills.length >= 4);
  for (const entrance of fills) {
    assert.match(entrance, /backwards/, entrance);
    assert.doesNotMatch(entrance, /\bboth\b|\bforwards\b/, entrance);
  }
});

test('the dashboard behind the scene stops painting', () => {
  const shell = rule(CSS, 'body.lock-screen-active .shell');
  assert.match(shell, /visibility: hidden;/);
  assert.match(shell, /visibility 0s linear 0\.28s/);
  assert.doesNotMatch(shell, /\n\s*(filter|will-change)\s*:/);
  assert.match(CSS, /body\.lock-screen-active \.edge-rail \{ visibility: hidden; \}/);
});

test('glass has a plain answer on a weak GPU and for reduced transparency', () => {
  for (const selector of [
    'body.low-power-gpu:not([data-bg-static]) .lock-widget,\nbody.perf-mode .lock-widget',
    'body.low-power-gpu:not([data-bg-static]) .lock-digits-glass,\nbody.perf-mode .lock-digits-glass',
  ]) {
    const body = rule(CSS, selector);
    assert.match(body, /\n\s*backdrop-filter: none;/, selector);
    assert.match(body, /background: var\(--lk-(sheet|digit)-solid\);/, selector);
  }
  const reduced = CSS.slice(CSS.indexOf('@media (prefers-reduced-transparency: reduce)'));
  assert.match(reduced, /\.lock-widget, \.lockscreen-exit \{[^}]*backdrop-filter: none;/);
  assert.match(reduced, /\.lock-digits-glass \{[^}]*backdrop-filter: none;/);
  assert.match(CSS, /@media \(prefers-reduced-motion: reduce\) \{\n\s*\.lockscreen-overlay,[^{]*\{ animation: none; \}\n\s*\.lockscreen-stage \{ transition: none; \}/);
});

test('every control can be pressed with a finger', () => {
  assert.match(rule(CSS, '.lockscreen-exit'), /width: 44px;\n\s*height: 44px;/);
  assert.match(rule(CSS, '.lock-media-actions button'), /width: max\(44px, 2\.5em\);\n\s*height: max\(44px, 2\.5em\);/);
  assert.match(rule(CSS, '.lock-event-item'), /min-height: 44px;/);
});

test('the clock alone grows by a factor, and an upright screen keeps its fit', () => {
  assert.match(rule(CSS, '.lockscreen-time'), /width: calc\(var\(--lk-clock-height\) \* var\(--lk-clock-grow, 1\) \* var\(--lk-digits-ratio, 3\.2\)\);/);
  const upright = CSS.slice(CSS.indexOf('@container scene (max-aspect-ratio: 1/1) {'));
  assert.match(upright, /--lk-clock-height: min\(18em, calc\(\(100cqw - var\(--u\) \* 3\.6\) \/ 3\.3\)\);/);
  assert.match(upright, /\.lockscreen-overlay\.no-cards \.lockscreen-stage \{ --lk-clock-grow: 1; \}/);
  assert.match(LOCK, /overlay\.classList\.toggle\('no-cards', noCards\);/);
  assert.match(LOCK, /grid\.classList\.toggle\('is-empty', noCards\);/);
});

test('a time lays out left to right from outlines', () => {
  const run = digits().layout('16:42');
  assert.equal(run.glyphs.length, 5);
  assert.equal(run.glyphs[0].x, 0);
  for (let i = 1; i < run.glyphs.length; i += 1) assert.ok(run.glyphs[i].x > run.glyphs[i - 1].x);
  assert.ok(run.width > run.glyphs[4].x);
  assert.ok(run.height > 0);
  for (const glyph of run.glyphs) assert.match(glyph.path, /^M/);
});

test('every character of a time has an outline and anything else is left out', () => {
  const { layout } = digits();
  for (const char of '0123456789:') assert.equal(layout(char).glyphs.length, 1, char);
  assert.equal(layout('1 2').glyphs.length, 2);
  assert.equal(layout('').glyphs.length, 0);
  assert.equal(layout('').width, 0);
});

test('drawing fills every layer and the clip uses the same boxes', () => {
  const { draw, layout } = digits();
  const clock = fakeClock();
  draw(clock.root, '9:05');
  const run = layout('9:05');
  assert.equal(clock.vars['--lk-digits-ratio'], String(run.width / run.height));
  assert.equal(clock.svg.attributes.viewBox, `0 0 ${run.width} ${run.height}`);
  assert.equal(clock.shade.children.length, 4);
  assert.equal(clock.rim.children.length, 4);
  // A <g> inside a clipPath draws nothing: each shape carries its own transform.
  assert.equal(clock.box.children.length, 4);
  assert.equal(clock.box.children[1].attributes.transform, `scale(${1 / run.width} ${1 / run.height}) translate(${run.glyphs[1].x} 0)`);
  assert.equal(clock.shade.children[1].attributes.transform, `translate(${run.glyphs[1].x} 0)`);
});

test('the markup has the layers the digits draw into, in both pages', () => {
  for (const id of ['lock-digits-box', 'lock-digits-shape', 'lock-digits-light', 'lockscreen-stage']) {
    assert.ok(HTML.includes(`id="${id}"`), id);
  }
  assert.ok(/<clipPath id="lock-digits-shape" data-lock-digits>/.test(HTML));
  for (const page of [HTML, SCENE_HTML]) {
    for (const script of ['js/weather-art.js', 'js/lock-digits.js']) assert.ok(page.includes(`<script src="${script}"></script>`), script);
  }
});

test('each sky has its own picture, and the night has a moon', () => {
  const { svg } = load('../js/weather-art.js').WeatherArt;
  const skies = ['state-sun', 'state-cloud', 'state-rain', 'state-storm', 'state-snow', 'state-fog'];
  assert.equal(new Set(skies.map((sky) => svg(sky, false))).size, skies.length);
  const moon = /fill="url\(#wx\d+-moon\)"/;
  assert.match(svg('state-moon', false), moon);
  assert.match(svg('state-cloud', true), moon);
  assert.doesNotMatch(svg('state-cloud', false), moon);
  assert.match(svg('', false), /^<svg/);
  assert.doesNotMatch(svg('state-rain', false), /<animate|animation/);
});

test('every drawing owns its gradients, so a hidden one cannot blank the next', () => {
  const { svg } = load('../js/weather-art.js').WeatherArt;
  const ids = (markup) => [...markup.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  const first = ids(svg('state-sun', false));
  const second = ids(svg('state-sun', false));
  assert.ok(first.length > 0);
  assert.equal(new Set([...first, ...second]).size, first.length + second.length);
  const markup = svg('state-rain', false);
  for (const used of markup.matchAll(/url\(#([^)]+)\)/g)) assert.ok(ids(markup).includes(used[1]), used[1]);
});

function clockScript() {
  const start = LOCK.indexOf('function renderLockClock()');
  const end = LOCK.indexOf('function classifyLockWeather');
  return LOCK.slice(start, end);
}

function clockSandbox(hours, minutes, uses12h) {
  const clock = fakeClock();
  const nodes = {
    'lockscreen-time': Object.assign(clock.root, { dataset: {}, attributes: {}, setAttribute(k, v) { this.attributes[k] = v; } }),
    'lockscreen-date': { textContent: '' },
    'lockscreen-stage': { style: { values: {}, setProperty(name, value) { this.values[name] = value; } } },
  };
  const drawn = [];
  const sandbox = {
    $: (id) => nodes[id],
    t: () => 'en-US',
    clockUses12h: () => uses12h,
    LockDigits: { draw: (_, text) => drawn.push(text) },
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [2026, 10, 6, hours, minutes])); }
    },
    Intl,
    String,
  };
  vm.runInNewContext(clockScript(), sandbox);
  return { sandbox, nodes, drawn };
}

test('12 hours: no leading zero, and AM or PM only in the words read aloud', () => {
  const { sandbox, nodes, drawn } = clockSandbox(9, 5, true);
  sandbox.renderLockClock();
  assert.deepEqual(drawn, ['9:05']);
  assert.equal(nodes['lockscreen-time'].attributes['aria-label'], '9:05 AM');
});

test('24 hours keep two digits', () => {
  const { sandbox, nodes, drawn } = clockSandbox(9, 5, false);
  sandbox.renderLockClock();
  assert.deepEqual(drawn, ['09:05']);
  assert.equal(nodes['lockscreen-time'].attributes['aria-label'], '09:05');
});

test('the clock redraws only when the minute changes', () => {
  const { sandbox, nodes, drawn } = clockSandbox(16, 42, false);
  sandbox.renderLockClock();
  sandbox.renderLockClock();
  sandbox.renderLockClock();
  assert.equal(drawn.length, 1);
  assert.ok(Object.keys(nodes['lockscreen-stage'].style.values).length === 2);
});

test('the scene walks a few pixels around its centre, a step a minute', () => {
  const { sandbox, nodes } = clockSandbox(16, 42, false);
  const seen = new Set();
  for (let step = 0; step < 9; step += 1) {
    sandbox.shiftLockStage();
    const { values } = nodes['lockscreen-stage'].style;
    for (const axis of ['--lk-shift-x', '--lk-shift-y']) assert.ok(Math.abs(parseFloat(values[axis])) <= 5, values[axis]);
    seen.add(`${values['--lk-shift-x']} ${values['--lk-shift-y']}`);
  }
  assert.equal(seen.size, 9);
  assert.match(rule(CSS, '.lockscreen-stage'), /transform: translate\(var\(--lk-shift-x, 0\), var\(--lk-shift-y, 0\)\);/);
});

test('a bright picture of your own gets a 35% veil, in colour only', () => {
  // Apple's figure for clear glass over bright content. An opacity here would make the
  // overlay a backdrop root again, and the cards would stop blurring the picture.
  assert.match(CSS, /\nbody:not\(\[data-bg-static\]\) \.lockscreen-overlay \{ background-color: rgba\(7, 8, 14, 0\.35\); \}/);
  assert.match(CSS, /\n:root\[data-appearance="light"\] body:not\(\[data-bg-static\]\) \.lockscreen-overlay \{ background-color: rgba\(255, 255, 255, 0\.35\); \}/);
});

test('the desktop scene brings its own picture for the glass to look through', () => {
  assert.match(SCENE_CSS, /\[data-desktop-scene\] \.lockscreen-overlay \{\n\s*background: #161c30 url\("\.\.\/\.\.\/assets\/wallpapers\/dusk\.webp"\)/);
  assert.match(SCENE_CSS, /:root\[data-appearance="light"\]\[data-desktop-scene\] \.lockscreen-overlay \{\n\s*background: #e4e7ee url\("\.\.\/\.\.\/assets\/wallpapers\/dusk-light\.webp"\)/);
});
