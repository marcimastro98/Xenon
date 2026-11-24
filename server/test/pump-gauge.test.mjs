// Strumento, a screen's second style (js/pump/pump-faces.js SCREEN_STYLES): the model keeps
// it and its switches, a change checks it (pump-screen/edit.js), the menu offers it in Look
// and says on each line it draws (menu/menu-pump-look.js, menu-pump-faces.js), and the face
// page draws the faces with a number or a time as a dial (js/pump/face-gauge.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { readFileSync } from './browser-source.mjs';
import { makeDom } from './mini-dom.mjs';

const require = createRequire(import.meta.url);
const Faces = require('../js/pump/pump-faces.js');
const Model = require('../js/pump/pump-model.js');
const Edit = require('../pump-screen/edit.js');
const { pumpViews } = require('../menu/menu-pump.js');

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const seen = { pump: { shape: 'round', w: 480, h: 480, via: 'icue' } };

test('Xenon stays the default style, and Strumento draws only faces with a number or a time', () => {
  const s = Model.normalizeScreen({});
  assert.equal(s.style, 'xenon');
  assert.deepEqual(s.gauge, { needle: true, arc: true });
  assert.equal(Model.normalizeScreen({ style: 'neon' }).style, 'xenon', 'an unknown style is the default');
  assert.deepEqual(Model.normalizeScreen({ style: 'gauge', gauge: { needle: false, arc: 'no' } }).gauge, { needle: false, arc: true });
  for (const face of ['sensors', 'game', 'music', 'clock']) assert.equal(Faces.drawnAs('gauge', face), 'gauge', face);
  for (const face of ['picture', 'widget']) assert.equal(Faces.drawnAs('gauge', face), face, face + ' stays as it is');
  assert.equal(Faces.drawnAs('xenon', 'sensors'), 'sensors');
  // A setup changes the faces, never how they are drawn.
  const kept = Model.withSetup({ style: 'gauge', gauge: { needle: false, arc: true } }, 'music');
  assert.deepEqual([kept.style, kept.gauge.needle], ['gauge', false]);
});

test('a change checks the style and keeps the other switch', () => {
  const m = Edit.patchScreen({ seen }, 'pump', { style: 'gauge' }).model;
  assert.equal(m.screens.pump.style, 'gauge');
  const bad = Edit.patchScreen(m, 'pump', { style: 'neon' });
  assert.deepEqual(bad, { error: 'bad_style', choices: [...Faces.SCREEN_STYLES, 'widget:<id>'] });
  const off = Edit.patchScreen(m, 'pump', { gauge: { arc: false } }).model.screens.pump;
  assert.deepEqual([off.style, off.gauge], ['gauge', { needle: true, arc: false }]);
  assert.equal(Edit.patchScreen(m, 'pump', { style: 'xenon' }).model.screens.pump.style, 'xenon');
});

// The menu as GET /pump gives a screen.
function look(over = {}) {
  const screen = { screen: 'pump', ...Model.screenFor({ screens: {}, seen: {} }, 'pump'), set: true, seen: seen.pump, now: null, ...over };
  const [view] = pumpViews({ probes: {}, pump: { icue: true, detected: [], url: '', screens: [screen] } });
  return view;
}
const rowOf = (view, tab, id) => view.tabs.find((t) => t.id === tab).rows.find((r) => r.id === id);

test('Look opens on the style: two cards, Strumento\'s switches only while it is chosen', () => {
  const plain = look();
  const style = rowOf(plain, 'look', 'pump-style');
  assert.equal(style.kind, 'pumpcards');
  assert.equal(plain.tabs.find((t) => t.id === 'look').rows[0], style, 'first in Look');
  assert.deepEqual(style.cards.map((c) => [c.value, c.art, c.on]), [['xenon', 'style-xenon', true], ['gauge', 'style-gauge', false]]);
  assert.deepEqual(JSON.parse(style.cards[1].act.run.patch), { style: 'gauge' });
  assert.equal(style.cards[0].act, null, 'the style in use is no button');
  assert.equal(rowOf(plain, 'look', 'pump-needle'), undefined);
  const gauge = look({ style: 'gauge', gauge: { needle: true, arc: false } });
  assert.equal(rowOf(gauge, 'look', 'pump-needle').on, true);
  assert.equal(rowOf(gauge, 'look', 'pump-arc').on, false);
  assert.deepEqual(JSON.parse(rowOf(gauge, 'look', 'pump-arc').acts.on.run.patch), { gauge: { arc: true } });
});

test('a widget style chosen in Look takes the ring\'s moves too; Xenon\'s own styles leave the ring alone', () => {
  const widgets = [{ id: 'pump-bit', name: 'Bit', style: true, shapes: ['round'] }];
  const view = (move) => {
    const screen = { screen: 'pump', ...Model.screenFor({ screens: {}, seen: {} }, 'pump'), set: true, seen: seen.pump, now: null };
    screen.leds = { ...screen.leds, move };
    return pumpViews({ probes: {}, pump: { icue: true, detected: [], url: '', screens: [screen], widgets } })[0];
  };
  const cardOf = (v, value) => rowOf(v, 'look', 'pump-style').cards.find((c) => c.value === value);
  const candle = view('candle');
  assert.deepEqual(JSON.parse(cardOf(candle, 'widget:pump-bit').act.run.patch), { style: 'widget:pump-bit', leds: { move: 'style' } });
  assert.deepEqual(JSON.parse(cardOf(candle, 'gauge').act.run.patch), { style: 'gauge' });
  assert.deepEqual(JSON.parse(cardOf(view('style'), 'widget:pump-bit').act.run.patch), { style: 'widget:pump-bit' });
});

