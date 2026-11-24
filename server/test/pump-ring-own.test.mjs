// The ring of lights around a pump in colours of the person's own (leds.follow 'own',
// leds.colors), lit up to the reading (move 'level'), and moving as the screen's style draws
// (move 'style', the default): the model and a change check them (js/pump/pump-model.js,
// pump-screen/edit.js), the face page says how far its line is (js/pump/face-colors.js), the
// pump side hands it on (pump-screen/ring.js), the lights fill the ring LED by LED
// (lights/pump-ring.js, lighting-led-colors.js), and the menu offers it (menu/menu-pump-look.js).
// The ring painted through a pretend iCUE is in lighting-pump-ring.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { readFileSync } from './browser-source.mjs';
import { makeDom } from './mini-dom.mjs';

const require = createRequire(import.meta.url);
const Model = require('../js/pump/pump-model.js');
const Faces = require('../js/pump/pump-faces.js');
const Edit = require('../pump-screen/edit.js');
const { createPumpRing, cleanLevel } = require('../pump-screen/ring.js');
const lightsRing = require('../lights/pump-ring.js');
const { ledFrame } = require('../lights/lighting-led-colors.js');
const { pumpViews } = require('../menu/menu-pump.js');

const seen = { pump: { shape: 'round', w: 480, h: 480, via: 'icue' } };

test('a ring of its own: two colours kept in lower case, wrong ones back to the defaults, and it moves as the style draws', () => {
  const s = Model.normalizeScreen({});
  assert.deepEqual([s.leds.move, s.leds.colors], ['style', [...Model.LED_COLORS]]);
  assert.deepEqual(Model.normalizeScreen({ leds: { follow: 'own', colors: ['#00FF00', '#0000ff'] } }).leds.colors, ['#00ff00', '#0000ff']);
  for (const bad of [['#00ff00'], ['red', '#0000ff'], '#00ff00', ['#00ff00', '#0000ff', '#ff0000']]) {
    assert.deepEqual(Model.normalizeScreen({ leds: { colors: bad } }).leds.colors, [...Model.LED_COLORS], JSON.stringify(bad));
  }
});

test('a change says back a ring choice it cannot take, and keeps the rest of the ring', () => {
  const m = Edit.patchScreen({ seen }, 'pump', { leds: { follow: 'own', colors: ['#112233', '#445566'] } }).model;
  assert.deepEqual(m.screens.pump.leds.colors, ['#112233', '#445566']);
  assert.deepEqual(Edit.patchScreen(m, 'pump', { leds: { colors: ['#112233'] } }), { error: 'bad_led_colors' });
  assert.deepEqual(Edit.patchScreen(m, 'pump', { leds: { move: 'confetti' } }), { error: 'bad_move', choices: Model.LED_MOVES });
  assert.deepEqual(Edit.patchScreen(m, 'pump', { leds: { follow: 'rainbow' } }), { error: 'bad_follow', choices: Model.LED_FOLLOW });
  const moved = Edit.patchScreen(m, 'pump', { leds: { move: 'level' } }).model.screens.pump.leds;
  assert.deepEqual([moved.follow, moved.move, moved.colors], ['own', 'level', ['#112233', '#445566']]);
});

