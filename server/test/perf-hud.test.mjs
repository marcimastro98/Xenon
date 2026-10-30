import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { PERF_HUD_PARTS, normalizePerfHud, applyPerfHudChange } = require('../js/perf-hud.js');
const cap = require('../capabilities/perf-hud.js');
const { CAPABILITIES } = require('../js/capability-catalog.js');
const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');

const ALL_ON = { low1: true, low01: true, frame: true, graph: true, hw: true };

test('a missing or broken setting shows the tile as it always was', () => {
  assert.deepEqual(normalizePerfHud(undefined), ALL_ON);
  assert.deepEqual(normalizePerfHud('junk'), ALL_ON);
  assert.deepEqual(normalizePerfHud({ graph: false, hw: 0, extra: false }), { ...ALL_ON, graph: false });
  assert.deepEqual(Object.keys(normalizePerfHud({})), PERF_HUD_PARTS);
});

test('a change touches only known parts and only with booleans', () => {
  assert.deepEqual(applyPerfHudChange({ graph: false }, { hw: false, graph: 'yes', nope: false }), { ...ALL_ON, graph: false, hw: false });
  assert.deepEqual(applyPerfHudChange(null, null), ALL_ON);
});

test('Bit reads with no parameters and changes only what it names', async () => {
  let saved = { ...ALL_ON };
  const writes = [];
  const d = { perfHud: { get: () => saved, set: async (c) => { writes.push(c); saved = applyPerfHudChange(saved, c); return saved; } } };
  assert.deepEqual(await cap.run(d, {}), { ok: true, shown: ALL_ON });
  assert.equal(writes.length, 0);
  const r = await cap.run(d, { graph: 'hide', hw: 'keep', low1: 'maybe' });
  assert.deepEqual(writes, [{ graph: false }]);
  assert.deepEqual(r, { ok: true, shown: { ...ALL_ON, graph: false } });
  assert.deepEqual(await cap.run({}, { graph: 'show' }), { ok: false, error: 'unavailable' });
});

test('the voice tool is declared, hidden from the Deck and offers show/hide for every part', () => {
  const c = CAPABILITIES.find(x => x.type === 'perfHud');
  assert.ok(c && c.hidden === true);
  assert.equal(c.capability.ai.name, 'set_perf_tile');
  assert.deepEqual(c.params.map(p => p.name), PERF_HUD_PARTS);
  for (const p of c.params) assert.deepEqual(p.options, ['keep', 'show', 'hide']);
  assert.match(read('capabilities/index.js'), /case 'perfHud': return perfHud\.run\(d, action\);/);
});

test('server and client store the same shape, the server writes under the settings lock', () => {
  const server = read('server.js');
  assert.match(server, /perfHud: PerfHud\.normalizePerfHud\(source\.perfHud\)/);
  const writer = server.slice(server.indexOf('async function updatePerfHudSetting'), server.indexOf('async function updatePerfHudSetting') + 600);
  assert.match(writer, /withHubSettingsLock/);
  assert.match(writer, /nextSettingsRev/);
  const settings = read('js/settings.js');
  assert.match(settings, /perfHud: window\.PerfHud \? window\.PerfHud\.normalizePerfHud\(value\.perfHud\)/);
  const html = read('index.html');
  assert.ok(html.indexOf('<script src="js/perf-hud.js">') > 0 && html.indexOf('<script src="js/perf-hud.js">') < html.indexOf('<script src="js/settings.js">'), 'perf-hud.js loads before settings.js');
  for (const k of PERF_HUD_PARTS) assert.match(html, new RegExp(`id="settings-perfhud-${k}"`));
});

test('the tile hides a part with a class, on the dashboard and on a layer page', () => {
  const widget = read('js/perf-widget.js');
  assert.match(widget, /classList\.toggle\('hud-no-' \+ k/);
  const css = read('components/PerfWidget/PerfWidget.css');
  for (const [k, sel] of [['low1', '.perfw-stat.is-low1'], ['low01', '.perfw-stat.is-low01'], ['frame', '.perfw-stat.is-frame'], ['graph', '.perfw-graph'], ['hw', '.perfw-hw']]) {
    assert.ok(css.includes(`.perfw-wrap.hud-no-${k} ${sel}`), k);
  }
  const { js } = require('../js/layer-tiles.js').TILES.perf;
  assert.ok(js.indexOf('js/perf-hud.js') >= 0 && js.indexOf('js/perf-hud.js') < js.indexOf('js/perf-widget.js'));
});
