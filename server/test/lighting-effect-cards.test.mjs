// Settings -> Lighting shows its effects as cards (js/lighting-page/effect-cards.js): every effect
// of the one list (js/light-fx/light-fx.js) by group, each drawn moving with its name and a line
// that says what it does, none this PC cannot follow, and under the chosen one only the choices it
// uses. The same cards serve all the lights, one device and a group of its LEDs. The real page
// files run on the small DOM; what the cards draw is recorded instead of painted, and posts are
// recorded instead of sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { readFileSync } from './browser-source.mjs';
import { makeDom, settle } from './mini-dom.mjs';

const require = createRequire(import.meta.url);
const Fx = require('../js/light-fx/light-fx.js');
const Device = require('../js/light-fx/light-fx-device.js');
const FILES = ['lighting/lighting-ui.js', 'lighting-map/geometry.js', 'lighting-map/lighting-map.js', 'lighting/lighting-device.js', 'lighting-page/panels.js'];
const src = (f) => readFileSync(new URL('../js/' + f, import.meta.url), 'utf8');
const SRC = FILES.map(src);
const CARDS = src('lighting-page/effect-cards.js');
// Loaded with the cards: the shared drawing of a device's parts and the map's moving LEDs.
const PAGE = { 'js/light-fx/light-fx-device.js': src('light-fx/light-fx-device.js'), 'js/lighting-page/effect-cards.js': CARDS, 'js/lighting-map/map-motion.js': src('lighting-map/map-motion.js') };
const LANGS = ['de', 'en', 'es', 'fr', 'it', 'ja', 'ko', 'nl', 'pt', 'ru', 'zh'];

function rig({ cards = true, engine = true } = {}) {
  const { document, mkEl } = makeDom();
  document.head = mkEl('head');
  document.documentElement.appendChild(document.head);
  const drawn = [];
  const posts = [];
  const runs = [];
  const window = {
    LightFx: engine ? Fx : undefined,
    LightFxPreview: engine ? { mount: (node, look) => { drawn.push({ node, look }); return true; }, run: (node, tick) => runs.push({ node, tick }) } : undefined,
  };
  const fetch = async (path, init) => { posts.push({ path, body: JSON.parse(init.body) }); return { json: async () => ({}) }; };
  const ctx = vm.createContext({ window, document, console, t: (k) => k, fetch });
  for (const s of SRC) vm.runInContext(s, ctx);
  if (cards) for (const page of Object.values(PAGE)) vm.runInContext(page, ctx);
  return { document, window, drawn, posts, runs };
}

const pressed = (root) => root.querySelectorAll('.lighting-fxcard[aria-pressed="true"] [data-i18n]').map((n) => n.getAttribute('data-i18n'));
const names = (root) => root.querySelectorAll('.lighting-fxcard-name').map((n) => n.getAttribute('data-i18n'));
const keys = (root) => root.querySelectorAll('[data-i18n]').map((n) => n.getAttribute('data-i18n'));
const cardOf = (root, id) => root.querySelectorAll('.lighting-fxcard').find((c) => c.querySelector(`[data-i18n="light_fx_${id}"]`));
const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('');

async function effects(r, animation, cannot = []) {
  const panel = r.window.LightingPagePanels.effectsPanel(() => {}, { animation, cannot, effects: {} });
  await settle();
  return panel;
}