test('how the ring moves on a line: its own choice first, then what the style does with each line', () => {
  const sensors = { face: 'sensors', leds: 'auto' };
  assert.equal(Faces.ringEffect({ move: 'style' }, sensors, 'gauge'), 'level', 'a dial: lit up to the needle');
  assert.equal(Faces.ringEffect({ move: 'style' }, { face: 'music' }, 'gauge'), 'level');
  assert.equal(Faces.ringEffect({ move: 'style' }, sensors, 'xenon'), 'heat', "Xenon's readings warm the ring as they work");
  assert.equal(Faces.ringEffect({ move: 'style' }, { face: 'music' }, 'xenon'), 'aurora');
  assert.equal(Faces.ringEffect({ move: 'style' }, { face: 'clock' }, 'gauge'), 'clock', 'a clock: its hands round the ring');
  assert.equal(Faces.ringEffect({ move: 'style' }, { face: 'picture' }, 'gauge'), 'still');
  assert.equal(Faces.ringEffect({ move: 'style' }, { face: 'picture' }, 'xenon'), 'still');
  assert.equal(Faces.ringEffect({ move: 'style' }, { face: 'sensors', leds: 'spin' }, 'gauge'), 'spin', 'the line chose');
  assert.equal(Faces.ringEffect({ move: 'level' }, { face: 'clock' }, 'xenon'), 'level', 'asked for: the page has nothing to say, so it stays whole');
  assert.equal(Faces.ringEffect({ move: 'still' }, { face: 'game', leds: 'level' }, 'xenon'), 'level');
});

// The pump side of the ring, with a store that holds one screen as given.
function pumpSide(leds, style = 'xenon') {
  const told = [];
  const model = Model.normalize({ seen, screens: { pump: { leds, style } } });
  const ring = createPumpRing({ store: { peek: () => model }, setRing: (s) => told.push(s), later: () => null, cancel: () => {} });
  return { told, ring };
}

test('the pump side: its own colours with no page, and how far the line is only while the ring is lit up to it', () => {
  const own = pumpSide({ follow: 'own', colors: ['#112233', '#445566'], move: 'still' });
  own.ring.refresh({ pump: { show: { face: 'sensors' } } });
  assert.deepEqual(own.told.at(-1), { follow: 'own', all: false, effect: 'still', colours: ['#112233', '#445566'], speed: 'normal', reverse: false });
  const turned = pumpSide({ follow: 'own', colors: ['#112233', '#445566'], move: 'comet', speed: 'fast', reverse: true });
  turned.ring.refresh({ pump: { show: { face: 'sensors' } } });
  const last = turned.told.at(-1);
  assert.deepEqual([last.effect, last.speed, last.reverse], ['comet', 'fast', true], 'how fast and which way round reach the lights');
  const lit = pumpSide({ follow: 'own', colors: ['#112233', '#445566'] }, 'gauge');
  lit.ring.refresh({ pump: { show: { face: 'sensors' } } });
  assert.deepEqual(lit.told.at(-1).level, null, 'nothing measured yet: lit whole');
  assert.equal(lit.ring.report('pump', null, 0.426), true, 'a level alone is enough');
  assert.equal(lit.told.at(-1).level, 0.43);
  assert.deepEqual(lit.told.at(-1).colours, ['#112233', '#445566'], 'the page never colours a ring of its own');
  assert.equal(lit.ring.report('pump', null, null), false, 'neither colours nor a level');
  assert.equal(lit.ring.report('pump', null, 'half'), false);
  assert.deepEqual([cleanLevel(-1), cleanLevel(2), cleanLevel(NaN), cleanLevel('0.5')], [0, 1, null, null]);
  const screen = pumpSide({ follow: 'screen', move: 'still' });
  screen.ring.report('pump', ['#abcdef'], 0.5);
  assert.equal('level' in screen.told.at(-1), false, 'a ring that is not lit up to it is never told the level');
});

