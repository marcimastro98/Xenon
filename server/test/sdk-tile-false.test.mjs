// Manifest `"tile": false` (v5.3): the creator keeps a widget to the top bar. It is never offered
// or placed as a tile or a widget on the screen, it runs in a service frame instead, and every
// place that adds a widget (the + panel, the menu, Bit, layers, the MCP tools) knows it. A widget
// with no part that runs without a tile cannot ask for it: it would run nowhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from './browser-source.mjs';
import vm from 'node:vm';
import { makeDom } from './mini-dom.mjs';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const { normalizeManifest } = require('../widget-sdk/manifest-normalize.js');
const layers = require('../capabilities/layers.js');
const { addChoices } = require('../menu/widget-add-choices.js');
const PM = require('../js/look/palette-model.js');
const P = require('../ai/ai-presets.js');
const T = require('../mcp/mcp-dev-tools.js');
const sdk = require('../sdk-widgets.js');
const { loadServerSettingsSlice, serverDashboardWidgets } = await import('./server-settings-slice.mjs');

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const norm = (extra) => normalizeManifest({ api: 1, name: 'Battery', ...extra }, 'battery');
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o), 'utf8').toString('base64');

test('tile: false with a bar part: never a tile, and it runs in the background by itself', () => {
  for (const part of [{ badge: true }, { mini: true }, { topbarButton: true }, { island: { dynamic: true } }, { island: { full: true } }]) {
    const r = norm({ tile: false, ...part });
    assert.equal(r.ok, true, JSON.stringify(part));
    assert.equal(r.manifest.tile, false, JSON.stringify(part));
    assert.equal(r.manifest.background, true, 'implied, so the bar part has somewhere to run');
  }
  const keys = norm({ tile: false, deck: { handlers: [{ id: 'press', name: 'Press' }] } });
  assert.equal(keys.manifest.tile, false, 'Deck keys run without a tile too');
});

test('tile: false is ignored where the widget would run nowhere', () => {
  assert.equal(norm({ tile: false }).manifest.tile, true, 'no bar part: it stays a tile');
  assert.equal(norm({ tile: false }).manifest.background, false);
  assert.equal(norm({ tile: false, island: true }).manifest.tile, true, 'the plain island line needs a tile');
  assert.equal(norm({ tile: false, badge: true, surface: 'ambient' }).manifest.tile, true, 'a scene is not a tile anyway');
});

test('without the key nothing changes: a tile, and the bar only with background', () => {
  assert.equal(norm({}).manifest.tile, true);
  assert.equal(norm({ badge: true }).manifest.background, false);
  const both = norm({ badge: true, background: true });
  assert.deepEqual([both.manifest.tile, both.manifest.background], [true, true], 'page and bar');
  assert.equal(norm({ badge: true, tile: true }).manifest.tile, true);
  assert.equal(norm({ badge: true, tile: 'no' }).manifest.tile, true, 'only the literal false counts');
});

const CATALOG = { tiles: ['clock'], packages: [{ id: 'bat', name: 'Battery', tile: false }, { id: 'stars', name: 'Stars', tile: true }] };

test('a layer never puts a bar-only widget on the screen, and never offers it', async () => {
  let updated = 0;
  const d = { layers: { catalog: async () => CATALOG, update: async () => { updated += 1; return { ok: true }; } } };
  assert.deepEqual(await layers.place(d, { widget: 'bat' }), { ok: false, error: 'bar_only' });
  assert.deepEqual(await layers.place(d, { widget: 'Battery' }), { ok: false, error: 'bar_only' }, 'by its name too');
  assert.equal(updated, 0, 'nothing was written');
  const miss = await layers.place(d, { widget: 'nope' });
  assert.equal(miss.error, 'unknown_widget');
  assert.deepEqual(miss.choices.widgets, ['Stars']);
});

test('the menu Add row and the + panel leave it out', () => {
  const values = addChoices({ tiles: [], packages: CATALOG.packages }).map((c) => c.value);
  assert.deepEqual(values, ['stars']);
  const entries = PM.buildEntries({ builtins: [], packages: CATALOG.packages, table: [] });
  assert.deepEqual(entries.map((e) => e.id || (e.pkg && e.pkg.id)).filter(Boolean).filter((id) => id !== 'clock'), ['stars']);
});

test('a bar-only widget gets its service frame first within its rank', () => {
  const src = read('../js/custom-widget/custom-widget.js');
  const start = src.indexOf('  function planServiceFrames(');
  const plan = vm.runInNewContext('(' + src.slice(start, src.indexOf('\n  }\n', start) + 4).trim() + ')');
  const NO = { handlers: [], badge: false, mini: false, topbarButton: false, island: false, islandDynamic: false };
  const pkgs = [{ id: 'a', background: true, badge: true }, { id: 'b', background: true, badge: true }, { id: 'c', background: true, badge: true, tile: false }];
  const r = plan(pkgs, () => ({ ...NO, badge: true }), { max: 2, handlersOnly: false, suspended: () => false, leftPage: () => false, barShows: () => true });
  assert.deepEqual(Array.from(r.run, (p) => p.id), ['c', 'a'], 'it has no tile to fall back on');
  assert.deepEqual(Array.from(r.left), ['b']);
});