test('every effect of the list is a card, by group, with its line; none this PC cannot follow', async () => {
  const r = rig();
  const panel = await effects(r, { style: 'comet', palette: ['#ff0000', '#0000ff'], speed: 60 }, ['fans', 'sound']);
  const shown = names(panel).filter((k) => k.startsWith('light_fx_')).map((k) => k.slice('light_fx_'.length));
  const want = Fx.LIST.filter((e) => Fx.LIGHTING.includes(e.id) && !['fans', 'sound'].includes(e.needs)).map((e) => e.id);
  assert.deepEqual(shown, want, 'the list order, grouped, without fans and sound here');
  assert.ok(want.includes('clock') && !shown.includes('fans') && !shown.includes('beat'));
  assert.deepEqual(panel.querySelectorAll('.lighting-fxgroup-name').map((n) => n.getAttribute('data-i18n')).slice(0, Fx.GROUPS.length - 1),
    ['light_fx_group_calm', 'light_fx_group_moving', 'light_fx_group_pc'], 'music has no effect left without a sound reader');
  for (const id of shown) assert.ok(cardOf(panel, id).querySelector(`[data-i18n="light_fx_${id}_sub"]`), id + ' says what it does');
  assert.deepEqual(pressed(panel), ['light_fx_comet', 'light_fx_comet_sub']);
  const all = await effects(rig(), { style: 'none' });
  assert.ok(names(all).includes('light_fx_beat') && names(all).includes('light_fx_fans'), 'with every reading, every effect');
  assert.deepEqual(pressed(all), ['lighting_anim_none'], 'no effect: the plain card is the chosen one');
});

test('a card draws its effect: the chosen one as set, the rest in the person\'s colours', async () => {
  const r = rig();
  await effects(r, { style: 'comet', palette: ['#ff0000', '#0000ff'], speed: 60, reverse: true, size: 0.8, glow: 0 });
  const of = (id) => r.drawn.find((d) => d.look.effect === id && d.look.shape === 'ring' && !d.look.box).look;
  assert.deepEqual({ ...of('comet'), colours: of('comet').colours.map(hex) },
    { effect: 'comet', colours: ['#ff0000', '#0000ff'], speed: 60, reverse: true, amount: 0.8, glow: 0, shape: 'ring' });
  assert.deepEqual(of('bands').colours.map(hex), ['#ff0000', '#0000ff'], 'another card: the same colours, as made');
  assert.equal(of('bands').reverse, undefined);
  const old = rig();
  await effects(old, { style: 'cycle', color: '#00ff00', palette: ['#111111', '#222222'], speed: 50 });
  const shift = old.drawn.find((d) => d.look.effect === 'shift').look;
  assert.equal(shift.colours.length, Fx.lightingLook({ style: 'cycle' }).colours.length, "a name saved before the list draws as the lights do: cycle's rainbow");
});

test('under the chosen effect only the choices it uses, for all the lights', async () => {
  const comet = keys(await effects(rig(), { style: 'comet', palette: ['#ff0000'], speed: 50 }));
  for (const k of ['lighting_fx_tune', 'lighting_fx_sets', 'lighting_palette_colors', 'lighting_anim_speed', 'xmenu_pump_leds_reverse', 'light_fx_size_tail', 'xmenu_pump_leds_glow', 'lighting_chain']) {
    assert.ok(comet.includes(k), 'comet has ' + k);
  }
  const still = keys(await effects(rig(), { style: 'still', palette: ['#ff0000'] }));
  assert.ok(still.includes('lighting_palette_colors') && !still.includes('lighting_anim_speed') && !still.includes('lighting_chain') && !still.includes('xmenu_pump_leds_reverse'), 'still: colours only');
  const rainbow = keys(await effects(rig(), { style: 'rainbow', speed: 50 }));
  assert.ok(!rainbow.includes('lighting_fx_sets') && rainbow.includes('light_fx_size_waves'), 'rainbow keeps its own colours and counts waves');
  assert.ok(!keys(await effects(rig(), { style: 'none' })).includes('lighting_fx_tune'), 'no effect, no choices');
});

