import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { appStringsSource } from './i18n-source.mjs';

// The classic Weather look is the 4.11.13 tile, brought back as a choice. It shares the mount
// and some class names with the current tile, so it must stay one closed file with one global,
// and its CSS must never reach the current tile.

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const JS = read('js', 'weather-classic.js');
const CSS = read('components', 'WeatherTile', 'WeatherClassic.css');
const I18N = appStringsSource();

const SCOPE = '.weather-tile-root--classic';
const CLASSIC_KEYS = [
  'weather_rain_short',
  'weather_metric_humidity_sub',
  'weather_metric_pressure_sub',
  'weather_metric_visibility_sub',
  'weather_metric_uv_sub',
  'weather_metric_clouds_sub',
];

// Every style rule's selector list, outside @keyframes (their 0%/to steps are not selectors).
function styleSelectors(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const stack = [];
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') {
      const head = src.slice(start, i).trim();
      const inKeyframes = stack.includes('keyframes');
      if (head.startsWith('@')) stack.push(/^@keyframes\b/.test(head) ? 'keyframes' : 'at');
      else {
        stack.push('rule');
        if (!inKeyframes) out.push(head);
      }
      start = i + 1;
    } else if (ch === '}') {
      stack.pop();
      start = i + 1;
    } else if (ch === ';' && stack[stack.length - 1] !== 'rule') {
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

test('the file is one closed IIFE whose only global is window.WeatherClassic', () => {
  const body = JS.replace(/^(\s*\/\/.*\n)+/, '').trim();
  assert.match(body, /^\(function \(\) \{\n {2}'use strict';/);
  assert.match(body, /\}\)\(\);$/);
  const globals = [...JS.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1]);
  assert.deepEqual(globals, ['WeatherClassic']);
  const sandbox = { window: {} };
  vm.runInNewContext(JS, sandbox);
  assert.deepEqual(Object.keys(sandbox.window), ['WeatherClassic']);
  assert.equal(typeof sandbox.window.WeatherClassic.render, 'function');
  assert.deepEqual(Object.keys(sandbox).sort(), ['window'], 'no top-level global leaks');
});

test('no markup is built from strings: text goes through textContent', () => {
  assert.doesNotMatch(JS, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/);
  assert.doesNotMatch(JS, /\son[a-z]+\s*=/, 'no inline handlers');
});

test('the hero opens the full view and the root carries both class names', () => {
  assert.match(JS, /toggleWeatherDetails\(\)/);
  assert.match(JS, /'weather-tile-root weather-tile-root--classic'/);
  assert.match(JS, /mount\.replaceChildren\(root\)/);
});

test('offline and stale readings keep their own look', () => {
  assert.match(JS, /'state-offline'/);
  assert.match(JS, /weatherErrorLabel\(data\)/);
  assert.match(JS, /weather-tile--stale/);
});

test('every CSS selector is scoped to the classic root', () => {
  const selectors = styleSelectors(CSS).flatMap(splitTopLevel);
  assert.ok(selectors.length > 50, `parsed ${selectors.length} selectors`);
  for (const sel of selectors) assert.ok(sel.includes(SCOPE), `unscoped selector: ${sel}`);
});

test('keyframes have the wxc- prefix and the sky stops with every other loop', () => {
  const names = [...CSS.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]);
  assert.ok(names.length >= 7);
  for (const n of names) assert.match(n, /^wxc-/);
  for (const m of CSS.matchAll(/animation:\s*([\w-]+)/g)) {
    if (m[1] !== 'none') assert.ok(names.includes(m[1]), `animation uses ${m[1]}`);
  }
  assert.match(CSS, /@media \(prefers-reduced-motion: reduce\)/);
  for (const cls of ['overlay-frozen', 'ambient-idle', 'game-mode', 'low-power-gpu', 'perf-mode']) {
    assert.match(CSS, new RegExp(`body\\.${cls}`), `${cls} stops the sky`);
  }
});

test('the 4.11.13 captions are back in every language, translated', () => {
  const ctx = { module: {} };
  vm.createContext(ctx);
  vm.runInContext(I18N.slice(0, I18N.search(/^function /m)) + ';globalThis.__i18n = i18n;', ctx);
  const langs = Object.keys(ctx.__i18n);
  assert.equal(langs.length, 11);
  // The same word in English, French and Dutch is a translation, not a copy.
  const sameAsEnglish = new Set(['fr.weather_metric_visibility_sub', 'nl.weather_metric_visibility_sub']);
  for (const l of langs) {
    for (const k of CLASSIC_KEYS) {
      const v = ctx.__i18n[l][k];
      assert.ok(typeof v === 'string' && v.trim(), `${l}.${k}`);
      if (l !== 'en' && !sameAsEnglish.has(`${l}.${k}`)) assert.notEqual(v, ctx.__i18n.en[k], `${l}.${k} is still English`);
    }
  }
});
