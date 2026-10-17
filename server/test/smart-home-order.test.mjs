// Smart Home tile: room order, device order inside a room, and the Show option
// (js/smart-home-order.js, shared by the browser and normalizeHomeAssistant).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const O = require('../js/smart-home-order.js');
const ha = require('../actions/home-assistant.js');

test('areaOrder: strings only, trimmed, de-duplicated, capped; never the no-area bucket', () => {
  assert.deepEqual(O.normalizeAreaOrder(null), []);
  assert.deepEqual(O.normalizeAreaOrder('Kitchen'), []);
  assert.deepEqual(O.normalizeAreaOrder([' Kitchen ', 'Kitchen', '', 7, null, '~', 'Office']), ['Kitchen', 'Office']);
  assert.equal(O.normalizeAreaOrder(['x'.repeat(500)])[0].length, 80);
  assert.equal(O.normalizeAreaOrder(Array.from({ length: 100 }, (_, i) => 'Room ' + i)).length, 64);
});

test('tileView: auto, open or compact, anything else is auto', () => {
  for (const v of ['auto', 'open', 'compact']) assert.equal(O.normalizeTileView(v), v);
  for (const v of [undefined, '', 'OPEN', 'expanded', 3]) assert.equal(O.normalizeTileView(v), 'auto');
});

test('rooms follow the saved order, unnamed rooms keep their place after it, no area is last', () => {
  const seen = ['~', 'Bedroom', 'Kitchen', 'Office', 'Garage'];
  assert.deepEqual(O.sortAreas(seen, []), ['Bedroom', 'Kitchen', 'Office', 'Garage', '~']);
  assert.deepEqual(O.sortAreas(seen, ['Office', 'Kitchen']), ['Office', 'Kitchen', 'Bedroom', 'Garage', '~']);
  assert.deepEqual(O.sortAreas(seen, ['Attic', 'Garage']), ['Garage', 'Bedroom', 'Kitchen', 'Office', '~'], 'a saved room not shown now is ignored');
});

test('moving a room swaps it with its neighbour and remembers rooms not shown now', () => {
  const shown = ['Bedroom', 'Kitchen', 'Office', '~'];
  assert.deepEqual(O.moveArea([], shown, 'Office', -1), ['Bedroom', 'Office', 'Kitchen']);
  assert.deepEqual(O.moveArea(['Attic', 'Kitchen'], shown, 'Kitchen', 1), ['Bedroom', 'Kitchen', 'Office', 'Attic']);
  assert.deepEqual(O.moveArea(['Kitchen'], shown, 'Kitchen', -1), ['Kitchen'], 'the first room cannot go higher');
  assert.deepEqual(O.moveArea([], shown, '~', -1), [], 'no area always stays last');
});

test('moving a device moves all its entities together, inside its room only', () => {
  const area = { 'sensor.co2': 'Office', 'sensor.temp': 'Office', 'light.desk': 'Office', 'light.bed': 'Bedroom', 'switch.pc': 'Office' };
  const dev = { 'sensor.co2': 'netatmo', 'sensor.temp': 'netatmo' };
  const keyOf = (id) => dev[id] || id;
  const areaOf = (id) => area[id];
  const ids = ['sensor.co2', 'light.bed', 'sensor.temp', 'light.desk', 'switch.pc'];
  assert.deepEqual(O.moveUnit(ids, 'light.desk', -1, keyOf, areaOf), ['light.desk', 'light.bed', 'sensor.co2', 'sensor.temp', 'switch.pc'],
    'the desk lamp goes above the Netatmo; the bedroom keeps its slot');
  assert.deepEqual(O.moveUnit(ids, 'sensor.temp', 1, keyOf, areaOf), ['light.desk', 'light.bed', 'sensor.co2', 'sensor.temp', 'switch.pc']);
  assert.deepEqual(O.moveUnit(ids, 'switch.pc', 1, keyOf, areaOf), ids, 'the last device cannot go lower');
  assert.deepEqual(O.moveUnit(ids, 'light.bed', -1, keyOf, areaOf), ids, 'alone in its room');
});

test('the server keeps the order and the view, and sends them back with the token redacted', () => {
  const n = ha.normalizeHomeAssistant({ url: 'http://ha:8123', token: 't', areaOrder: ['Office', 'Office', 9], tileView: 'open' });
  assert.deepEqual(n.areaOrder, ['Office']);
  assert.equal(n.tileView, 'open');
  assert.equal(ha.normalizeHomeAssistant({}).tileView, 'auto');
  assert.deepEqual(ha.normalizeHomeAssistant({}).areaOrder, []);
  const r = ha.redactHaToken({ homeAssistant: n });
  assert.deepEqual([r.homeAssistant.areaOrder, r.homeAssistant.tileView, r.homeAssistant.token], [['Office'], 'open', '']);
});

test('wiring: loaded before settings.js, normalized on the client, sent in the snapshot', () => {
  const html = read('server/index.html');
  const at = (src) => html.indexOf('<script src="' + src + '"></script>');
  assert.ok(at('js/smart-home-order.js') > 0 && at('js/smart-home-order.js') < at('js/settings.js'));
  const settings = read('server/js/settings.js');
  assert.match(settings, /areaOrder: order \? order\.normalizeAreaOrder\(src\.areaOrder\) : \[\]/);
  assert.match(settings, /tileView: order \? order\.normalizeTileView\(src\.tileView\) : 'auto'/);
  const server = read('server/server.js');
  const build = server.slice(server.indexOf('async function buildHaState'), server.indexOf('async function buildHaState') + 900);
  assert.match(build, /areaOrder: Array\.isArray\(ha\.areaOrder\)/);
  assert.match(build, /tileView: typeof ha\.tileView === 'string'/);
});
