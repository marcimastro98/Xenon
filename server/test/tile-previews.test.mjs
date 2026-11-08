import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { PREVIEW_TILES, previewPath } = require('../tile-previews.js');
const { addChoices } = require('../xenon-menu.js');
const { TILES } = require('../js/layer-tiles.js');
const strings = require('../layer-strings.js');
const { pickTiles, batches, pageGroups, shotLayout } = await import('../../tools/tile-previews/shoot.mjs');
const { FIXTURE_TILES, fixtureFor, fixtureScript } = await import('../../tools/tile-previews/fixtures.mjs');
const { socketScript } = await import('../../tools/tile-previews/fixture-sockets.mjs');
const { landscape, yard } = await import('../../tools/tile-previews/art.mjs');

const CATALOG = Object.keys(TILES).filter((id) => !['custom', 'secondscreen', 'screen'].includes(id));
const MAX_BYTES = 40 * 1024;

test('every listed tile has its picture, small enough for a long list', () => {
  for (const id of PREVIEW_TILES) {
    const file = path.join(SERVER, previewPath(id));
    assert.ok(existsSync(file), id);
    assert.ok(statSync(file).size < MAX_BYTES, id);
  }
});

test('every native tile of the catalog has a picture, never just its icon', () => {
  assert.deepEqual(CATALOG.filter((id) => !PREVIEW_TILES.includes(id)), []);
});

test('a tile with no picture worth showing has none', () => {
  assert.equal(previewPath('secondscreen'), null);
  assert.equal(previewPath('../secret'), null);
});

test('the Add list says what each tile is, with a picture where there is one', () => {
  const [weather, custom] = addChoices({ tiles: ['weather', 'custom'], packages: [] });
  assert.deepEqual(weather.sub, { key: 'layout_widget_weather_desc' });
  assert.equal(weather.picture, 'assets/tile-previews/weather.webp');
  assert.equal(weather.tile, 'weather');
  assert.equal(custom.picture, undefined);
});

test('a Store widget brings its own description as plain text', () => {
  const [clock, bare] = addChoices({ tiles: [], packages: [{ id: 'p1', name: 'Clock', description: '<b>A clock</b>' }, { id: 'p2', name: 'Bare' }] });
  assert.deepEqual(clock.sub, { text: '<b>A clock</b>' });
  assert.equal(clock.tile, undefined);
  assert.equal(bare.sub, undefined);
});

test('every tile of the catalog has its line in all 11 languages', async () => {
  for (const lang of ['en', 'it', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl']) {
    for (const id of CATALOG) {
      const key = `layout_widget_${id}_desc`;
      const line = await strings.text(key, lang);
      assert.ok(line && line !== key, `${lang} ${id}`);
      assert.ok(!line.includes('—'), `${lang} ${id}`);
    }
  }
});

test('the menu page has the tile icons before the list that draws them', () => {
  const html = readFileSync(path.join(SERVER, 'menu.html'), 'utf8');
  const palette = html.indexOf('<script src="js/dashboard-palette.js">');
  assert.ok(palette > 0 && palette < html.indexOf('<script src="js/xenon-menu.js">'));
});

test('the tool shoots what it is asked, in groups', () => {
  assert.deepEqual(pickTiles(['weather', '--out', 'x']), ['weather']);
  assert.deepEqual(pickTiles([]), [...PREVIEW_TILES]);
  assert.throws(() => pickTiles(['nope']), /unknown tile/);
  assert.deepEqual(batches([1, 2, 3], 2), [[1, 2], [3]]);
});

test('a tile with a fixture gets a page of its own, the others share one', () => {
  assert.deepEqual(pageGroups(['weather', 'spotify', 'news', 'obs']), [['weather', 'news'], ['spotify'], ['obs']]);
});

test('every fixture is for a listed tile, plain data, and invented text without em-dashes', () => {
  for (const id of FIXTURE_TILES) {
    assert.ok(PREVIEW_TILES.includes(id), id);
    const text = JSON.stringify(fixtureFor(id, 1_800_000_000_000));
    assert.ok(text && !text.includes('\u2014'), id);
  }
  assert.equal(fixtureFor('nope'), null);
  assert.equal(fixtureFor('toString'), null);
});

test('a fixture is the same for the same moment, so a re-shoot changes nothing by itself', () => {
  const now = 1_800_000_000_000;
  for (const id of FIXTURE_TILES) assert.deepEqual(fixtureFor(id, now), fixtureFor(id, now), id);
  assert.equal(landscape({ seed: 4 }), landscape({ seed: 4 }));
  assert.notEqual(yard({ seed: 4 }), yard({ seed: 4, mirror: true }));
});

test('a fixture lands on the page feeds as a script that parses', () => {
  const shot = { answers: {}, events: {}, settings: {} };
  const window = { __SHOT__: shot };
  vm.runInNewContext(fixtureScript({ answers: { '/a': 1 }, events: { b: 2 }, settings: { c: 3 } }), { window });
  assert.deepEqual(JSON.parse(JSON.stringify(shot)), { answers: { '/a': 1 }, events: { b: 2 }, settings: { c: 3 } });
  for (const id of FIXTURE_TILES) assert.doesNotThrow(() => new vm.Script(fixtureScript(fixtureFor(id))), id);
});

test('a fixture hides its cards without touching the rest of the layout', () => {
  const plain = shotLayout(['obs'], null);
  const hidden = { order: 4, size: 'normal', visible: false };
  const fed = shotLayout(['obs'], { cards: { obs: { audio: hidden } } });
  assert.deepEqual(fed.cards.obs.audio, hidden);
  assert.deepEqual(fed.cards.net, plain.cards.net);
  assert.deepEqual(fed.widgets, plain.widgets);
});

// The page's clock and socket, by hand: timers run when the test says so.
function socketPage(fixture) {
  const timers = [];
  const window = {};
  vm.runInNewContext(socketScript(fixture), { window, setTimeout: (fn) => timers.push(fn), Object, JSON, String });
  window.WebSocket = class DemoSocket { constructor(url) { this.url = url; } };
  return { window, flush: () => timers.splice(0).forEach((fn) => fn()) };
}

test('the socket hook feeds the host it names and leaves the demo socket to the rest', () => {
  const { window, flush } = socketPage({ sockets: { 'irc.example': 'hello' } });
  const irc = new window.WebSocket('wss://irc.example');
  const other = new window.WebSocket('wss://other.example');
  const got = [];
  irc.onmessage = (e) => got.push(e.data);
  other.onmessage = (e) => got.push(e.data);
  flush();
  assert.deepEqual(got, ['hello']);
  assert.equal(irc.url, 'wss://irc.example');
});

test('the embedded browser relay opens like the real one', () => {
  const { window, flush } = socketPage({ relay: { url: 'https://site.example/', image: 'data:,' } });
  const relay = new window.WebSocket('ws://127.0.0.1/embedded-browser/ws');
  let opened = false;
  relay.addEventListener('open', () => { opened = true; });
  assert.equal(relay.readyState, 0);
  flush();
  assert.equal(relay.readyState, 1);
  assert.ok(opened);
});

test('a fixture with no socket adds no hook', () => {
  assert.equal(socketScript({}), '');
});
