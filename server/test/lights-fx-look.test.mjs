// Settings -> Lighting drawn with the one effect engine (lights/fx-look.js, js/light-fx/light-fx.js):
// the names saved before the list read as the effect each became, every device is drawn part by
// part in its shape, "one after another" puts the parts out of step, the settings keep the new
// knobs on both sides, and a device that follows Xenon really gets the frame LED by LED.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from './browser-source.mjs';

const require = createRequire(import.meta.url);
// Never the real iCUE: a busy one would hang the run and the test would drive real lights.
const fs = require('fs');
const realExists = fs.existsSync;
fs.existsSync = (p) => !String(p).endsWith('iCUESDK.x64_2019.dll') && realExists(p);

const LightFx = require('../js/light-fx/light-fx.js');
const FxLook = require('../lights/fx-look.js');
const Fields = require('../lights/look-fields.js');
const audioLevels = require('../audio/audio-levels.js');
const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..');
const key = (c) => (c ? `${c.r},${c.g},${c.b}` : '-');
const fan = (from, n) => ({ kind: 'fan', ledIds: Array.from({ length: n }, (_, i) => from + i) });
const device = (id, segments) => ({ id, segments, ledIds: segments.flatMap((s) => s.ledIds) });

test('the Lighting list: every effect but those that follow a line\'s reading, and the old names', () => {
  for (const e of LightFx.LIST) assert.equal(LightFx.LIGHTING.includes(e.id), e.needs !== 'level', e.id);
  for (const s of ['none', 'solid', 'breathing', 'cycle', 'wave', 'aurora', 'candle', 'palette', ...LightFx.LIGHTING]) assert.ok(Fields.isStyle(s), s);
  assert.ok(!Fields.isStyle('level') && !Fields.isStyle('heat') && !Fields.isStyle('nope'));
  for (const old of Object.keys(LightFx.OLD_LIGHTING)) assert.ok(LightFx.isEffect(LightFx.OLD_LIGHTING[old]), old);
});

test('a look as an effect: the old names keep their colours, the new ones take the palette', () => {
  const hex = (l) => l.colours.map((c) => '#' + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join(''));
  const pal = ['#112233', '#445566'];
  assert.equal(LightFx.lightingLook({ style: 'none' }), null);
  assert.equal(LightFx.lightingLook({ style: 'level' }), null);
  assert.deepEqual(LightFx.lightingLook({ style: 'breathing', color: '#ff0000', palette: pal }), { effect: 'breathe', colours: [{ r: 255, g: 0, b: 0 }] });
  assert.equal(LightFx.lightingLook({ style: 'cycle' }).colours.length, 6, 'the old cycle is still a rainbow');
  assert.equal(LightFx.lightingLook({ style: 'wave' }).effect, 'rainbow');
  assert.deepEqual(LightFx.lightingLook({ style: 'aurora', color: '#ff0000' }).colours, [...LightFx.PALETTES.aurora], 'the aurora keeps its own colours');
  assert.deepEqual(hex(LightFx.lightingLook({ style: 'palette', palette: pal })), pal);
  assert.deepEqual(hex(LightFx.lightingLook({ style: 'candle' })), ['#ff9329'], 'a candle with no colour is warm');
  const warm = ['#ff3d1f', '#ffb347'];
  assert.deepEqual(hex(LightFx.lightingLook({ style: 'aurora', color: '#FF3D1F', palette: warm })), warm, 'an aurora takes the colours chosen for it');
  assert.deepEqual(hex(LightFx.lightingLook({ style: 'candle', color: '#ff3d1f', palette: warm })), warm, 'so does a candle');
  assert.deepEqual(LightFx.lightingLook({ style: 'aurora', color: '#1ed760', palette: ['#1ed760', '#0066ff'] }).colours, [...LightFx.PALETTES.aurora], 'one saved untouched keeps its own');
  assert.deepEqual(hex(LightFx.lightingLook({ style: 'candle', color: '#ff9329', palette: ['#1ed760', '#0066ff'] })), ['#ff9329'], 'a candle saved before keeps its one colour');
  assert.deepEqual(hex(LightFx.lightingLook({ style: 'comet', color: '#ff0000', palette: pal })), pal);
  assert.deepEqual(hex(LightFx.lightingLook({ style: 'comet', color: '#ff0000' })), ['#ff0000']);
});

test('a device in parts: fans and each ring of a pump closed, strips open, zones one line, keys left to right', () => {
  const pump = { kind: 'pump', ledIds: Array.from({ length: 6 }, (_, i) => 100 + i), rings: [4, 2] };
  const keys = { kind: 'pos', ledIds: [200, 201, 202], pos: [[50, 0], [0, 0], [100, 0]] };
  const dev = device('d1', [fan(1, 4), { kind: 'strip', ledIds: [10, 11, 12] }, pump, { kind: 'zone', ledIds: [20] }, { kind: 'zone', ledIds: [21] }, keys]);
  const parts = FxLook.partsOf(dev);
  assert.deepEqual(parts.map((p) => `${p.shape}${p.at.length}`), ['ring4', 'line3', 'ring4', 'ring2', 'line2', 'line3']);
  assert.deepEqual(parts.at(-1).x, [0.5, 0, 1]);
  assert.deepEqual(FxLook.partsOf({ id: 'bare', ledIds: [1, 2, 3] }).map((p) => p.shape + p.at.length), ['line3'], 'no parts: one strip');
});