test('cards, sets and swatches post what the person chose', async () => {
  const r = rig();
  const panel = await effects(r, { style: 'comet', palette: ['#ff0000', '#00ff00'], speed: 50 });
  cardOf(panel, 'orbit').click();
  await settle();
  assert.deepEqual(r.posts.pop(), { path: '/api/lighting/animation', body: { style: 'orbit' } });
  const sets = panel.querySelectorAll('.lighting-fxset');
  assert.equal(sets.length, Fx.PALETTE_IDS.length);
  sets[Fx.PALETTE_IDS.indexOf('ocean')].click();
  await settle();
  assert.deepEqual(r.posts.pop().body, { palette: Fx.PALETTES.ocean.map(hex) }, 'a set fills the colours');
  panel.querySelectorAll('.lighting-palette-row .settings-btn').find((b) => b.getAttribute('data-i18n') === 'lighting_palette_add').click();
  await settle();
  assert.deepEqual(r.posts.pop().body, { palette: ['#ff0000', '#00ff00', '#00ff00'] }, 'one more colour, as the last');
  const glow = panel.querySelectorAll('.settings-segment-btn').find((b) => b.getAttribute('data-i18n') === 'xmenu_pump_leds_glow_auto');
  glow.click();
  await settle();
  assert.deepEqual(r.posts.pop().body, { glow: null }, 'as the effect is made: the value goes');
  panel.querySelectorAll('.settings-segment-btn').find((b) => b.getAttribute('data-i18n') === 'lighting_chain_after').click();
  await settle();
  assert.deepEqual(r.posts.pop().body, { chain: true });
  const set = panel.querySelectorAll('.lighting-fxset')[Fx.PALETTE_IDS.indexOf('neon')];
  assert.equal(set.querySelector('.lighting-fxset-bar').style._props['--fx-set'], `linear-gradient(90deg, ${Fx.PALETTES.neon.map(hex).join(', ')})`);
});

test('colours chosen on a name saved before the list move it to the list\'s own name', async () => {
  const r = rig();
  const panel = await effects(r, { style: 'breathing', color: '#ff8800', palette: ['#111111', '#222222'], speed: 50 });
  assert.deepEqual(pressed(panel), ['light_fx_breathe', 'light_fx_breathe_sub'], 'breathing is the Breathe card');
  assert.equal(panel.querySelectorAll('.lighting-palette-cell').length, 1, 'its one colour, not the unused list');
  panel.querySelectorAll('.lighting-fxset')[0].click();
  await settle();
  assert.deepEqual(r.posts.pop().body, { style: 'breathe', palette: Fx.PALETTES[Fx.PALETTE_IDS[0]].map(hex) });
});

test('together or one after another: two fans and a strip show it', async () => {
  for (const chain of [false, true]) {
    const r = rig();
    await effects(r, { style: 'comet', palette: ['#ff0000'], speed: 50, chain });
    const parts = r.drawn.filter((d) => d.look.box).map((d) => [d.look.shape, d.look.phase]);
    assert.deepEqual(parts, chain ? [['ring', 0], ['ring', 1 / 3], ['line', 2 / 3]] : [['ring', 0], ['ring', 0], ['line', 0]]);
  }
});

test('one device: temperature and album first, the cards, and its choices without the chain', async () => {
  const r = rig();
  const status = { enabled: true, effects: {}, cannot: [], devices: [] };
  const dev = { id: 'pretend-fan', model: 'Pretend Fan', source: 'icue', mode: 'temperature' };
  const card = r.window.LightingDevice.card(() => {}, status, dev, 'Pretend');
  await settle();
  assert.deepEqual(pressed(card), ['lighting_fx_temperature']);
  assert.ok(!keys(card).includes('lighting_fx_tune'), 'temperature has no effect choices');
  cardOf(card, 'comet').click();
  await settle();
  const sent = r.posts.pop();
  assert.equal(sent.path, '/api/lighting/device-mode');
  assert.deepEqual([sent.body.mode, sent.body.anim.style], ['animation', 'comet']);
  card.querySelectorAll('.lighting-fxcard').find((c) => c.querySelector('[data-i18n="lighting_fx_album"]')).click();
  await settle();
  assert.deepEqual(r.posts.pop().body, { id: dev.id, mode: 'album' });
  const running = r.window.LightingDevice.card(() => {}, status, { ...dev, mode: 'animation', modeAnim: { style: 'comet', palette: ['#ff0000'], speed: 50 } }, 'Pretend');
  await settle();
  assert.ok(keys(running).includes('lighting_fx_sets') && keys(running).includes('xmenu_pump_leds_reverse'));
  assert.ok(!keys(running).includes('lighting_chain'), 'one device has nothing to chain');
});

