// server/layer-page.js: the light layer page carries the built-in tiles placed
// on its surface that it can (js/layer-tiles.js), with only their files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const LayerPage = require('../layer-page.js');
const LayersModel = require('../js/layers-model.js');
const LayerTiles = require('../js/layer-tiles.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const HTML = read('../layer-lite.html');
const DASHBOARD = read('../index.html');

test('every tile the model lets the light page carry has its files in the table, and they exist', () => {
  assert.deepEqual([...LayersModel.LITE_TILES], [...LayerTiles.LITE]);
  for (const name of LayerTiles.LITE) {
    const { css = [], js = [] } = LayerTiles.lite(name);
    for (const f of [...css, ...js]) assert.ok(existsSync(new URL('../' + f, import.meta.url)), f);
  }
});

test('the weather tile brings its styles before the themes and its script before the page code', () => {
  const page = LayerPage.compose(HTML, ['weather'], DASHBOARD);
  assert.match(page, /<html lang="en" data-layer-lite data-layer-tiles="weather">/);
  // A tap on the tile opens its details: that sheet comes along, and without it no tile.
  assert.match(page, /id="weather-overlay"/);
  assert.match(LayerPage.compose(HTML, ['weather']), /data-layer-tiles=""/);
  const css = page.indexOf('href="components/WeatherModal/WeatherModal.css"');
  assert.ok(css > 0 && css < page.indexOf('href="styles/themes-light.css"'), 'themes still win');
  const js = page.indexOf('src="js/system.js"');
  assert.ok(js > page.indexOf('src="js/custom-widget.js"') && js < page.indexOf('src="js/layer-host.js"'));
  assert.doesNotMatch(page, /<!-- tile (styles|scripts) -->/);
});

test('no tiles: the plain page; a name without files is left out, so the page reloads into the dashboard', () => {
  const plain = LayerPage.compose(HTML, []);
  assert.match(plain, /data-layer-tiles=""/);
  assert.doesNotMatch(plain, /system\.js|WeatherModal/);
  const odd = LayerPage.compose(HTML, ['../x', 'constructor', 'toString']);
  assert.match(odd, /data-layer-tiles=""/);
  assert.doesNotMatch(odd, /system\.js/);
  // The System tile's markup comes from index.html: without it, no half tile.
  const blind = LayerPage.compose(HTML, ['system'], '<body></body>');
  assert.match(blind, /data-layer-tiles=""/);
  assert.doesNotMatch(blind, /network\.js|SystemPanel/);
});

test("the System tile is cut whole from the dashboard's own markup", () => {
  const el = LayerPage.sliceTile(DASHBOARD, 'system');
  assert.match(el, /^<aside class="panel side-panel dashboard-widget" data-dashboard-widget="system"/);
  assert.ok(el.endsWith('</aside>'));
  assert.equal(el.split('<aside').length, 2, 'one tile, not the next one too');
  assert.match(el, /id="sys-grid-main"/);
  assert.equal(LayerPage.sliceTile(DASHBOARD, 'no-such-tile'), '');
  assert.equal(LayerPage.sliceTile('<aside data-dashboard-widget="system"><div>', 'system'), '', 'unbalanced: nothing');
  // A copy (data-dashboard-instance) is never taken for the primary tile.
  const copyFirst = '<div data-dashboard-widget="system" data-dashboard-instance="system-2">c</div><div data-dashboard-widget="system"><div>p</div></div>';
  assert.equal(LayerPage.sliceTile(copyFirst, 'system'), '<div data-dashboard-widget="system"><div>p</div></div>');
});

test('System and weather together: markup in the body, each file once, index.html read only when needed', () => {
  const page = LayerPage.compose(HTML, ['system', 'weather'], DASHBOARD);
  assert.match(page, /data-layer-tiles="system weather"/);
  // Its tabs come along: the Microphone tile's content and the device picker.
  assert.match(page, /data-dashboard-widget="mic"/);
  assert.match(page, /id="picker-overlay"/);
  const noPicker = DASHBOARD.replace('id="picker-overlay"', 'id="gone"');
  assert.match(LayerPage.compose(HTML, ['system'], noPicker), /data-layer-tiles=""/, 'any piece missing: no half tile');
  const body = page.indexOf('<body');
  const tile = page.indexOf('data-dashboard-widget="system"');
  assert.ok(tile > body && tile < page.indexOf('src="shared/src/constants.js"'), 'the tile sits before the scripts');
  assert.equal(page.split('src="js/system.js"').length, 2, 'system.js once');
  assert.equal(page.split('src="js/network.js"').length, 2);
  assert.equal(page.split('SystemPanel/SystemPanel.css').length, 2);
  assert.ok(page.indexOf('src="js/network.js"') < page.indexOf('src="js/layer-lite-tiles.js"'));
  assert.doesNotMatch(page, /<!-- tile (styles|markup|scripts) -->/);
  assert.equal(LayerPage.needsDashboardHtml(['weather']), true);
  assert.equal(LayerPage.needsDashboardHtml(['system', 'weather']), true);
  assert.equal(LayerPage.needsDashboardHtml(null), false);
});

test('the page has each mark once, and the route composes it for the surface it serves', () => {
  assert.equal(HTML.split('<!-- tile styles -->').length, 2);
  assert.equal(HTML.split('<!-- tile scripts -->').length, 2);
  assert.equal(HTML.split('<!-- tile markup -->').length, 2);
  assert.equal(HTML.split('<html lang="en" data-layer-lite>').length, 2);
  const s = read('../server.js');
  assert.match(s, /const tiles = LayersModel\.liteTilesFor\(_serverHubSettings\.layers, layerKey\);/);
  assert.match(s, /res\.end\(LayerPage\.compose\(lite, tiles, dashboard\)\);/);
});

test('the Media tile comes cut from the dashboard, with its lyrics and waveform but not the topbar', () => {
  const page = LayerPage.compose(HTML, ['media'], DASHBOARD);
  assert.match(page, /data-layer-tiles="media"/);
  assert.match(page, /<section class="panel media-panel dashboard-widget" id="media-panel" data-dashboard-widget="media"/);
  assert.doesNotMatch(page, /data-dashboard-widget="chat"/, 'the chat is a tile of its own');
  for (const src of ['js/media.js', 'js/media-lyrics.js', 'js/media-viz.js', 'js/album-theme.js']) assert.ok(page.includes(`src="${src}"`), src);
  assert.doesNotMatch(page, /topbar-media|lyrics-stage|lyrics-translation|calendar\.js/);
  // Each module before the code that drives it.
  assert.ok(page.indexOf('src="js/lyrics-core.js"') < page.indexOf('src="js/media-lyrics.js"'));
  assert.ok(page.indexOf('src="js/media-viz.js"') < page.indexOf('src="js/layer-lite-tiles.js"'));
});

test('the Game performance tile comes cut from the dashboard, sharing system.js with the System tile', () => {
  const page = LayerPage.compose(HTML, ['perf', 'system'], DASHBOARD);
  assert.match(page, /data-layer-tiles="perf system"|data-layer-tiles="system perf"/);
  assert.match(page, /<section class="panel perf-panel dashboard-widget" data-dashboard-widget="perf"/);
  assert.match(page, /<div class="perf-widget-mount"><\/div>/);
  assert.equal(page.split('src="js/system.js"').length, 2, 'system.js once');
  assert.ok(page.includes('href="components/PerfWidget/PerfWidget.css"'));
  assert.ok(page.indexOf('src="js/system.js"') < page.indexOf('src="js/perf-widget.js"'), 'units before the tile');
  assert.ok(page.indexOf('src="js/perf-widget.js"') < page.indexOf('src="js/layer-lite-tiles.js"'));
});