test('together or one after another, brightness and direction', () => {
  const a = device('a', [fan(1, 8)]);
  const b = device('b', [fan(11, 8)]);
  const look = { style: 'breathe', palette: ['#ff0000'], speed: 50 };
  const together = FxLook.pass(look, [a, b], 2000, 1);
  assert.deepEqual(together(a).map(key), together(b).map(key), 'together: both fans the same');
  const chained = FxLook.pass({ ...look, chain: true }, [a, b], 2000, 1);
  assert.notDeepEqual(chained(a).map(key), chained(b).map(key), 'one after another: the second fan runs later');
  const half = FxLook.pass(look, [a], 2000, 0.5)(a)[0];
  const full = together(a)[0];
  assert.ok(Math.abs(half.r - full.r / 2) <= 1, 'brightness applied');
  const comet = { style: 'comet', palette: ['#00ff00'], speed: 50 };
  const fwd = FxLook.pass(comet, [a], 777, 1)(a).map(key);
  const back = FxLook.pass({ ...comet, reverse: true }, [a], 777, 1)(a).map(key);
  assert.deepEqual(back, fwd.map((_, i) => fwd[(8 - i) % 8]), 'reverse mirrors the ring');
  assert.equal(FxLook.pass({ style: 'none' }, [a], 0, 1), null);
});

test('one colour for a single-colour light; what moves and what hears', (t) => {
  assert.equal(FxLook.colourAt({ style: 'none' }), null);
  assert.notDeepEqual(FxLook.colourAt({ style: 'cycle' }, 1000), FxLook.colourAt({ style: 'cycle' }, 9000), 'the old cycle still changes colour');
  assert.ok(FxLook.moves({ style: 'wave' }) && !FxLook.moves({ style: 'still' }) && !FxLook.moves({ style: 'solid' }));
  assert.ok(FxLook.hears({ style: 'beat' }) && !FxLook.hears({ style: 'comet' }));
  t.mock.method(audioLevels, 'available', () => false);
  assert.ok(!FxLook.moves({ style: 'beat' }), 'no sound reader here: a beat stands still');
});

test('the knobs of a look: kept when set, given back with null, chain only for all the lights', () => {
  assert.deepEqual(Fields.extrasOf({ reverse: true, size: 0.333, glow: 7, chain: true, x: 1 }), { reverse: true, size: 0.33, glow: 1 });
  assert.deepEqual(Fields.extrasOf({ chain: false, size: 'big' }, true), { chain: false });
  const cur = { style: 'comet', size: 0.5, chain: true };
  assert.deepEqual(Fields.mergeExtras(cur, { size: null, chain: null, glow: 0.2 }, true), { style: 'comet', glow: 0.2 });
});

test('the page keeps what the server keeps: every name, one colour, the knobs', () => {
  const Server = require('../lights/settings-normalize.js');
  const src = readFileSync(join(SERVER, 'js', 'settings/settings.js'), 'utf8');
  const pick = (name) => src.match(new RegExp('\\nfunction ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'))[0];
  const ctx = {};
  vm.runInNewContext(['clampNumber', 'normalizeLightingAnimation'].map(pick).join('\n') + '\nthis.fn = normalizeLightingAnimation;', ctx);
  for (const s of Fields.STYLES) assert.equal(ctx.fn({ style: s }, { style: null }).style, s, `the page reads "${s}"`);
  const Devices = require('../lights/devices-normalize.js');
  const asDevice = (anim) => Devices.normalizeLightingDeviceModes({ d: { mode: 'animation', anim } }).d.anim;
  for (const v of [{ style: 'comet', palette: ['#ff0000'], size: 0.25, reverse: true, chain: true, speed: 70 }, { style: 'breathing', color: '#00ff00' }, { style: 'turn', palette: [] }, { style: 'none', glow: 2 }]) {
    assert.deepEqual(JSON.parse(JSON.stringify(ctx.fn(v))), Server.normalizeLightingAnimation(v), JSON.stringify(v));
    assert.deepEqual(JSON.parse(JSON.stringify(ctx.fn(v, null, true))), asDevice(v), 'a device: ' + JSON.stringify(v));
  }
});