test('a group of LEDs keeps one colour and a speed', async () => {
  const r = rig();
  const nodes = r.window.LightingEffects.section({ look: { style: 'comet', color: '#ff0000', speed: 40 }, one: true, onPick() {}, onChange() {} });
  const all = nodes.flatMap((n) => keys(n));
  assert.ok(all.includes('lighting_anim_color') && all.includes('lighting_anim_speed'));
  for (const k of ['lighting_fx_sets', 'lighting_palette_colors', 'xmenu_pump_leds_reverse', 'light_fx_size_tail', 'xmenu_pump_leds_glow', 'lighting_chain']) assert.ok(!all.includes(k), 'no ' + k);
  assert.deepEqual(r.drawn.find((d) => d.look.effect === 'bands').look.colours.map(hex), ['#ff0000'], 'its colour on the other cards too');
});

test('on the map, the chosen LEDs get the cards of one colour and a speed, without what this PC cannot follow', async () => {
  const r = rig();
  const painted = [];
  const dev = { id: 'pretend-strip', model: 'Pretend Strip', source: 'icue', mode: 'custom', modeLeds: { 1: { style: 'comet', color: '#ff0000', speed: 50 } },
    segments: [{ kind: 'strip', ledIds: [1, 2] }] };
  const map = r.window.LightingMap.build(dev, { onPaint: (p) => painted.push(p), cannot: ['sound'] });
  map.querySelector('.lighting-part-name').click();
  map.querySelectorAll('.settings-segment-btn').find((b) => b.getAttribute('data-i18n') === 'lighting_show_effect').click();
  await settle();
  const all = keys(map);
  assert.ok(all.includes('light_fx_comet') && !all.includes('light_fx_beat'), 'the cards, without sound here');
  assert.ok(all.includes('lighting_anim_color') && !all.includes('lighting_fx_sets') && !all.includes('xmenu_pump_leds_reverse'), 'one colour and a speed');
  cardOf(map, 'orbit').click();
  await settle();
  assert.equal(painted.pop()[1].style, 'orbit', 'a card paints the chosen LEDs');
});

// A pretend device: a fan of 8 LEDs and a strip of 4.
const FAN = [11, 12, 13, 14, 15, 16, 17, 18];
const STRIP = [21, 22, 23, 24];
const mapOf = (r, mode, extra) => r.window.LightingMap.build({ id: 'pretend-fans', model: 'Pretend Fans', source: 'icue', mode, ...extra,
  segments: [{ kind: 'fan', ledIds: FAN }, { kind: 'strip', ledIds: STRIP }] }, { onPaint() {} });
const fills = (map, ids) => ids.map((id) => map.querySelectorAll('.lighting-led').find((c) => c.dataset.luid === String(id)).style.fill);
const rgbOf = (c) => `rgb(${c.r},${c.g},${c.b})`;

test("on the map the LEDs move with the device's effect, each part in its own shape, as the lights draw it", async () => {
  const r = rig();
  const anim = { style: 'comet', palette: ['#ff0000', '#0000ff'], speed: 70 };
  const map = mapOf(r, 'animation', { modeAnim: anim });
  await settle();
  const run = r.runs.at(-1);
  assert.ok(run && typeof run.tick === 'function', "a moving effect runs on the cards' loop");
  run.tick(5000, {});
  const fx = Fx.lightingLook(anim);
  const want = (shape, n) => Device.drawPart(fx, anim, { shape, at: Array.from({ length: n }, (_, i) => i) }, { now: 5000, inputs: {}, state: {} }).map(rgbOf);
  assert.deepEqual(fills(map, FAN), want('ring', 8), 'the fan as a ring');
  assert.deepEqual(fills(map, STRIP), want('line', 4), 'the strip as a line');
  run.tick(5600, {});
  assert.notDeepEqual(fills(map, FAN), want('ring', 8), 'and it moves');
});

