import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

// Settings → Weather → Style Classic brings back 4.11.13's Weather window as well as its
// tile (people on the Edge saw the same window on both styles). The window is its own lazily
// loaded file, reuses the classic tile's cards, and must leave the panel as it found it when
// the style changes back.

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const JS = read('js', 'weather-classic-window.js');
const CLASSIC = read('js', 'weather-classic.js');
const LOOK = read('js', 'weather-look.js');
const CSS = read('components', 'WeatherModal', 'WeatherClassicWindow.css');
const TILE_CSS = read('components', 'WeatherTile', 'WeatherClassic.css');

function selectors(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const stack = [];
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') {
      const head = src.slice(start, i).trim();
      if (head.startsWith('@')) stack.push(/^@keyframes\b/.test(head) ? 'keyframes' : 'at');
      else {
        if (!stack.includes('keyframes')) out.push(head);
        stack.push('rule');
      }
      start = i + 1;
    } else if (ch === '}') {
      stack.pop();
      start = i + 1;
    }
  }
  return out;
}

function splitTopLevel(list) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of list) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

// weather-look.js with the window's collaborators stubbed; files "load" when appended.
function lookSandbox({ look, data = { ok: true }, fetching = false, loaded = true }) {
  const calls = [];
  const sb = {
    hubSettings: { weather: { tile: { look } } },
    weatherData: data,
    fetchingWeather: fetching,
    console: { warn: () => {} },
    queueMicrotask,
    renderWeatherDetails: () => calls.push('details'),
    document: {
      addEventListener() {},
      querySelectorAll: () => [],
      createElement: () => ({ addEventListener(ev, fn) { if (ev === 'load') this.onLoad = fn; }, remove() {} }),
      head: { append: (...nodes) => { calls.push('load'); nodes.forEach((n) => n.onLoad && n.onLoad()); } },
    },
  };
  sb.window = sb;
  const windowApi = {
    render: () => calls.push('render'),
    release: () => calls.push('release'),
  };
  if (loaded) {
    sb.WeatherClassic = {};
    sb.WeatherClassicWindow = windowApi;
  } else {
    // The files define the globals as they arrive.
    sb.document.head.append = (...nodes) => {
      calls.push('load');
      sb.WeatherClassic = {};
      sb.WeatherClassicWindow = windowApi;
      nodes.forEach((n) => n.onLoad && n.onLoad());
    };
  }
  vm.runInNewContext(LOOK, sb);
  const content = { querySelector: () => null };
  return { sb, calls, content };
}

test('the file is one closed IIFE whose only global is window.WeatherClassicWindow', () => {
  const body = JS.replace(/^(\s*\/\/.*\n)+/, '').trim();
  assert.match(body, /^\(function \(\) \{\n {2}'use strict';/);
  assert.match(body, /\}\)\(\);$/);
  const sandbox = { window: {} };
  vm.runInNewContext(JS, sandbox);
  assert.deepEqual(Object.keys(sandbox.window), ['WeatherClassicWindow']);
  assert.deepEqual(Object.keys(sandbox.window.WeatherClassicWindow).sort(), ['release', 'render']);
  assert.deepEqual(Object.keys(sandbox).sort(), ['window'], 'no top-level global leaks');
});

test('no markup is built from strings, and the cards come from the classic tile', () => {
  assert.doesNotMatch(JS, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/);
  assert.doesNotMatch(JS, /\son[a-z]+\s*=/);
  assert.match(CLASSIC, /parts: Object\.freeze\(\{ buildHeroVisual, buildHeroChips, metricCards, createMetric, createHour, formatDate, placeText \}\)/);
  for (const part of ['buildHeroVisual', 'buildHeroChips', 'metricCards', 'createMetric', 'createHour', 'formatDate', 'placeText']) {
    assert.match(JS, new RegExp(`parts\\.${part}\\(`), `uses ${part}`);
  }
});

test('the panel takes the classic sky on render and gives it back on release', () => {
  assert.match(JS, /panel\.classList\.add\(PANEL\)/);
  assert.match(JS, /panel\.dataset\.wxState = state/);
  assert.match(JS, /panel\.classList\.remove\(PANEL\)/);
  assert.match(JS, /delete panel\.dataset\.wxState/);
  assert.match(JS, /content\.replaceChildren\(root\)/);
});

test('offline shows the reason and, for a wrong city, the Settings key', () => {
  assert.match(JS, /'state-offline'/);
  assert.match(JS, /weatherErrorHint\(data\)/);
  assert.match(JS, /WEATHER_SETTINGS_ERRORS\.has\(data\.error\)/);
  assert.match(JS, /buildWeatherWindowSettingsKey\(\)/);
});

test('Classic draws the classic window; another style releases it', () => {
  const classic = lookSandbox({ look: 'classic' });
  assert.equal(classic.sb.WeatherLook.renderWindow(classic.content), true);
  assert.deepEqual(classic.calls, ['render']);

  const fresh = lookSandbox({ look: 'new' });
  assert.equal(fresh.sb.WeatherLook.renderWindow(fresh.content), false);
  assert.deepEqual(fresh.calls, ['release']);
});

test('Classic still fetching with nothing to show leaves the waiting line to the new window', () => {
  const s = lookSandbox({ look: 'classic', data: null, fetching: true });
  assert.equal(s.sb.WeatherLook.renderWindow(s.content), false);
  assert.ok(!s.calls.includes('render'));
});

test('Classic before its files arrive loads them, then draws the window again', async () => {
  const s = lookSandbox({ look: 'classic', loaded: false });
  assert.equal(s.sb.WeatherLook.renderWindow(s.content), false);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(s.calls, ['load', 'details']);
  assert.match(LOOK, /const CLASSIC_WINDOW_JS = 'js\/weather-classic-window\.js';/);
  assert.match(LOOK, /const CLASSIC_WINDOW_CSS = 'components\/WeatherModal\/WeatherClassicWindow\.css';/);
  assert.match(LOOK, /js\.async = false;/, 'the window script runs after the tile script');
});

test('every window rule is scoped to the classic window or panel', () => {
  const ok = [/^:root \.weather-overlay > \.weather-panel\.weather-panel--classic\b/, /^\.weather-panel--classic\b/,
    /^\.weather-content:has\(> \.weather-classic-window\)/, /^\.weather-classic-window\b/,
    /^:is\(body\.[\w-]+(, body\.[\w-]+)*\) \.weather-classic-window\b/];
  const all = selectors(CSS).flatMap(splitTopLevel);
  assert.ok(all.length > 40, `parsed ${all.length} selectors`);
  for (const sel of all) assert.ok(ok.some((re) => re.test(sel)), `unscoped selector: ${sel}`);
});

test('the window sky animates with the tile\'s keyframes and stops with the other loops, not the overlay hold', () => {
  assert.match(TILE_CSS, /^:is\(\.weather-tile-root\.weather-tile-root--classic, \.weather-classic-window\) \.weather-viz-celestial \{/m);
  assert.doesNotMatch(CSS, /@keyframes/);
  const rules = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(rules, /overlay-frozen/, 'the window is the overlay: its hold must not still it');
  for (const cls of ['ambient-idle', 'game-mode', 'low-power-gpu', 'perf-mode']) {
    assert.match(CSS, new RegExp(`body\\.${cls}`), `${cls} stops the window sky`);
  }
  assert.match(CSS, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(rules, /backdrop-filter/, 'no blur re-sampled under the window');
});
