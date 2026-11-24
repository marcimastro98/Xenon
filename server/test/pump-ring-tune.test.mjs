// How a pump's ring of lights is tuned beyond its effect: a speed anywhere from 1 to 100 (the old
// three names still read), how much of the effect (size), how lit its dark part stays (glow) and
// a palette ready made for colours of the person's own. Saved by the model (js/pump/pump-model.js),
// refused when wrong (pump-screen/edit.js), told to the lights (pump-screen/ring.js), painted
// (lights/pump-ring.js), and offered in the menu's Lights tab only where an effect on show uses it
// (menu/menu-pump-tune.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Model = require('../js/pump/pump-model.js');
const Edit = require('../pump-screen/edit.js');
const RingFx = require('../js/pump/ring-effects.js');
const { createPumpRing } = require('../pump-screen/ring.js');
const lights = require('../lights/pump-ring.js');
const { pumpViews } = require('../menu/menu-pump.js');

const leds = (raw) => Model.normalizeScreen({ leds: raw }).leds;

test('the model keeps a speed 1..100, amounts 0..1 in hundredths and a palette it knows', () => {
  assert.equal(leds({ speed: 40 }).speed, 40);
  assert.equal(leds({ speed: 'slow' }).speed, 'slow', 'a save from before the slider');
  for (const bad of [0, 101, 40.5, '40', null]) assert.equal(leds({ speed: bad }).speed, 'normal', String(bad));
  assert.deepEqual([leds({ size: 0.333 }).size, leds({ size: 2 }).size, leds({ size: -1 }).size, leds({ size: 'x' }).size], [0.33, 1, 0, null]);
  assert.deepEqual([leds({ glow: 0.256 }).glow, leds({}).glow], [0.26, null]);
  assert.deepEqual([leds({ palette: 'ocean' }).palette, leds({ palette: 'mars' }).palette], ['ocean', null]);
});

test('an edit with a wrong amount, speed or palette is said back with its choices', () => {
  const model = Model.normalize({ screens: { pump: {} } });
  const set = (l) => Edit.patchScreen(model, 'pump', { leds: l });
  assert.equal(Model.screenFor(set({ speed: 40, size: 0.8, glow: 0, palette: 'lava' }).model, 'pump').leds.size, 0.8);
  assert.deepEqual(set({ speed: 101 }), { error: 'bad_speed', choices: [...Model.LED_SPEEDS, '1..100'] });
  assert.deepEqual(set({ size: 1.5 }), { error: 'bad_size', choices: ['0..1', null] });
  assert.deepEqual(set({ glow: 'more' }), { error: 'bad_glow', choices: ['0..1', null] });
  assert.deepEqual(set({ palette: 'mars' }), { error: 'bad_palette', choices: Model.LED_PALETTES });
  const back = Edit.patchScreen(set({ size: 0.8, palette: 'lava' }).model, 'pump', { leds: { size: null, palette: null } }).model;
  assert.deepEqual([Model.screenFor(back, 'pump').leds.size, Model.screenFor(back, 'pump').leds.palette], [null, null], 'null puts them back');
});

test('the lights hear the amounts only when set, and a palette as its colours', () => {
  const told = [];
  const model = (l) => Model.normalize({ screens: { pump: { leds: { follow: 'own', move: 'comet', ...l } } } });
  let current = model({});
  const ring = createPumpRing({ store: { peek: () => current }, setRing: (s) => told.push(s) });
  ring.refresh();
  assert.equal('size' in told.at(-1) || 'glow' in told.at(-1), false, 'as made: nothing to say');
  assert.deepEqual(told.at(-1).colours, ['#00e5ff', '#ff2e88'], 'their two');
  current = model({ size: 0.8, glow: 0.3, palette: 'ocean', speed: 40 });
  ring.refresh();
  const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('');
  assert.deepEqual(told.at(-1).colours, RingFx.PALETTES.ocean.map(hex));
  assert.deepEqual([told.at(-1).size, told.at(-1).glow, told.at(-1).speed], [0.8, 0.3, 40]);
});

test('the painted ring follows its amount, its dark part and a speed on the slider', () => {
  const lit = (frame) => frame.filter((c) => Math.max(c.r, c.g, c.b) > 40).length;
  const paint = (o) => {
    lights.set({ follow: 'own', effect: 'comet', colours: ['#ff0000'], speed: 50, ...o });
    return lights.frame(null, 24, 10_000);
  };
  assert.ok(lit(paint({ size: 0.9 })) > lit(paint({ size: 0.1 })), 'a longer tail lights more of the ring');
  const darkest = (frame) => Math.min(...frame.map((c) => c.r));
  assert.ok(darkest(paint({ glow: 0.5 })) > darkest(paint({ glow: 0 })), 'a lit dark part');
  assert.notDeepEqual(paint({ speed: 90 }), paint({ speed: 10 }), 'the slider changes where the comet is');
  lights.set({ follow: 'own', effect: 'comet', colours: ['#ff0000'], speed: 'warp', size: 'big' });
  assert.ok(Array.isArray(lights.frame(null, 24, 0)), 'wrong values paint as made');
  lights.set(null);
});