test('a line drawn as Strumento says so instead of offering a style it would not show', () => {
  const lines = (view) => view.tabs[0].rows.filter((r) => r.kind === 'pumpmoment');
  const plain = lines(look());
  const gauge = lines(look({ style: 'gauge' }));
  const base = (ls) => ls.find((r) => r.id === 'pump-base');
  assert.ok(base(plain).rows.some((r) => r.id === 'pump-base-style'), 'Xenon: the face\'s own style');
  assert.ok(!base(gauge).rows.some((r) => r.id === 'pump-base-style'));
  assert.deepEqual([base(plain).art, base(gauge).art], ['sensors', 'gauge'], 'drawn small as it shows');
  const picture = lines(look({ style: 'gauge', base: { face: 'picture', items: ['art:tide'] } }));
  assert.equal(base(picture).art, 'picture', 'a picture stays a picture');
  const note = base(gauge).rows.find((r) => r.id === 'pump-base-drawn');
  assert.equal(note.kind, 'pumpnote');
  assert.deepEqual(note.label, { key: 'xmenu_pump_drawn_note_readings' }, 'the readings face says which reading the needle takes');
  // Under the line's name: the first two readings, the two the dial shows.
  assert.equal(base(gauge).sub.length, 2);
});

// The face page's kit and Strumento on a page of their own.
function page() {
  const { document } = makeDom();
  const window = {};
  const ctx = vm.createContext({ window, document, Intl, Number, Math, Date, Object, String, Array, JSON });
  vm.runInContext(read('../js/pump/face-kit.js'), ctx);
  const Kit = window.PumpFaceKit;
  Kit.setWords({ locale: 'it-IT', pump_reading_cpu_temp: 'Temp. CPU' }, { lang: 'it', tempUnit: 'c' });
  Kit.add('part', 'weather', () => document.createElement('div'));
  vm.runInContext(read('../js/pump/face-gauge.js'), ctx);
  const mount = (opts) => {
    const root = document.createElement('div');
    const face = Kit.get('face', 'gauge')(root, { gauge: { needle: true, arc: true }, ...opts });
    return { root, face, find: (sel) => root.querySelector(sel) };
  };
  return { mount };
}

test('the dial: the needle turns to the reading, a hot one turns the face, the second goes above', () => {
  const p = page();
  const f = p.mount({ face: 'sensors', readings: ['cpuTemp', 'cpu'] });
  f.face.update({ system: { cpuTemp: 50, cpu: 30 } });
  // 50 of 100 °C: half of the 270° sweep from 225°.
  assert.equal(f.find('.pf-g-needle').style.getPropertyValue('--pf-g-turn'), '360.00deg');
  assert.equal(f.find('.pf-g-top').textContent, 'CPU load 30%');
  assert.equal(f.find('.pf-g-label').textContent, 'Temp. CPU');
  assert.equal(f.root.classList.contains('pf-g-hot'), false);
  assert.ok(f.root.querySelectorAll('.pf-g-redline').length > 0, 'a temperature marks its last tenth');
  f.face.update({ system: { cpuTemp: 95, cpu: 30 } });
  assert.equal(f.root.classList.contains('pf-g-hot'), true);
  assert.equal(f.find('.pf-g-big').dataset.digits, '2');
  f.face.update({ system: { cpu: 30 } });
  assert.equal(f.root.classList.contains('pf-g-rest'), true, 'no reading: the needle rests');
  // At rest only the hub shows: a needle on 0 would say 0, and cross the words under the hub.
  assert.match(read('../components/PumpFace/PumpFaceGauge.css'), /\.pf-g-rest \.pf-g-needle polygon \{ opacity: 0; \}/);
});

test('the switches: no needle draws none, no arc draws no arc', () => {
  const p = page();
  const bare = p.mount({ face: 'sensors', readings: ['cpu'], gauge: { needle: false, arc: false } });
  bare.face.update({ system: { cpu: 40 } });
  assert.equal(bare.find('.pf-g-needle'), null);
  assert.equal(bare.find('.pf-fill'), null);
  assert.ok(bare.find('.pf-g-tick'), 'the marks stay');
});

test('the song and the clock as instruments', () => {
  const p = page();
  const song = p.mount({ face: 'music' });
  song.face.update({ media: { title: 'Song', artist: 'Band', duration: 200, position: 100, playing: false } });
  assert.equal(song.find('.pf-g-label').textContent, 'Song');
  assert.equal(song.find('.pf-g-top').textContent, 'Band');
  assert.match(song.find('.pf-g-big .pf-num').textContent, /^\d+:\d\d$/);
  song.face.update({ media: null });
  assert.equal(song.root.classList.contains('pf-g-rest'), true);
  const clock = p.mount({ face: 'clock', seconds: true, date: true });
  clock.face.update({});
  assert.ok(clock.find('.pf-g-hour') && clock.find('.pf-g-min') && clock.find('.pf-g-sec'));
  assert.notEqual(clock.find('.pf-g-date').textContent, '');
});

test('the face page loads Strumento after the faces it draws, and its stylesheet', () => {
  const html = read('../pump-face.html');
  const at = (s) => html.indexOf(s);
  assert.ok(at('js/pump/face-gauge.js') > at('js/pump/face-clock.js') && at('js/pump/face-gauge.js') < at('js/pump/pump-face.js'));
  assert.ok(at('components/PumpFace/PumpFaceGauge.css') > 0);
  assert.ok(read('../js/pump/pump-face.js').includes('Faces.drawnShow(face0, settings,'));
});