test('a fan that follows Xenon gets the effect LED by LED, and two fans can go one after another', async (t) => {
  const lighting = require('../lights/lighting.js');
  const native = require('../lighting-native');
  const board = device('fx-board-test', [fan(65536, 8), fan(65544, 8)]);
  board.type = 0x200;
  board.source = 'native';
  const frames = [];
  t.mock.method(native, 'devices', () => [board]);
  t.mock.method(native, 'hasDevices', () => true);
  t.mock.method(native, 'owns', () => true);
  t.mock.method(native, 'write', (_dev, colors) => { frames.push(colors.map(key)); });
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  t.after(() => { lighting.setEnabled(false); lighting.setAnimation({ style: 'none', chain: null }); });

  lighting.setAnimation({ style: 'comet', palette: ['#ff0000'] });
  lighting.setEnabled(true);
  await settle();
  const f = frames.at(-1);
  assert.equal(f.length, 16);
  assert.ok(new Set(f.slice(0, 8)).size > 2, 'the comet has a head and a tail, not one colour');
  assert.ok(f.every((c) => /^\d+,0,0$/.test(c)), 'in the look\'s red');
  assert.deepEqual(f.slice(0, 8), f.slice(8), 'together: both fans the same');
  lighting.setAnimation({ style: 'breathe', chain: true });
  await settle();
  const g = frames.at(-1);
  assert.notDeepEqual(g.slice(0, 8), g.slice(8), 'one after another');
  assert.equal(lighting.getConfig().animation.chain, true);
});

test('LEDs of a map sharing an effect: a fan they fill whole goes round as a ring', () => {
  const { ledFrame } = require('../lights/lighting-led-colors.js');
  const dev = device('map', [fan(1, 8), fan(9, 8)]);
  const comet = { style: 'comet', color: '#ff0000', speed: 50 };
  const leds = Object.fromEntries(dev.ledIds.slice(0, 8).map((id) => [id, comet]));
  const out = ledFrame(dev.ledIds, leds, { dev, follow: { r: 0, g: 0, b: 9 }, brightness: 1, nowMs: 777 });
  assert.deepEqual(out.slice(0, 8).map(key), FxLook.pass(comet, [dev], 777, 1)(dev).slice(0, 8).map(key));
  assert.ok(out.slice(8).every((c) => key(c) === '0,0,9'), 'the other fan follows Xenon');
});

test('Bit knows every Lighting effect and sets its knobs; a name it does not know is an error', async (t) => {
  const lighting = require('../lights/lighting.js');
  const { branches } = require('../lights/tools.js');
  const { lightingAiFunctions } = require('../ai/core-tools-lighting.js');
  const tool = lightingAiFunctions().find((f) => f.name === 'set_animation');
  for (const id of LightFx.LIGHTING) assert.match(tool.description, new RegExp(`\\b${id}\\b`), id);
  for (const k of ['reverse', 'size', 'glow', 'chain', 'palette']) assert.ok(tool.parameters.properties[k], k);
  t.after(() => lighting.setAnimation({ style: 'none', reverse: null, size: null, glow: null, chain: null }));
  const saved = async () => {};
  const ok = await branches.set_animation({ fnArgs: { style: 'comet', palette: '#ff0000, blu', reverse: true, size: 0.4, glow: '0.1', chain: true } }, { _persistLighting: saved });
  assert.equal(ok.ok, true);
  assert.deepEqual({ ...ok.animation, speed: undefined, color: undefined },
    { style: 'comet', palette: ['#ff0000', '#0000ff'], reverse: true, size: 0.4, glow: 0.1, chain: true, speed: undefined, color: undefined });
  const bad = await branches.set_animation({ fnArgs: { style: 'disco' } }, { _persistLighting: saved });
  assert.equal(bad.error, 'invalid_animation');
  assert.equal(lighting.getConfig().animation.style, 'comet', 'nothing changed');
});

test('the Deck key offers the whole list, keeps the names saved before it, refuses a name it does not know', () => {
  const Deck = require('../js/deck/deck-actions.js');
  const style = Deck.actionSpec('lightEffect').params.find((p) => p.name === 'style');
  assert.deepEqual(style.options, ['none', ...LightFx.LIGHTING], 'the copy in deck-actions.js is the engine\'s list');
  for (const old of style.keeps) assert.ok(Object.hasOwn(LightFx.OLD_LIGHTING, old) && style.optionKeys[old], old);
  assert.equal(Deck.validateAction({ type: 'lightEffect', style: 'breathing' }).style, 'breathing');
  assert.equal(Deck.validateAction({ type: 'lightEffect', style: 'disco' }), null, 'never quietly "none"');
  const words = (lang) => readFileSync(join(SERVER, 'js', 'i18n', lang + '.js'), 'utf8');
  for (const lang of ['de', 'en', 'es', 'fr', 'it', 'ja', 'ko', 'nl', 'pt', 'ru', 'zh']) {
    const text = words(lang);
    // The names on offer in every language; the old ones may read in English, as a gap does.
    const keys = lang === 'en' ? Object.values(style.optionKeys) : style.options.map((o) => style.optionKeys[o]);
    for (const key of keys) assert.ok(text.includes(`
  ${key}:`), `${lang} ${key}`);
  }
});
