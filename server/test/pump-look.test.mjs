// "Can people choose the colours or other things?": every line of a pump's screen has a look of
// its own (js/pump/pump-faces.js LOOK): colours, background, number size, temperature unit,
// whether a warm reading changes colour, and a line of words. The model keeps it, the menu
// offers it (menu/menu-pump-face-look.js, js/menu/xenon-menu-pump-rows.js), the face page
// draws it (js/pump/face-look.js) and a Store widget on the pump gets it (placement.look).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { makeDom } from './mini-dom.mjs';

const require = createRequire(import.meta.url);
const Faces = require('../js/pump/pump-faces.js');
const { lookRows, COLOR_MARK, TEXT_MARK, FILE_MARK } = require('../menu/menu-pump-face-look.js');
const { momentRow } = require('../menu/menu-pump-faces.js');
const PumpRows = require('../js/menu/xenon-menu-pump-rows.js');

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const sensors = (over = {}) => Faces.normalizeFace({ face: 'sensors', style: 'rings', readings: ['cpuTemp', 'gpu'], ...over });

test('a face keeps only the look that differs from the default, so old faces stay as they were', () => {
  assert.deepEqual(sensors(), { face: 'sensors', style: 'rings', readings: ['cpuTemp', 'gpu'] });
  assert.deepEqual(sensors({ colors: 'xenon', bg: 'black', size: 'normal', units: 'auto', warn: true, text: '' }), sensors());
  const own = sensors({ colors: '#FF0044', bg: 'art:tide', size: 'big', units: 'f', warn: false, text: 'Studio' });
  assert.deepEqual(Faces.lookOf(own), { colors: '#ff0044', bg: 'art:tide', size: 'big', units: 'f', warn: false, text: 'Studio' });
});

test('what comes in is checked: unknown values fall back, a background is only a picture Xenon serves', () => {
  const bad = sensors({ colors: 'red', bg: 'https://example.com/a.png', size: 'huge', units: 'k', warn: 'no', text: 42 });
  assert.deepEqual(Faces.lookOf(bad), {}, 'nothing odd is kept');
  assert.equal(sensors({ colors: '#12345' }).colors, undefined);
  assert.equal(sensors({ bg: '/uploads/pump-1-ab.gif' }).bg, '/uploads/pump-1-ab.gif');
  assert.equal(sensors({ bg: 'glow' }).bg, 'glow');
});

test('the words are one plain line of at most 24 characters', () => {
  assert.equal(sensors({ text: '  Line\none\u0007 two three  ' }).text, 'Line one two three');
  const long = 'x'.repeat(30);
  assert.equal(sensors({ text: long }).text.length, Faces.TEXT_MAX);
  assert.equal([...sensors({ text: '🔥'.repeat(30) }).text].length, Faces.TEXT_MAX, 'counted in characters, never cut inside one');
  assert.equal(sensors({ text: '   ' }).text, undefined);
});

test('another face on a line keeps its look; a widget takes the colours, size and unit only', () => {
  const look = sensors({ colors: 'fire', bg: 'glow', size: 'big', units: 'f', text: 'Hi' });
  assert.deepEqual(Faces.mergeFace(look, { face: 'clock' }), { ...Faces.normalizeFace({ face: 'clock' }), colors: 'fire', bg: 'glow', size: 'big', units: 'f', text: 'Hi' });
  assert.deepEqual(Faces.mergeFace(look, { colors: 'xenon' }).colors, undefined, 'back to the default is no field at all');
  assert.deepEqual(Faces.normalizeFace({ face: 'widget', id: 'neon-clock', colors: 'ice', bg: 'glow', size: 'big', units: 'c', text: 'x' }),
    { face: 'widget', id: 'neon-clock', colors: 'ice', size: 'big', units: 'c' });
  assert.equal(Faces.normalizeFace({ face: 'widget', id: 'neon-clock', colors: 'picture' }).colors, undefined, 'a widget is never read for colours');
});

