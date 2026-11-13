import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { appStringsSource } from './i18n-source.mjs';

const require = createRequire(import.meta.url);
const { PERF_HUD_PARTS, PERF_HUD_LABELS, PERF_HUD_SHORT, normalizePerfHud, applyPerfHudChange, statText } = require('../js/perf-hud.js');
const cap = require('../capabilities/perf-hud.js');
const { CAPABILITIES } = require('../js/capability-catalog.js');
const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');

const ALL_ON = {
  fps: true, low1: true, low01: true, frame: true, graph: true,
  cpu: true, cpuTemp: false, cpuClock: false, cpuPower: false,
  gpu: true, gpuTemp: true, gpuClock: false, gpuPower: false, vram: false,
  ram: false, ping: false, loss: false, layout: 'column',
};

test('a missing or broken setting shows the tile as it always was', () => {
  assert.deepEqual(normalizePerfHud(undefined), ALL_ON);
  assert.deepEqual(normalizePerfHud('junk'), ALL_ON);
  assert.deepEqual(normalizePerfHud({ graph: false, ping: 1, extra: false }), { ...ALL_ON, graph: false });
  assert.deepEqual(Object.keys(normalizePerfHud({})), [...PERF_HUD_PARTS, 'layout']);
});

test('the old single CPU and GPU switch still hides those three, until each is chosen', () => {
  assert.deepEqual(normalizePerfHud({ hw: false }), { ...ALL_ON, cpu: false, gpu: false, gpuTemp: false });
  assert.deepEqual(normalizePerfHud({ hw: false, gpu: true }), { ...ALL_ON, cpu: false, gpuTemp: false });
  assert.equal('hw' in normalizePerfHud({ hw: true }), false, 'the old key leaves the stored shape');
});

test('every reading has its words, and a machine without it gets a dash', () => {
  const sys = {
    cpu: 41.6, cpuTemp: 62, cpuClockMHz: 4800.4, gpu: 97, gpuTemp: 70, gpuClockMHz: 2700, vramUsed: 12.34 * 1024 ** 3, vramTotal: 16 * 1024 ** 3,
    memory: { used: 20 * 1024 ** 3, total: 64 * 1024 ** 3 }, power: { cpu: 88.2, gpu: 310 },
  };
  const words = (part, net) => statText(part, sys, net);
  assert.equal(words('cpu'), '42%');
  assert.equal(words('cpuTemp'), '62°C');
  assert.equal(words('cpuClock'), '4800 MHz');
  assert.equal(words('cpuPower'), '88 W');
  assert.equal(words('gpuPower'), '310 W');
  assert.equal(words('vram'), '12.3/16 GB');
  assert.equal(words('ram'), '20.0/64 GB');
  assert.equal(words('ping', { ping: 12.4 }), '12 ms');
  assert.equal(words('loss', { loss: 0 }), '0%');
  assert.equal(words('loss', { loss: 1.25 }), '1.3%');
  assert.equal(words('loss', { loss: 33.3 }), '33%');
  assert.equal(statText('gpuTemp', sys, null, (c) => c + ' deg'), '70 deg');
  for (const part of PERF_HUD_PARTS.filter((p) => !['fps', 'low1', 'low01', 'frame', 'graph'].includes(p))) {
    assert.equal(statText(part, null, null), '--', part);
    assert.equal(statText(part, { memory: { used: 'x' }, power: {} }, { ping: 'n/a' }), '--', part);
  }
  assert.equal(statText('nope', sys), '--');
});

test('every part is named in all the languages', () => {
  const i18n = appStringsSource();
  for (const part of PERF_HUD_PARTS) {
    const hits = i18n.match(new RegExp('\\b' + PERF_HUD_LABELS[part] + ':', 'g')) || [];
    assert.ok(hits.length >= 11, part + ': ' + hits.length);
  }
});

test('the tile writes short names, in all the languages', () => {
  const i18n = appStringsSource();
  assert.equal(PERF_HUD_SHORT.cpuTemp, 'perf_cpu');
  assert.equal(PERF_HUD_SHORT.gpuPower, 'perf_gpu');
  for (const part of PERF_HUD_PARTS) {
    const hits = i18n.match(new RegExp('\\b' + PERF_HUD_SHORT[part] + ':', 'g')) || [];
    assert.ok(hits.length >= 11, part + ': ' + hits.length);
  }
});

test('the readings sit in a column unless the person asks for a row', () => {
  assert.equal(normalizePerfHud({ layout: 'row' }).layout, 'row');
  assert.equal(normalizePerfHud({ layout: 'diagonal' }).layout, 'column');
  assert.equal(applyPerfHudChange({ layout: 'row' }, { layout: 'nope' }).layout, 'row');
  assert.equal(applyPerfHudChange({}, { layout: 'row' }).layout, 'row');
});

test('a change touches only known parts and only with booleans', () => {
  assert.deepEqual(applyPerfHudChange({ graph: false }, { ping: true, graph: 'yes', nope: false }), { ...ALL_ON, graph: false, ping: true });
  assert.deepEqual(applyPerfHudChange(null, null), ALL_ON);
});

test('Bit reads with no parameters and changes only what it names', async () => {
  let saved = { ...ALL_ON };
  const writes = [];
  const d = { perfHud: { get: () => saved, set: async (c) => { writes.push(c); saved = applyPerfHudChange(saved, c); return saved; } } };
  assert.deepEqual(await cap.run(d, {}), { ok: true, shown: ALL_ON });
  assert.equal(writes.length, 0);
  const r = await cap.run(d, { graph: 'hide', ping: 'keep', low1: 'maybe' });
  assert.deepEqual(writes, [{ graph: false }]);
  assert.deepEqual(r, { ok: true, shown: { ...ALL_ON, graph: false } });
  assert.deepEqual(await cap.run({}, { graph: 'show' }), { ok: false, error: 'unavailable' });
  writes.length = 0;
  await cap.run(d, { layout: 'row' });
  await cap.run(d, { layout: 'keep' });
  assert.deepEqual(writes, [{ layout: 'row' }], 'keep and anything else leave it alone');
});

test('the voice tool is declared, hidden from the Deck and offers show/hide for every part', () => {
  const c = CAPABILITIES.find(x => x.type === 'perfHud');
  assert.ok(c && c.hidden === true);
  assert.equal(c.capability.ai.name, 'set_perf_tile');
  assert.deepEqual(c.params.map(p => p.name), [...PERF_HUD_PARTS, 'layout']);
  for (const p of c.params.slice(0, -1)) assert.deepEqual(p.options, ['keep', 'show', 'hide']);
  assert.deepEqual(c.params.at(-1).options, ['keep', 'column', 'row']);
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
  assert.match(widget, /classList\.toggle\('is-off'/);
  const css = read('components/PerfWidget/PerfWidget.css');
  for (const [k, sel] of [['low1', '.perfw-stat.is-low1'], ['low01', '.perfw-stat.is-low01'], ['frame', '.perfw-stat.is-frame'], ['graph', '.perfw-graph'], ['fps', '.perfw-fps'], ['hw', '.perfw-hw']]) {
    assert.ok(css.includes(`.perfw-wrap.hud-no-${k} ${sel}`), k);
  }
  const { js } = require('../js/layer-tiles.js').TILES.perf;
  assert.ok(js.indexOf('js/perf-hud.js') >= 0 && js.indexOf('js/perf-hud.js') < js.indexOf('js/perf-widget.js'));
});
