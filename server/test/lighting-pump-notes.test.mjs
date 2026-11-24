// Settings → Lighting says when the pump screen holds the pump's ring of lights (status.pumpRing,
// lights/pump-ring.js state): the card of the device with the pump says so with the way to the
// pump's Lights tab, the ring's part on its map is shown as held and cannot be painted for
// nothing, and while the pump screen leads every light Effects and Reactions say it on top.
// The real page files run on the small DOM; nothing is posted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { readFileSync } from './browser-source.mjs';
import { makeDom } from './mini-dom.mjs';

const require = createRequire(import.meta.url);
const pumpRing = require('../lights/pump-ring.js');
const held = require('../lighting-native/held.js');
const FILES = ['lighting/lighting-ui.js', 'lighting-map/geometry.js', 'lighting-map/lighting-map.js', 'lighting/lighting-device.js', 'lighting-page/panels.js'];
const SRC = FILES.map((f) => readFileSync(new URL('../js/' + f, import.meta.url), 'utf8'));

function rig({ menu = true } = {}) {
  const { document } = makeDom();
  const opened = [];
  const wanted = [];
  const window = {
    XenonMenuPanel: menu ? { open: (s) => opened.push(s) } : undefined,
    XenonMenuScreens: { want: (tab) => wanted.push(tab) },
  };
  const ctx = vm.createContext({ window, document, console, t: (k) => k, fetch: async () => { throw new Error('no posts in this test'); } });
  for (const src of SRC) vm.runInContext(src, ctx);
  return { document, window, opened, wanted };
}

// A cooler as iCUE reports it: the pump head's LEDs and a fan beside them.
const COOLER = {
  id: 'pretend-pump', model: 'Pretend Pump', source: 'icue', mode: 'follow',
  segments: [{ kind: 'pump', ledIds: [1, 2, 3] }, { kind: 'fan', ledIds: [4, 5] }],
};
const KEYS = { id: 'pretend-keys', model: 'Pretend Keys', source: 'icue', mode: 'follow', segments: [{ kind: 'strip', ledIds: [9, 10] }] };
// The server names the devices that carry the ring (lights/status.js), the page only reads them.
const status = (ring) => ({ enabled: true, effects: {}, devices: [COOLER, KEYS], pumpRing: { ...ring, devices: [COOLER.id] } });
const note = (root, key) => root.querySelectorAll('[data-i18n="' + key + '"]');