function tileBody() {
  const { document } = makeDom();
  const window = { CustomWidgetHostSays: { t: (_k, fb) => fb } };
  vm.runInNewContext(read('../js/custom-widget/tile-body.js'), { window, document });
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  return { document, api: window.CustomWidgetTileBody({ ICONS: { puzzle: '' }, el }) };
}

test('a tile left from before says where the widget went, and offers another', () => {
  const { document, api } = tileBody();
  const body = document.createElement('div');
  let chose = 0;
  api.showBarOnly(body, () => { chose += 1; });
  assert.match(body.querySelector('.cw-state-txt').textContent, /top bar/);
  assert.match(body.querySelector('.cw-state-hint').textContent, /remove this box/);
  body.querySelector('button').click();
  assert.equal(chose, 1);
  const layer = document.createElement('div');
  api.showBarOnly(layer, null);
  assert.equal(layer.querySelector('button'), null, 'a layer is changed from its editor, not from here');
});

test('Installed says it lives in the top bar', () => {
  /** @type {any} */
  const window = { InstalledManagerRefused: { t: (k, fb) => (k === 'settings_sdk_bar_only' ? 'BAR' : fb) } };
  vm.runInNewContext(read('../js/installed-manager/row-facts.js'), { window, console });
  const F = window.InstalledManagerRowFacts;
  assert.match(F.metaLine({ pkg: { id: 'bat', version: '1.0.0', tile: false } }), /BAR/);
  assert.doesNotMatch(F.metaLine({ pkg: { id: 'stars', version: '1.0.0', tile: true } }), /BAR/);
});

test('Bit hears when a tile: false is ignored, and not when it is honoured', () => {
  const deps = { normalizeSettings: loadServerSettingsSlice(), dashboardWidgets: serverDashboardWidgets(), sdkEnabled: true, appVersion: '9.9.9' };
  const page = { path: 'index.html', content: '<!doctype html><html><head><style>:root{color-scheme:dark}</style></head><body>x</body></html>' };
  const pkg = (m) => [{ path: 'manifest.json', content: JSON.stringify({ api: 1, name: 'Battery', ...m }) }, page];
  const flagged = (m) => (P.critiqueWidget('battery', pkg(m), deps).critique.findings || []).some((f) => /manifest\.tile/.test(f.where));
  assert.equal(flagged({ tile: false }), true);
  assert.equal(flagged({ tile: false, badge: true }), false);
  assert.equal(flagged({}), false);
});

function mcpDeps(installed) {
  return {
    sdkEnabled: () => true,
    validateWidgetPayload: (p) => sdk.validateWidgetPayload(p),
    critiqueWidget: () => null,
    scanWidgetSource: () => [],
    isInstalled: async () => false,
    isOwn: () => true,
    install: async (p) => ({ ok: true, id: p.id, name: 'Battery', ...installed }),
    place: async () => true,
  };
}
const files = (m) => [{ path: 'manifest.json', data: b64({ api: 1, name: 'Battery', ...m }) }, { path: 'index.html', data: b64('<!doctype html><p>x</p>') }];

test('the MCP check says where the widget lives, and why a tile: false is ignored', async () => {
  const at = async (m) => T.runOp('check_widget', { id: 'battery', files: files(m) }, mcpDeps({}));
  assert.equal((await at({ badge: true, tile: false })).livesIn, 'bar');
  assert.equal((await at({ badge: true, background: true })).livesIn, 'page and bar');
  assert.equal((await at({ badge: true })).livesIn, 'page');
  const ignored = await at({ tile: false });
  assert.equal(ignored.livesIn, 'page');
  assert.match(ignored.placeHint, /ignored/);
  assert.equal((await at({ badge: true, tile: false })).placeHint, undefined);
});

test('the MCP install tells the agent a bar-only widget is on no page', async () => {
  const bar = await T.runOp('install_widget', { id: 'battery', files: files({ badge: true, tile: false }) }, mcpDeps({ tile: false }));
  assert.match(bar.note, /top bar/);
  const tile = await T.runOp('install_widget', { id: 'battery', files: files({}) }, mcpDeps({ tile: true }));
  assert.match(tile.note, /on the dashboard/);
});

test('every place that adds a widget to a page checks it', () => {
  const cw = read('../js/custom-widget/custom-widget.js');
  for (const fn of ['function placePackage(', 'function assignToTile(', 'async function placeCreated(']) {
    const at = cw.indexOf(fn);
    assert.ok(at > 0, fn);
    assert.match(cw.slice(at, at + 1400), /tile === false|tile !== false/, fn);
  }
  for (const file of ['../js/grid/dashboard-palette.js', '../js/custom-widget/pick-list.js', '../js/ambient/ambient-canvas-editor.js', '../js/presets/preset-share.js', '../js/installed-manager/installed-manager.js']) {
    assert.match(read(file), /tile !== false/, file);
  }
  assert.match(engineSource(), /tile: p\.tile !== false/, 'the layer catalog carries it');
});

test('the + panel\'s Installed filter says a bar-only widget lives in the bar, not "none yet"', () => {
  const src = read('../js/grid/dashboard-palette.js');
  const at = src.indexOf("const barOnly = !safe");
  assert.ok(at > 0, 'the empty state looks for installed bar-only widgets');
  assert.match(src.slice(at, at + 400), /tile === false[\s\S]*palette_store_bar_only/);
});