test('a colour set is four colours; the theme and a colour of one\'s own are shaded from one', () => {
  assert.deepEqual(Faces.colorsOf('xenon'), ['#6ee787', '#8ab4f8', '#ffd75e', '#b4a0ff']);
  assert.equal(Faces.colorsOf('theme', '#1E90FF')[0], '#1e90ff');
  assert.equal(Faces.colorsOf('theme', 'not a colour')[0], '#6ee787');
  const own = Faces.colorsOf('#ff0044');
  assert.equal(own.length, 4);
  assert.ok(own.every((c) => /^#[0-9a-f]{6}$/.test(c)));
  assert.equal(new Set(own).size, 4, 'four different shades');
  assert.equal(Faces.colorsOf('picture'), null, 'read off the face while it shows');
});

const ids = (rows) => rows.map((r) => r.id.replace(/^k-/, ''));

test('the menu offers only what changes something on that face', () => {
  const apply = (p) => ({ type: 'pumpSet', patch: JSON.stringify({ base: p }) });
  assert.deepEqual(ids(lookRows('k', sensors(), '', apply)), ['look', 'colors', 'bg', 'bgown', 'size', 'units', 'warn', 'text']);
  assert.deepEqual(ids(lookRows('k', sensors({ readings: ['gpu', 'fps'] }), '', apply)), ['look', 'colors', 'bg', 'bgown', 'size', 'text'], 'no temperature, no unit and no warm colour');
  assert.deepEqual(ids(lookRows('k', Faces.normalizeFace({ face: 'clock', weather: true }), '', apply)), ['look', 'colors', 'bg', 'bgown', 'size', 'units', 'text']);
  assert.deepEqual(ids(lookRows('k', Faces.normalizeFace({ face: 'music' }), '', apply)), ['look', 'colors', 'text']);
  assert.deepEqual(ids(lookRows('k', Faces.normalizeFace({ face: 'widget', id: 'neon-clock' }), '', apply)), ['look', 'colors', 'size', 'units']);
  const colours = (show) => lookRows('k', show, '', apply)[1].options.map((o) => o.value);
  assert.ok(!colours(sensors()).includes('picture'), 'no picture, no colours from one');
  assert.ok(colours(sensors({ bg: 'art:ember' })).includes('picture'));
  assert.ok(colours(Faces.normalizeFace({ face: 'music' })).includes('picture'));
  assert.ok(!colours(Faces.normalizeFace({ face: 'widget', id: 'neon-clock' })).includes('picture'));
});

test('each choice saves the line with that one field changed; what the person types goes where its mark is', () => {
  const show = sensors({ colors: 'ice' });
  const save = (s) => ({ type: 'pumpSet', patch: JSON.stringify({ base: s }) });
  const rows = lookRows('k', show, '#3366ff', (p) => save({ ...show, ...p }));
  const colours = rows.find((r) => r.id === 'k-colors');
  const patch = (act) => JSON.parse(act.run.patch).base;
  assert.equal(colours.options.find((o) => o.value === 'ice').act, null, 'the set in use does nothing');
  assert.equal(patch(colours.options.find((o) => o.value === 'fire').act).colors, 'fire');
  assert.equal(colours.options.find((o) => o.value === 'theme').swatch[0], '#3366ff', 'the theme swatch wears the theme\'s colour');
  assert.equal(patch(colours.own.act).colors, COLOR_MARK);
  assert.equal(patch(PumpRows.withMark(colours.own.act, colours.mark, '#00aaff')).colors, '#00aaff');
  const text = rows.find((r) => r.id === 'k-text');
  assert.equal(patch(PumpRows.withMark(text.act, TEXT_MARK, 'Say "hi"')).text, 'Say "hi"', 'quotes stay words, never JSON');
  assert.equal(patch(rows.find((r) => r.id === 'k-bgown').act).bg, FILE_MARK);
  assert.equal(patch(rows.find((r) => r.id === 'k-warn').options.find((o) => o.value === 'off').act).warn, false);
});

test('another face picked on a line keeps the line\'s look', () => {
  const show = sensors({ colors: 'fire', size: 'big' });
  const v = { screen: 'pump', base: show, moments: [] };
  const row = momentRow({ id: 'pump-base', label: 'x', show, v, st: { pump: {} }, save: (s) => ({ type: 'pumpSet', patch: JSON.stringify({ base: s }) }) });
  const clock = JSON.parse(row.faces.find((f) => f.value === 'clock').act.run.patch).base;
  assert.equal(clock.face, 'clock');
  assert.equal(clock.colors, 'fire');
  assert.equal(clock.size, 'big');
});

function rig() {
  const { document } = makeDom();
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const say = (x) => (x == null ? '' : typeof x === 'string' ? x : x.key || x.text || '');
  const ran = [];
  const rowShell = (r, cls) => { const n = el('div', 'xm-row' + (cls ? ' ' + cls : '')); n.dataset.row = r.id; return n; };
  const { draw } = PumpRows.create({ el, button: (cls, label) => el('button', cls, label), say, perform: async (_row, act) => { ran.push(act); }, icon: () => null, DRAW: {}, rowShell });
  return { draw, ran, document };
}

// The look rows are drawn inside an open line: a line whose only face choice is its look.
function openLine(r, show, accent = '') {
  const save = (s) => ({ type: 'pumpSet', patch: JSON.stringify({ base: s }) });
  const row = { kind: 'pumpmoment', id: 'line', label: 'l', show, faces: [], rows: lookRows('line', show, accent, (p) => save({ ...show, ...p })) };
  r.document.body.replaceChildren(r.draw.pumpmoment(row));
  r.document.body.children[0].querySelector('.xm-pumpline-head').click();
  return r.document.body.children[0];
}

test('in the menu the colours are keys with their swatch, the own colour a picker, the words a field', () => {
  const r = rig();
  const line = openLine(r, sensors({ colors: '#ff0044' }), '#3366ff');
  const keys = line.querySelectorAll('[data-row="line-colors"] .xm-choice');
  assert.ok(keys.length >= 7);
  const xenon = line.querySelector('[data-keep="line-colors:xenon"]');
  assert.equal(xenon.getAttribute('aria-pressed'), 'false');
  assert.equal(xenon.querySelector('.xm-pumpswatch').style._props['--sw1'], '#6ee787');
  const own = line.querySelector('.xm-pumpswatch-own');
  assert.ok(own.classList.contains('is-on'), 'a colour of one\'s own lights its key');
  const picker = own.querySelector('input');
  assert.equal(picker.type, 'color');
  assert.equal(picker.value, '#ff0044');
  picker.value = '#00aaff';
  picker._handlers.change[0]();
  assert.equal(JSON.parse(r.ran.at(-1).run.patch).base.colors, '#00aaff');
  xenon.click();
  assert.equal(JSON.parse(r.ran.at(-1).run.patch).base.colors, 'xenon');

  const field = line.querySelector('.xm-pumptext');
  assert.equal(field.maxLength, Faces.TEXT_MAX);
  const before = r.ran.length;
  field.value = '';
  field._handlers.change[0]();
  assert.equal(r.ran.length, before, 'the same words save nothing');
  field.value = '  Studio PC ';
  field._handlers.change[0]();
  assert.equal(JSON.parse(r.ran.at(-1).run.patch).base.text, 'Studio PC');
});

// The face page's part, run on a fake kit: it sets the colours and classes and puts the words on.
function lookPart() {
  const { document } = makeDom();
  const parts = {};
  let units = '';
  const Kit = {
    add: (kind, name, fn) => { parts[kind + ':' + name] = fn; },
    get: (kind, name) => parts[kind + ':' + name] || null,
    useUnits: (u) => { units = u; },
    prefs: () => ({ accent: '#1e90ff' }),
    el: (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; },
  };
  vm.runInNewContext(read('../js/pump/face-look.js'), { window: { PumpFaceKit: Kit, PumpFaces: Faces } });
  return { apply: parts['part:look'], document, units: () => units };
}

test('the face page draws the look: colours on the layer, classes for size, warm and glow, the words as text', () => {
  const p = lookPart();
  const layer = p.document.createElement('div');
  const look = p.apply(layer, sensors({ colors: 'theme', size: 'big', warn: false, bg: 'glow', units: 'f', text: '<b>hi</b>' }));
  assert.equal(layer.style._props['--pf-c1'], '#1e90ff');
  assert.ok(['pf-big', 'pf-nowarn', 'pf-bg-glow'].every((c) => layer.classList.contains(c)));
  assert.equal(p.units(), 'f');
  const words = layer.querySelector('.pf-own-text');
  assert.equal(words.textContent, '<b>hi</b>', 'never read as markup');
  assert.equal(words.children.length, 0);
  look.fromPicture(['#112233', '#445566']);
  assert.equal(layer.style._props['--pf-c1'], '#1e90ff', 'colours from a picture only when the look asks for them');

  const plain = p.document.createElement('div');
  p.apply(plain, sensors());
  assert.equal(plain.style._props['--pf-c1'], '#6ee787');
  assert.equal(plain.querySelector('.pf-own-text'), null);
  assert.equal(p.units(), 'auto');

  const fromPic = p.document.createElement('div');
  p.apply(fromPic, Faces.normalizeFace({ face: 'music', colors: 'picture' })).fromPicture(['#112233', '#445566']);
  assert.equal(fromPic.style._props['--pf-c1'], '#112233');
  assert.equal(fromPic.style._props['--pf-c2'], '#445566');
});

test('the page loads the part before the face, and the sheet has a rule for every class it sets', () => {
  const html = read('../pump-face.html');
  assert.ok(html.indexOf('js/pump/face-look.js') > 0 && html.indexOf('js/pump/face-look.js') < html.indexOf('js/pump/pump-face.js'));
  const css = read('../components/PumpFace/PumpFace.css');
  for (const cls of ['pf-big', 'pf-nowarn', 'pf-bg-glow', 'pf-bg-pic', 'pf-has-bg', 'pf-own-text']) assert.match(css, new RegExp('\\.' + cls + '\\b'), cls);
});

test('a Store widget on the pump gets its line\'s look in its placement, checked as any query', () => {
  const host = read('../js/pump/pump-widget-host.js');
  assert.match(host, /window\.pumpPlacement = Object\.freeze\(\{/);
  assert.match(read('../js/custom-widget/custom-widget.js'), /where === 'pump' \? \(window\.pumpPlacement \|\| \{ shape: 'round' \}\)/);
  assert.match(read('../js/pump/face-widget.js'), /\.\.\.lookQuery\(show\)/);
  // Only the lines that build the placement run here: the page's own start needs the bridge.
  const at = host.indexOf('  const doc = document.documentElement;');
  const end = host.indexOf('  });\n', host.indexOf('window.pumpPlacement')) + 6;
  const lines = `const SHAPES = ['round', 'square', 'wide'];\n${host.slice(at, end).replace(/^ {2}const (host|widgets|id) = .*$/gm, '')}`;
  const placed = (search) => {
    const window = {};
    vm.runInNewContext(lines, { window, document: makeDom().document, location: { search }, URLSearchParams });
    return JSON.parse(JSON.stringify(window.pumpPlacement));
  };
  assert.deepEqual(placed('?id=neon-clock&shape=square&colors=%23FF0044,%23aabbcc,%23000000,%23ffffff&size=big&units=f'),
    { shape: 'square', look: { colors: ['#ff0044', '#aabbcc', '#000000', '#ffffff'], size: 'big', units: 'f' } });
  assert.deepEqual(placed('?id=x&colors=red,blue&size=huge&units=k').look, { colors: Faces.colorsOf('xenon'), size: 'normal' }, 'no unit chosen: the widget keeps the one from init');
});

test('Bit\'s patch: a line takes a look, and the same moment asked again keeps the one it had', () => {
  const Edit = require('../pump-screen/edit.js');
  const game = { when: { any: [{ c: 'game' }] } };
  let m = Edit.patchScreen({}, 'pump', { setup: 'game' }).model;
  m = Edit.patchScreen(m, 'pump', { base: { colors: 'violet', text: 'Desk' }, addMoment: { ...game, show: { face: 'game', colors: 'fire', size: 'big' } } }).model;
  const moment = () => m.screens.pump.moments.find((x) => x.when.any[0].c === 'game').show;
  assert.equal(m.screens.pump.base.colors, 'violet');
  assert.equal(m.screens.pump.base.text, 'Desk');
  assert.deepEqual([moment().colors, moment().size], ['fire', 'big']);
  m = Edit.patchScreen(m, 'pump', { addMoment: { ...game, show: { face: 'game', readings: ['fps'] } } }).model;
  assert.deepEqual([moment().colors, moment().size, moment().readings], ['fire', 'big', ['fps']]);
  m = Edit.patchScreen(m, 'pump', { addMoment: { ...game, show: { face: 'game', colors: 'xenon' } } }).model;
  assert.equal(moment().colors, undefined, 'named back to the default, it goes');
});

test('Bit is told every look field, with the values the model accepts', () => {
  const { CAPABILITIES } = require('../js/capabilities/catalog-pump.js');
  const said = CAPABILITIES.find((c) => c.type === 'pumpSet').capability.ai.description;
  for (const field of Object.keys(Faces.LOOK)) assert.match(said, new RegExp(`"${field}"`), field);
  for (const set of Faces.COLOR_SETS) assert.ok(said.includes(set), set);
  for (const art of Faces.OWN_ART) assert.ok(said.includes(art), art);
  for (const effect of Faces.LED_EFFECTS) assert.ok(said.includes(effect), effect);
  assert.ok(said.includes(String(Faces.TEXT_MAX)));
});

test('each line moves the ring of lights its own way, where the ring has colours of its own', () => {
  const apply = (p) => ({ type: 'pumpSet', patch: JSON.stringify(p) });
  assert.equal(ids(lookRows('k', sensors(), '', apply)).includes('leds'), false, 'no ring of its own: no row');
  const withRing = lookRows('k', sensors({ leds: 'spin' }), '', apply, { sound: true });
  assert.deepEqual(ids(withRing).slice(0, 3), ['look', 'colors', 'leds'], 'right under the colours it uses');
  const row = withRing.find((r) => r.id === 'k-leds');
  assert.deepEqual(row.options.map((o) => o.value), [...Faces.LED_EFFECTS]);
  assert.equal(row.options.find((o) => o.on).value, 'spin');
  assert.equal(row.options.find((o) => o.value === 'spin').act, null, 'the one in use does nothing');
  assert.deepEqual(JSON.parse(row.options.find((o) => o.value === 'still').act.run.patch), { leds: 'still' });
  const deaf = lookRows('k', sensors(), '', apply, { sound: false }).find((r) => r.id === 'k-leds');
  assert.equal(deaf.options.some((o) => o.value === 'beat'), false, 'no sound reader here: no beat');
  assert.equal(deaf.options.find((o) => o.on).value, 'auto');
  assert.ok(ids(lookRows('k', Faces.normalizeFace({ face: 'widget', id: 'neon-clock' }), '', apply, { sound: true })).includes('leds'), 'a widget line moves it too');
  assert.equal(Faces.normalizeFace({ face: 'widget', id: 'neon-clock', leds: 'beat' }).leds, 'beat', 'and keeps it');
  assert.equal(Faces.normalizeFace({ face: 'clock', leds: 'sparkle' }).leds, undefined, 'an effect it does not know: as usual');
  assert.equal(Faces.mergeFace(sensors({ leds: 'breathe' }), { face: 'clock' }).leds, 'breathe', 'another face keeps it');
});
