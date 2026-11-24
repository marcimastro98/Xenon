// "Can people choose the colours or other things?": every line of a pump's screen has a look of
// its own (js/pump/pump-faces.js LOOK): colours, background, number size, temperature unit,
// whether a warm reading changes colour, and a line of words. The model keeps it, the menu
// offers it (menu/menu-pump-face-look.js, js/menu/xenon-menu-pump-rows.js), the face page
// draws it (js/pump/face-look.js) and a Store widget on the pump gets it (placement.look).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './browser-source.mjs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { makeDom } from './mini-dom.mjs';

const require = createRequire(import.meta.url);
const Faces = require('../js/pump/pump-faces.js');
const Fx = require('../js/light-fx/light-fx.js');
const { lookRows, COLOR_MARK, TEXT_MARK, FILE_MARK } = require('../menu/menu-pump-face-look.js');
const { momentRow } = require('../menu/menu-pump-faces.js');
const PumpRows = require('../js/menu/xenon-menu-pump-rows.js');

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const sensors = (over = {}) => Faces.normalizeFace({ face: 'sensors', style: 'rings', readings: ['cpuTemp', 'gpu'], ...over });

test('a face keeps only the look that differs from the default, so old faces stay as they were', () => {
  assert.deepEqual(sensors(), { face: 'sensors', style: 'rings', readings: ['cpuTemp', 'gpu'] });
  assert.deepEqual(sensors({ colors: 'live', bg: 'black', size: 'normal', units: 'auto', warn: true, text: '' }), sensors());
  assert.equal(Faces.colorSetOf(sensors()), 'live', 'with nothing said, the colours follow the line');
  assert.equal(sensors({ colors: 'xenon' }).colors, 'xenon', "Xenon's fixed colours stay a choice of their own");
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
  assert.deepEqual(Faces.mergeFace(look, { colors: 'live' }).colors, undefined, 'back to the default is no field at all');
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

test('four colours of one\'s own: main, second, too hot and behind, each where it belongs', () => {
  const own = sensors({ colors: ['#FF0044', '#ffd166', '#ff3b30', '#0a0a12'] });
  assert.deepEqual(own.colors, ['#ff0044', '#ffd166', '#ff3b30', '#0a0a12'], 'kept, in small letters');
  const shown = Faces.colorsOf(own.colors);
  assert.deepEqual(shown.slice(0, 2), ['#ff0044', '#ffd166'], 'the first two lead the readings');
  assert.ok(shown.every((c) => /^#[0-9a-f]{6}$/.test(c)) && new Set(shown).size === 4);
  const edges = Faces.edgesOf(own.colors);
  assert.equal(edges.warn, '#ff3b30');
  assert.equal(edges.background, '#0a0a12');
  assert.match(edges.warm, /^#[0-9a-f]{6}$/);
  assert.notEqual(edges.warm, '#ff3b30', 'warm is a lighter one of too hot');
  assert.deepEqual(Faces.edgesOf('fire'), { warn: '#ff5a5f', warm: '#ffa657', background: '#000000' }, 'a set of Xenon\'s keeps the page\'s');
  for (const bad of [['#ff0044', '#ffd166', '#ff3b30'], ['#ff0044', '#ffd166', '#ff3b30', 'red'], ['#ff0044', '#ffd166', '#ff3b30', '#000000', '#ffffff'], [1, 2, 3, 4]]) {
    assert.equal(sensors({ colors: bad }).colors, undefined, JSON.stringify(bad));
  }
  assert.deepEqual(Faces.ownOf('xenon'), ['#6ee787', '#8ab4f8', '#ff5a5f', '#000000'], 'made one\'s own, the line starts from what it shows');
  assert.deepEqual(Faces.ownOf('#ff0044').slice(2), ['#ff5a5f', '#000000'], 'and so does the one colour saved before');
  assert.deepEqual(Faces.ownOf('picture'), ['#6ee787', '#8ab4f8', '#ff5a5f', '#000000']);
  assert.equal(Faces.isLight('#f5f5f5'), true);
  assert.equal(Faces.isLight('#0a0a12'), false);
  assert.equal(Faces.isLight('#ffd166'), true, 'a bright yellow takes dark words');
  assert.equal(Faces.isLight('#3366ff'), false);
  assert.equal(Faces.isLight('nope'), false);
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
  assert.equal(colours(sensors()).at(-1), 'own', 'yours comes last');
  const own = sensors({ colors: ['#ff0044', '#ffd166', '#ff3b30', '#0a0a12'] });
  assert.deepEqual(ids(lookRows('k', own, '', apply)).slice(0, 3), ['look', 'colors', 'own'], 'with colours of one\'s own, their pickers come right under');
  assert.deepEqual(ids(lookRows('k', Faces.normalizeFace({ face: 'widget', id: 'neon-clock', colors: own.colors }), '', apply)), ['look', 'colors', 'own', 'size', 'units'], 'a widget gets them too');
  assert.ok(ids(lookRows('k', sensors({ colors: '#ff0044' }), '', apply)).includes('own'), 'the one colour saved before counts as one\'s own');
  const black = (show) => lookRows('k', show, '', apply).find((r) => r.id === 'k-bg').options.find((o) => o.value === 'black').label.key;
  assert.equal(black(own), 'xmenu_pump_bg_plain', 'with a colour of one\'s own behind, black is that colour, plain');
  assert.equal(black(sensors()), 'xmenu_pump_bg_black');
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
  const yours = colours.options.find((o) => o.value === 'own');
  assert.deepEqual(patch(yours.act).colors, [...Faces.COLOR_HEX.ice.slice(0, 2), '#ff5a5f', '#000000'], 'yours starts from what shows now');
  assert.equal(rows.some((r) => r.id === 'k-own'), false, 'no pickers until the colours are one\'s own');
  const mine = sensors({ colors: ['#ff0044', '#ffd166', '#ff3b30', '#0a0a12'] });
  const mineRows = lookRows('k', mine, '', (p) => save({ ...mine, ...p }));
  assert.equal(mineRows.find((r) => r.id === 'k-colors').options.find((o) => o.value === 'own').act, null, 'yours in use does nothing');
  const slots = mineRows.find((r) => r.id === 'k-own');
  assert.deepEqual(slots.slots.map((x) => x.value), mine.colors);
  assert.deepEqual(patch(slots.slots[2].act).colors, ['#ff0044', '#ffd166', COLOR_MARK, '#0a0a12'], 'each picker changes its own colour only');
  assert.deepEqual(patch(PumpRows.withMark(slots.slots[3].act, slots.mark, '#f5f5f5')).colors, ['#ff0044', '#ffd166', '#ff3b30', '#f5f5f5']);
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

test('in the menu the colours are keys with their swatch, one\'s own four pickers, the words a field', () => {
  const r = rig();
  const line = openLine(r, sensors({ colors: ['#ff0044', '#ffd166', '#ff3b30', '#0a0a12'] }), '#3366ff');
  const keys = line.querySelectorAll('[data-row="line-colors"] .xm-choice');
  assert.ok(keys.length >= 7);
  const xenon = line.querySelector('[data-keep="line-colors:xenon"]');
  assert.equal(xenon.getAttribute('aria-pressed'), 'false');
  assert.equal(xenon.querySelector('.xm-pumpswatch').style._props['--sw1'], '#6ee787');
  assert.equal(line.querySelector('[data-keep="line-colors:own"]').getAttribute('aria-pressed'), 'true', 'yours lights its key');
  const pickers = line.querySelectorAll('[data-row="line-own"] .xm-pumpswatch-own input');
  assert.equal(pickers.length, 4);
  assert.ok([...pickers].every((p) => p.type === 'color'));
  assert.deepEqual([...pickers].map((p) => p.value), ['#ff0044', '#ffd166', '#ff3b30', '#0a0a12']);
  pickers[1].value = '#00aaff';
  pickers[1]._handlers.change[0]();
  assert.deepEqual(JSON.parse(r.ran.at(-1).run.patch).base.colors, ['#ff0044', '#00aaff', '#ff3b30', '#0a0a12']);
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

  const mine = p.document.createElement('div');
  p.apply(mine, sensors({ colors: ['#ff0044', '#ffd166', '#ff3b30', '#f5f5f5'] }));
  assert.equal(mine.style._props['--pf-c2'], '#ffd166');
  assert.equal(mine.style._props['--pf-hot'], '#ff3b30', 'too hot is the person\'s');
  assert.equal(mine.style._props['--pf-bg'], '#f5f5f5');
  assert.ok(mine.classList.contains('pf-light'), 'a light colour behind takes dark words');
  assert.equal(plain.style._props['--pf-bg'], '#000000');
  assert.equal(plain.classList.contains('pf-light'), false);
});

test('the page loads the part before the face, and the sheet has a rule for every class it sets', () => {
  const html = read('../pump-face.html');
  assert.ok(html.indexOf('js/pump/face-look.js') > 0 && html.indexOf('js/pump/face-look.js') < html.indexOf('js/pump/pump-face.js'));
  const css = read('../components/PumpFace/PumpFace.css');
  for (const cls of ['pf-big', 'pf-nowarn', 'pf-bg-glow', 'pf-bg-pic', 'pf-has-bg', 'pf-own-text', 'pf-light']) assert.match(css, new RegExp('\\.' + cls + '\\b'), cls);
  assert.match(css, /\.pf-face \{[^}]*background-color: var\(--pf-bg/, 'the colour behind is drawn');
  assert.doesNotMatch(css, /\.pf-bg-glow \{\s*background:/, 'the glow sits over that colour, not in place of it');
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
    const window = { PumpFaces: Faces };
    vm.runInNewContext(lines, { window, document: makeDom().document, location: { search }, URLSearchParams });
    return JSON.parse(JSON.stringify(window.pumpPlacement));
  };
  assert.deepEqual(placed('?id=neon-clock&shape=square&colors=%23FF0044,%23aabbcc,%23000000,%23ffffff&warn=%23FF3B30&background=%230a0a12&size=big&units=f'),
    { shape: 'square', look: { colors: ['#ff0044', '#aabbcc', '#000000', '#ffffff'], warn: '#ff3b30', background: '#0a0a12', size: 'big', units: 'f' } });
  assert.deepEqual(placed('?id=x&colors=red,blue&warn=red&background=url(x)&size=huge&units=k').look,
    { colors: Faces.colorsOf('xenon'), warn: '#ff5a5f', background: '#000000', size: 'normal' }, 'no unit chosen: the widget keeps the one from init');
  // Live colours: the widget is told the way they go, from a calm reading to a hot one.
  assert.match(read('../js/pump/face-widget.js'), /\.\.\.\(Faces\.colorSetOf\(show\) === 'live' \? \{ live: '1' \} : \{\}\)/);
  assert.deepEqual(placed('?id=x&live=1').look.live, [...Faces.LIVE_RAMP]);
  assert.equal(placed('?id=x&live=yes').look.live, undefined, 'anything else: no live colours');
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
  m = Edit.patchScreen(m, 'pump', { addMoment: { ...game, show: { face: 'game', colors: 'live' } } }).model;
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

test('each line moves the ring of lights its own way, in Lights, never under its look', () => {
  const apply = (p) => ({ type: 'pumpSet', patch: JSON.stringify(p) });
  assert.equal(ids(lookRows('k', sensors({ leds: 'spin' }), '', apply)).some((id) => id.startsWith('leds')), false, 'a line\'s look has no ring');
  // The line's fold in the pump's Lights tab: every effect as a card, in its group.
  const { pumpViews } = require('../menu/menu-pump.js');
  const Model = require('../js/pump/pump-model.js');
  const foldOf = (base, sound) => {
    const screen = { screen: 'k', ...Model.screenFor({ screens: { k: { base } }, seen: {} }, 'k'), set: true, seen: null, now: null };
    const leds = pumpViews({ probes: {}, pump: { icue: true, sound, detected: [], url: '', screens: [screen] } })[0].tabs.find((t) => t.id === 'leds');
    return leds.rows.find((r) => r.id === 'pump-ring-base');
  };
  const cardsOf = (fold) => fold.rows.flatMap((r) => r.cards);
  const withRing = foldOf(sensors({ leds: 'spin' }), true);
  assert.deepEqual(withRing.rows.map((r) => r.id), ['pump-ring-base-fx', ...Fx.GROUPS.slice(1).map((g) => 'pump-ring-base-fx-' + g)]);
  const cards = cardsOf(withRing);
  assert.deepEqual(cards.map((c) => c.value), [...Faces.LED_EFFECTS], 'a line of readings can take them all');
  assert.ok(cards.every((c) => c.art === 'fx-' + c.value), 'each card draws its own ring');
  assert.equal(cards.find((c) => c.on).value, 'spin');
  assert.equal(cards.find((c) => c.value === 'spin').act, null, 'the one in use does nothing');
  assert.equal(JSON.parse(cards.find((c) => c.value === 'comet').act.run.patch).base.leds, 'comet');
  const deaf = cardsOf(foldOf(sensors(), false));
  assert.equal(deaf.some((c) => c.value === 'beat' || c.value === 'meter'), false, 'no sound reader here: nothing that follows it');
  assert.equal(deaf.find((c) => c.on).value, 'auto');
  assert.ok(foldOf(Faces.normalizeFace({ face: 'widget', id: 'neon-clock' }), true), 'a widget line moves it too');
  assert.equal(Faces.normalizeFace({ face: 'widget', id: 'neon-clock', leds: 'beat' }).leds, 'beat', 'and keeps it');
  assert.equal(Faces.normalizeFace({ face: 'clock', leds: 'confetti' }).leds, undefined, 'an effect it does not know: as usual');
  assert.equal(Faces.normalizeFace({ face: 'clock', leds: 'aurora' }).leds, 'aurora');
  assert.equal(Faces.mergeFace(sensors({ leds: 'breathe' }), { face: 'clock' }).leds, 'breathe', 'another face keeps it');
});
