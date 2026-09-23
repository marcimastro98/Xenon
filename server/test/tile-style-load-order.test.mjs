import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Reported on GitHub #130: "there is a (minor) bug on update where all of the
// opacity settings I set per card reset".
//
// Same load-order hazard as dashboard-copies-fallback.test.mjs, one field over.
// normTileStyle() returned null whenever DashboardInstances was undefined, and
// dashboard-instances.js loads AFTER settings.js — so the parse-time
// loadHubSettings() stripped the style off every primary widget and every tab
// group. The hydrate normally put it back from the server. But a server-bound
// save before the hydrate (a GridStack mount `change`, say) bumps the local rev
// and mirrors the stripped layout to localStorage; the hydrate then sees the
// local copy as NEWER, takes it as the base and pushes it up. From there the
// server has no style either, and nothing is left to restore it from.
//
// Copies were not affected, because normalizeDashboardCopies already falls back
// to a raw passthrough — which is why one tile could keep its opacity while
// the one next to it lost it.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, '..', 'js', 'settings.js'), 'utf8');
const require = createRequire(import.meta.url);

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} not found in settings.js`);
  let depth = 0;
  const i = src.indexOf('{', start);
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`unbalanced braces while extracting ${name}`);
}

// `DashboardInstances` is a parameter so each test decides whether the module
// has loaded: undefined is the parse-time condition, the real module is every
// normalize after it.
function load(DashboardInstances) {
  const body = [
    'const DASHBOARD_GRID_COLUMNS = 24;',
    'const DASHBOARD_GRID_MAX_ROW = 400;',
    extractFunction(SRC, 'normTileStyle'),
    extractFunction(SRC, 'normalizeDashboardGeom'),
    extractFunction(SRC, 'normalizeDashboardGroups'),
    'return { normTileStyle, normalizeDashboardGeom, normalizeDashboardGroups };',
  ].join('\n');
  return new Function('DashboardInstances', body)(DashboardInstances);
}

const FALLBACK = { x: 0, y: 0, w: 8, h: 8, visible: true };
const STYLE = { mode: 'inherit', panelAlpha: 0.35 };

test('a primary widget keeps its style when DashboardInstances has not loaded yet', () => {
  const { normalizeDashboardGeom } = load(undefined);
  const out = normalizeDashboardGeom({ x: 2, y: 4, w: 8, h: 6, visible: true, style: STYLE }, FALLBACK);
  assert.deepEqual(out.style, STYLE, 'the per-card opacity must survive the parse-time normalize');
});

test('a tab group keeps its style when DashboardInstances has not loaded yet', () => {
  const { normalizeDashboardGroups } = load(undefined);
  const widgets = { media: {}, system: {} };
  const out = normalizeDashboardGroups(
    { g1: { members: ['media', 'system'], page: 'dashboard', style: STYLE } },
    widgets, ['dashboard'], []);
  assert.deepEqual(out.g1.style, STYLE);
});

test('the fallback passes only a plain object through', () => {
  const { normTileStyle } = load(undefined);
  assert.equal(normTileStyle(null), null);
  assert.equal(normTileStyle(undefined), null);
  assert.equal(normTileStyle('custom'), null);
  assert.equal(normTileStyle(42), null);
  assert.equal(normTileStyle([STYLE]), null);
});

test('once the module is up, the real normalizer is the one that runs', () => {
  const DI = require('../js/dashboard-instances.js');
  const { normTileStyle, normalizeDashboardGeom } = load(DI);
  // Out-of-range alpha and an unknown key: the raw fallback would keep both,
  // the real normalizer keeps neither.
  assert.deepEqual(normTileStyle({ mode: 'custom', panelAlpha: 5, evil: '<script>' }), { mode: 'custom' });
  const out = normalizeDashboardGeom({ x: 0, y: 0, w: 4, h: 4, style: { mode: 'inherit', panelAlpha: 0.357 } }, FALLBACK);
  assert.deepEqual(out.style, { mode: 'inherit', panelAlpha: 0.36 });
});

test('the renderer never sees the raw fallback', () => {
  // The passthrough is safe only because the layout is normalized again on
  // every read. Pin that: getDashboardLayout() must go through the normalizer.
  const layoutSrc = readFileSync(join(__dirname, '..', 'js', 'dashboard-layout.js'), 'utf8');
  assert.match(layoutSrc,
    /function getDashboardLayout\(\) \{\s*\n\s*return normalizeDashboardLayout\(hubSettings && hubSettings\.dashboardLayout\);/);
});