test('the lights: lit up to the level LED by LED, the rest dim; never ticking for it; every light takes its own colour', () => {
  const red = { r: 255, g: 0, b: 0 };
  try {
    lightsRing.set({ follow: 'own', effect: 'level', level: 0.5, colours: ['#ff0000'] });
    const lit = lightsRing.frame(null, 4, 0);
    assert.deepEqual(lit.slice(0, 2), [red, red]);
    assert.ok(lit[2].r > 0 && lit[2].r < 40, 'past it: dim, never dark');
    lightsRing.set({ follow: 'own', effect: 'level', level: 0.625, colours: ['#ff0000'] });
    const part = lightsRing.frame(null, 4, 0)[2];
    assert.ok(part.r > 100 && part.r < 180, `the LED the level ends in is part lit (${part.r})`);
    lightsRing.set({ follow: 'own', effect: 'level', colours: ['#ff0000'] });
    assert.deepEqual(lightsRing.frame(null, 4, 0), [red, red, red, red], 'no level said yet: whole');

    lightsRing.set({ follow: 'own', all: true, effect: 'level', level: 0.25, colours: ['#ff0000', '#0000ff'] });
    assert.equal(lightsRing.moving(), false, 'a new level paints it when said: no ticker');
    assert.deepEqual(lightsRing.leadColour(), red, "every other light takes the ring's first colour");
    const ids = ['a', 'b', 'c', 'd'];
    const leds = Object.fromEntries(ids.map((id) => [id, lightsRing.RING_LED]));
    const frame = ledFrame(ids, leds, { follow: null, pump: (count) => lightsRing.frame(null, count, 0), brightness: 1, nowMs: 0 });
    assert.deepEqual(frame[0], red);
    assert.ok(frame[3].b > 0 && frame[3].b < 40, 'the end of the ring, in the last colour past the level, is dim');

    lightsRing.set({ follow: 'own', effect: 'spin', level: 0.5, colours: ['#ff0000'] });
    assert.equal(lightsRing.set({ follow: 'own', effect: 'spin', level: 0.9, colours: ['#ff0000'] }), false, 'a level only counts while the ring follows it');
  } finally {
    lightsRing.set(null);
  }
});

// The menu's pump card for a screen with these lights.
function lookOf(leds, style = 'xenon', more = {}) {
  const screen = { screen: 'pump', ...Model.screenFor({ screens: { pump: { leds, style, ...more } }, seen: {} }, 'pump'), set: true, seen: seen.pump, now: null };
  const [view] = pumpViews({ probes: {}, pump: { icue: true, sound: true, detected: [], url: '', screens: [screen] } });
  return view;
}
const rowsOf = (view, tab) => view.tabs.find((t) => t.id === tab).rows;

test('the menu: a card for colours of one\'s own, a picker for each end, and the moves for it', () => {
  const plain = rowsOf(lookOf({ follow: 'screen' }), 'leds');
  const cards = plain.find((r) => r.id === 'pump-leds').cards;
  assert.deepEqual(cards.find((c) => c.value === 'own').art, 'leds-own');
  assert.equal(plain.find((r) => r.id === 'pump-leds-colors'), undefined, 'no pickers unless chosen');
  const own = rowsOf(lookOf({ follow: 'own', colors: ['#112233', '#445566'] }), 'leds');
  const pickers = own.find((r) => r.id === 'pump-leds-colors');
  assert.deepEqual(pickers.slots.map((s) => s.value), ['#112233', '#445566']);
  assert.deepEqual(pickers.slots.map((s) => s.label), [{ key: 'xmenu_pump_leds_color_start' }, { key: 'xmenu_pump_leds_color_end' }]);
  const patch = JSON.parse(pickers.slots[1].act.run.patch.split(JSON.stringify(pickers.mark)).join('"#ffffff"'));
  assert.deepEqual(patch, { leds: { colors: ['#112233', '#ffffff'] } }, 'a pick changes that end only');
  assert.ok(own.some((r) => r.id === 'pump-leds-move'), 'they move too');
  assert.deepEqual(own.find((r) => r.id === 'pump-leds-all').sub, { key: 'xmenu_pump_leds_all_own_sub' });
  // A line's fold in Lights offers what follows its number only where it has one.
  const lines = own.filter((r) => r.kind === 'pumpmoment');
  const values = (line) => line.rows.filter((r) => r.kind === 'pumpcards' && r.id.startsWith(line.id + '-fx')).flatMap((r) => r.cards.map((c) => c.value));
  const base = values(lines.find((l) => l.id === 'pump-ring-base'));
  assert.ok(base.includes('level') && base.includes('heat'), 'the readings line');
  assert.equal(base[0], 'auto', 'as above, first');
  const clock = values(rowsOf(lookOf({ follow: 'own' }, 'xenon', { base: { face: 'clock' } }), 'leds').find((r) => r.id === 'pump-ring-base'));
  assert.ok(!clock.includes('level') && !clock.includes('heat'), 'a clock has nothing to light up to');
  assert.ok(clock.includes('clock') && clock.includes('beat') && clock.includes('comet'));
});