const view = (l, extra = {}, pump = {}) => {
  const screen = { screen: 'pump', ...Model.screenFor({ screens: { pump: { leds: l, ...extra } }, seen: {} }, 'pump'), set: true, seen: null, now: null };
  const st = { probes: {}, pump: { icue: true, sound: true, detected: [], url: '', screens: [screen], ...pump } };
  return pumpViews(st)[0].tabs.find((tab) => tab.id === 'leds').rows;
};
const row = (rows, id) => rows.find((r) => r.id === id);
const patch = (act) => JSON.parse(act.run.patch);
const still = { leds: 'still' };

test('the Lights tab offers only what the effects on show use, named as they call it', () => {
  const rows = view({ follow: 'screen', move: 'comet', speed: 'slow' });
  assert.deepEqual(rows.filter((r) => /^pump-leds-(speed|reverse|size|glow)$/.test(r.id)).map((r) => r.id), ['pump-leds-speed', 'pump-leds-reverse', 'pump-leds-size', 'pump-leds-glow']);
  const speed = row(rows, 'pump-leds-speed');
  assert.equal(speed.value, '30', 'slow sits on its place');
  assert.deepEqual(patch(speed.options.find((o) => o.value === '12').act), { leds: { speed: 12 } });
  assert.deepEqual(row(rows, 'pump-leds-size').label, { key: 'light_fx_size_tail' }, 'a comet\'s amount is its tail');
  assert.deepEqual(patch(row(rows, 'pump-leds-glow').options.find((o) => o.value === 'auto').act), { leds: { glow: null } });
  const calm = view({ follow: 'screen', move: 'still' }, { base: { face: 'sensors', ...still }, moments: [] });
  assert.equal(calm.some((r) => /^pump-leds-(speed|reverse|size|glow)$/.test(r.id)), false, 'nothing moves: nothing to tune');
});

test('each effect card says what it does and is drawn as the ring is set', () => {
  const rows = view({ follow: 'own', palette: 'neon', move: 'comet', speed: 72, size: 0.8 });
  const comet = rows.filter((r) => r.id.startsWith('pump-leds-move')).flatMap((r) => r.cards).find((c) => c.value === 'comet');
  assert.deepEqual(comet.sub, { key: 'light_fx_comet_sub' });
  assert.equal(comet.look.effect, 'comet');
  assert.deepEqual([comet.look.speed, comet.look.size, comet.look.colours.length], [72, 0.8, RingFx.PALETTES.neon.length]);
  const lead = rows.find((r) => r.id === 'pump-leds-move').cards[0];
  assert.deepEqual([lead.value, lead.sub, 'look' in lead], ['style', { key: 'xmenu_pump_ring_style_sub' }, false]);
});

test('colours of the person\'s own: their two or a palette, each card a ring in them', () => {
  const rows = view({ follow: 'own', palette: 'lava' });
  const palettes = row(rows, 'pump-leds-palette');
  assert.deepEqual(palettes.cards.map((c) => c.value), ['mine', ...Model.LED_PALETTES]);
  assert.equal(palettes.value, 'lava');
  assert.deepEqual(patch(palettes.cards.find((c) => c.value === 'mine').act), { leds: { palette: null } });
  assert.equal(palettes.cards.find((c) => c.value === 'lava').act, null, 'the one on needs no tap');
  assert.equal(row(rows, 'pump-leds-colors'), undefined, 'no pickers while a palette paints it');
  assert.equal(row(view({ follow: 'screen' }), 'pump-leds-palette'), undefined, 'only for colours of its own');
});

test('what the PC follows reaches the ring, and an effect it cannot follow is not offered', () => {
  const { cpuRead } = require('../system/cpu-usage-state.js');
  const at = (usage) => { cpuRead.usage = usage; return lights.frame(null, 24, 10_000); };
  lights.set({ follow: 'own', effect: 'load', colours: ['#00ff00'] });
  assert.notDeepEqual(at(5), at(95), 'the load effect warms with the processor');
  lights.set(null);
  const offered = (pump) => {
    const all = (rows) => rows.flatMap((r) => [...(r.cards || []), ...all(r.rows || [])]);
    return new Set(all(view({ follow: 'own', move: 'comet' }, {}, pump)).map((c) => c.value));
  };
  assert.ok(offered({}).has('fans'));
  assert.equal(offered({ cannot: ['fans'] }).has('fans'), false, 'no fans read here: not on the whole ring nor on a line');
  assert.ok(offered({ cannot: ['fans'] }).has('load'));
  assert.equal(offered({ sound: false }).has('beat'), false);
});