test('the pump ring is said as held only while a pump screen paints it', () => {
  assert.deepEqual({ ...pumpRing.state() }, { owns: false, all: false, follow: 'lights' }, 'nothing set: the ring is the other lights\'');
  pumpRing.set({ follow: 'screen', all: true, colours: ['#ff0000'] });
  try {
    assert.deepEqual({ ...pumpRing.state() }, { owns: true, all: true, follow: 'screen' });
  } finally { pumpRing.set(null); }
  assert.equal(pumpRing.state().owns, false);
  const src = readFileSync(new URL('../lights/status.js', import.meta.url), 'utf8');
  assert.match(src, /pumpRing: \{ \.\.\.pumpRing\.state\(\), devices: devices\.filter\(d => pumpRing\.ledsOf\(d\)\)/, 'the Lighting page reads it from /api/lighting/status');
});

test('the ring is on an iCUE pump or a LINK hub Airflow holds, never on a board header named pump', () => {
  const ring = (dev) => Object.keys(pumpRing.ledsOf(dev) || {}).map(Number);
  assert.deepEqual(ring(COOLER), [1, 2, 3], 'iCUE: the pump part only');
  assert.deepEqual(ring(KEYS), []);
  const hub = { id: 'pretend-hub', source: 'native', segments: [{ kind: 'pump', ledIds: [7, 8] }, { kind: 'fan', ledIds: [9] }] };
  assert.deepEqual(ring(hub), [], "a controller nothing holds: a part named pump is no screen's ring");
  const remove = held.addSource({ devices: () => [hub], owns: (id) => id === hub.id, write: () => false, off: async () => {} });
  try {
    assert.deepEqual(ring(hub), [7, 8], 'held by Airflow: its pump part');
  } finally { remove(); }
  assert.deepEqual(ring(hub), [], 'let go: no ring again');
});

// Seen on a LINK pump: the clock hands ran over the pump's 24 LEDs and the screen's 16 as one
// strip of 40, so the pump itself stayed dark. Each ring now goes round on its own.
test('a pump with the screen on its cap: each ring plays the effect on its own, from the same place', () => {
  const { ledFrame } = require('../lights/lighting-led-colors.js');
  const pump = { id: 'pretend-hub', source: 'native', segments: [{ kind: 'pump', ledIds: [1, 2, 3, 4, 5, 6], rings: [4, 2] }, { kind: 'fan', ledIds: [9] }] };
  const remove = held.addSource({ devices: () => [pump], owns: (id) => id === pump.id, write: () => false, off: async () => {} });
  try {
    const leds = pumpRing.ledsOf(pump);
    const asked = [];
    const stops = (count) => { asked.push(count); return Array.from({ length: count }, (_, i) => ({ r: i * 10, g: count, b: 0 })); };
    const out = ledFrame([1, 2, 3, 4, 5, 6, 9], leds, { follow: null, pump: stops, brightness: 1, nowMs: 0 });
    assert.deepEqual(asked, [4, 2], 'one frame per ring, each its own size');
    assert.deepEqual(out.map((c) => c && [c.r, c.g]), [[0, 4], [10, 4], [20, 4], [30, 4], [0, 2], [10, 2], null], 'each ring starts at its own first LED; the fan is left alone');
    const odd = { ...pump, segments: [{ kind: 'pump', ledIds: [1, 2, 3], rings: [2, 2] }] };
    assert.deepEqual(new Set(Object.values(pumpRing.ledsOf(odd))).size, 1, 'sizes that do not add up: one ring, as before');
  } finally { remove(); }
});

test('the device with the pump says the pump screen decides, with the way to its Lights tab', () => {
  const r = rig();
  const held = r.window.LightingDevice.card(() => {}, status({ owns: true, all: false, follow: 'screen' }), COOLER, 'iCUE');
  const [line] = note(held, 'lighting_pump_holds');
  assert.ok(line, 'the note on the card');
  const go = note(held, 'lighting_pump_open')[0];
  assert.equal(go.tagName, 'BUTTON');
  go.click();
  assert.deepEqual([r.wanted, r.opened], [['leds'], ['screens']], 'the menu opens on the pump card at Lights');
  // The ring's part on the map: drawn held, named so, its LEDs not to be picked; the fan as before.
  const part = held.querySelector('.lighting-part.is-held');
  assert.ok(part, 'the pump part is held');
  assert.ok(note(part, 'lighting_pump_part_held').length);
  assert.equal(part.querySelectorAll('.lighting-led-held').length, 3);
  assert.equal(held.querySelectorAll('.lighting-part.is-held').length, 1, 'only the pump part');
  // LEDs picked before the pump screen took the ring are let go: a paint never reaches them.
  const fresh = rig();
  const picked = fresh.window.LightingDevice.card(() => {}, status({ owns: false, all: false, follow: 'lights' }), COOLER, 'iCUE');
  picked.querySelectorAll('.lighting-part-name')[0].click();
  assert.ok(picked.querySelector('.lighting-led.is-selected'), 'the pump part picked while it was free');
  const later = fresh.window.LightingDevice.card(() => {}, status({ owns: true, all: false, follow: 'screen' }), COOLER, 'iCUE');
  later.querySelectorAll('.lighting-part-name')[1].click();
  assert.deepEqual(later.querySelectorAll('.lighting-led.is-selected').map((c) => c.dataset.luid), ['4', '5'], 'only the fan is chosen now');
  assert.equal(later.querySelector('.lighting-sel-head span').textContent, '2 LED scelti', 'a paint reaches the fan alone');
  // No pump screen painting it, another device, or a board Xenon drives itself: nothing said.
  assert.equal(note(r.window.LightingDevice.card(() => {}, status({ owns: false, all: false, follow: 'lights' }), COOLER, 'iCUE'), 'lighting_pump_holds').length, 0);
  assert.equal(note(r.window.LightingDevice.card(() => {}, status({ owns: true, all: false, follow: 'screen' }), KEYS, 'iCUE'), 'lighting_pump_holds').length, 0);
  // A device the server does not name as carrying the ring says nothing, whatever its parts are called.
  const unnamed = { enabled: true, effects: {}, devices: [COOLER], pumpRing: { owns: true, all: false, follow: 'screen', devices: [] } };
  assert.equal(note(r.window.LightingDevice.card(() => {}, unnamed, COOLER, 'iCUE'), 'lighting_pump_holds').length, 0);
  const free = r.window.LightingDevice.card(() => {}, status({ owns: false, all: false, follow: 'lights' }), COOLER, 'iCUE');
  assert.equal(free.querySelector('.lighting-part.is-held'), null);
  assert.equal(free.querySelectorAll('.lighting-led-held').length, 0);
  // Where there is no menu to open (a phone page without it), the words alone.
  const bare = rig({ menu: false }).window.LightingDevice.card(() => {}, status({ owns: true, all: false, follow: 'screen' }), COOLER, 'iCUE');
  assert.ok(note(bare, 'lighting_pump_holds').length);
  assert.equal(note(bare, 'lighting_pump_open').length, 0);
});

test('Effects and Reactions say on top when the pump screen leads every light, with the way to change it', () => {
  const r = rig();
  const P = r.window.LightingPagePanels;
  const leads = status({ owns: true, all: true, follow: 'screen' });
  const fx = P.effectsPanel(() => {}, leads);
  assert.equal(note(fx, 'lighting_pump_all').length, 1);
  assert.equal(fx.children[0].querySelector('[data-i18n="lighting_pump_all"]') != null, true, 'first in the tab');
  note(fx, 'lighting_pump_change')[0].click();
  assert.deepEqual(r.opened, ['screens']);
  const react = P.reactionsPanel(() => {}, leads);
  assert.equal(note(react, 'lighting_pump_all_reactions').length, 1);
  // Only the ring: the other lights keep what these tabs set, nothing said.
  const ringOnly = status({ owns: true, all: false, follow: 'screen' });
  assert.equal(note(P.effectsPanel(() => {}, ringOnly), 'lighting_pump_all').length, 0);
  assert.equal(note(P.reactionsPanel(() => {}, ringOnly), 'lighting_pump_all_reactions').length, 0);
});