// face-colors.js on a page of its own: what it says to the ring once a second.
function facePage() {
  const { document } = makeDom();
  const make = document.createElement.bind(document);
  document.createElement = (tag) => (tag === 'canvas' ? { width: 0, height: 0, getContext: () => ({}) } : make(tag));
  /** @type {any} */
  const window = { PumpFaces: Faces };
  const ctx = vm.createContext({ window, document, Intl, Number, Math, Date, Object, String, Array, JSON });
  for (const file of ['light-fx-colour', 'light-fx-calm', 'light-fx-moving', 'light-fx-pc', 'light-fx']) vm.runInContext(readFileSync(new URL(`../js/light-fx/${file}.js`, import.meta.url), 'utf8'), ctx);
  vm.runInContext(readFileSync(new URL('../js/pump/ring-effects.js', import.meta.url), 'utf8'), ctx);
  vm.runInContext(readFileSync(new URL('../js/pump/face-kit.js', import.meta.url), 'utf8'), ctx);
  window.PumpFaceKit.setWords({ locale: 'en-US' }, { lang: 'en', tempUnit: 'c' });
  vm.runInContext(readFileSync(new URL('../js/pump/face-colors.js', import.meta.url), 'utf8'), ctx);
  const said = [];
  const colors = window.PumpFaceKit.get('part', 'colors')(async (list, ring) => { said.push(JSON.parse(JSON.stringify({ list, ring }))); return true; });
  return { colors, said };
}

test('the face page says how far its line is, only when the ring is lit up to it, and nothing to a menu picture', async () => {
  const { colors, said } = facePage();
  const face = { show: { face: 'sensors', readings: ['cpu', 'gpu'] }, layer: null };
  const data = { system: { cpu: 42, gpu: 10 }, media: null };
  await colors.tick(face, { leds: { follow: 'own', move: 'level' }, style: 'xenon' }, data);
  assert.deepEqual(said.at(-1), { list: null, ring: { level: 0.42 } }, 'its first reading, with no picture read');
  await colors.tick(face, { leds: { follow: 'own', move: 'level' }, style: 'xenon' }, data);
  assert.equal(said.length, 1, 'the same level is not said again at once');
  await colors.tick(face, { leds: { follow: 'theme', move: 'style' }, style: 'gauge' }, { ...data, system: { cpu: 80 } });
  assert.deepEqual(said.at(-1).ring, { level: 0.8 }, 'Strumento lights it up to the needle');
  const before = said.length;
  await colors.tick(face, { leds: { follow: 'own', move: 'still' }, style: 'gauge' }, data);
  await colors.tick(face, { leds: { follow: 'lights', move: 'level' }, style: 'xenon' }, data);
  await colors.tick(face, null, data);
  assert.equal(said.length, before, 'a still ring, one like the other lights, and the menu\'s picture are told nothing');
  const song = { show: { face: 'music' }, layer: null };
  await colors.tick(song, { leds: { follow: 'own', move: 'level' }, style: 'xenon' }, { media: { title: 'Song', duration: 200, position: 50, playbackStatus: 'Paused' } });
  assert.deepEqual(said.at(-1).ring, { level: 0.25 }, 'the song\'s time');
  await colors.tick(face, { leds: { follow: 'own', move: 'level' }, style: 'xenon' }, { system: { gpu: 10 } });
  assert.equal(said.length, before + 1, 'no reading on this PC: nothing to light up to');
});