test('on the map a group of LEDs moves with its own effect, the rest keep their colour; a still look or a colour does not run', async () => {
  const r = rig();
  const breathe = { style: 'breathe', color: '#00ff00', speed: 50 };
  const red = { ...breathe, color: '#ff0000' };
  const leds = Object.fromEntries([...FAN.map((id) => [id, breathe]), [21, '#ff0000'], [22, red], [23, red], [24, red]]);
  const map = mapOf(r, 'custom', { modeLeds: leds });
  await settle();
  r.runs.at(-1).tick(1234, {});
  const fan = fills(map, FAN);
  assert.ok(fan.every((c) => c === fan[0] && c.startsWith('rgb(')), 'the fan breathes as one, drawn');
  assert.equal(fills(map, [21])[0], '#ff0000', 'a LED with a colour keeps it');
  const strip = fills(map, [22, 23, 24]);
  assert.ok(strip.every((c) => c === strip[0]) && strip[0] !== fan[0], 'the same effect in another colour is a group of its own');
  const still = mapOf(r, 'animation', { modeAnim: { style: 'still', palette: ['#ff0000', '#0000ff'] } });
  await settle();
  assert.equal(r.runs.at(-1).tick, null, 'nothing runs for a look that stands still');
  assert.ok(fills(still, FAN).includes('rgb(255,0,0)') && fills(still, FAN).includes('rgb(0,0,255)'), 'its colours drawn once');
  mapOf(r, 'color', { modeColor: '#123456' });
  await settle();
  assert.equal(r.runs.at(-1).tick, null, 'a colour runs nothing');
});

test('the cards and the engine load the first time a page shows effects, the engine only once', async () => {
  const r = rig({ cards: false, engine: false });
  const box = r.window.LightingUI.effectCards({ look: { style: 'none' }, onPick() {}, onChange() {} });
  const asked = () => r.document.head.children.map((s) => s.src);
  for (let i = 0; i < 9; i++) {
    await settle();
    const s = r.document.head.children[i];
    assert.ok(s, 'script ' + i + ' asked');
    if (s.src.endsWith('light-fx-preview.js')) { r.window.LightFx = Fx; r.window.LightFxPreview = { mount: () => true, run() {} }; }
    if (PAGE[s.src]) vm.runInContext(PAGE[s.src], vm.createContext({ window: r.window, document: r.document, console }));
    s.onload();
    await settle();
  }
  assert.deepEqual(asked(), ['js/light-fx/light-fx-colour.js', 'js/light-fx/light-fx-calm.js', 'js/light-fx/light-fx-moving.js', 'js/light-fx/light-fx-pc.js',
    'js/light-fx/light-fx.js', 'js/light-fx/light-fx-preview.js', ...Object.keys(PAGE)]);
  assert.ok(box.querySelector('.lighting-fxcard'), 'the box filled once they loaded');
  const menuFirst = rig({ cards: false });
  menuFirst.window.LightingUI.effectCards({ look: { style: 'none' }, onPick() {}, onChange() {} });
  await settle();
  assert.deepEqual(menuFirst.document.head.children.map((s) => s.src), [Object.keys(PAGE)[0]], 'the engine the Xenon menu loaded stays');
  const broken = rig({ cards: false, engine: false });
  const failed = broken.window.LightingUI.effectCards({ look: { style: 'none' }, onPick() {}, onChange() {} });
  await settle();
  broken.document.head.children[0].onerror();
  await settle(20);
  assert.ok(failed.querySelector('[data-i18n="lighting_fx_unavailable"]'), 'a line says the effects did not load');
});

test('the words of the cards are in every app language', () => {
  const words = ['lighting_fx_sets', 'lighting_fx_tune', 'lighting_chain', 'lighting_chain_together', 'lighting_chain_after', 'lighting_fx_unavailable',
    'lighting_palette_colors', 'lighting_anim_none', 'lighting_fx_temperature', 'lighting_fx_album', ...Fx.GROUPS.map((g) => 'light_fx_group_' + g),
    ...Fx.LIGHTING.flatMap((id) => ['light_fx_' + id, 'light_fx_' + id + '_sub'])];
  for (const lang of LANGS) {
    const text = readFileSync(new URL(`../js/i18n/${lang}.js`, import.meta.url), 'utf8');
    const missing = words.filter((k) => !new RegExp(`^\\s+${k}:`, 'm').test(text));
    assert.deepEqual(missing, [], lang);
  }
});
