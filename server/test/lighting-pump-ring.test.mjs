// The ring of lights around a pump screen (lights/pump-ring.js, set by pump-screen/ring.js)
// against a pretend iCUE SDK: with Xenon's lights off it paints only the pump's LEDs and hands
// every other light back to iCUE; with them on, the ring keeps the screen's colours over Xenon's
// colour; the theme and dark choices, "every other light too", a flash over the ring, a device
// left out, and giving the ring back. Only what the bridge says to the SDK is read here.
//
// No real device is touched: the pretend SDK is in the bridge before lighting.js is required
// (pretend-icue-sdk.mjs), and its devices are a keyboard and a cooler (its one channel holds the
// pump head and a fan, as a Commander says), never a motherboard.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pretendSdk } from './pretend-icue-sdk.mjs';

const require = createRequire(import.meta.url);
const { bridge } = require('../lights/bridge-state.js');

const KEYBOARD = 0x1;
const COOLER = 0x100;
const PUMP_HEAD = 9;
const HD_FAN = 1;
const ledBase = (id) => (id === 'pretend-keys' ? 100 : 300);
const DEVICES = [
  { type: KEYBOARD, id: 'pretend-keys', serial: '', model: 'Pretend Keys', ledCount: 4, channelCount: 0 },
  { type: COOLER, id: 'pretend-pump', serial: '', model: 'Pretend Pump', ledCount: 5, channelCount: 1 },
];
const CHANNELS = { 'pretend-pump': [{ ledCounts: [3, 2], types: [PUMP_HEAD, HD_FAN] }] };

assert.equal(bridge.lib, null, 'nothing loaded the real SDK before the pretend one is in place');
const sdk = pretendSdk({ devices: DEVICES, ledBase, channels: CHANNELS });
bridge.lib = { pretend: true };
bridge.koffi = sdk.koffi;
bridge.fns = sdk.fns;
const lighting = require('../lights/lighting.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(cond, what, ms = 6000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`waited ${ms}ms for: ${what}`);
    await sleep(5);
  }
}
async function quiet() {
  for (let same = 0, seen = -1; same < 3;) {
    await sleep(15);
    same = sdk.log.length === seen && !bridge.applyInFlight && !bridge.enumerating ? same + 1 : 0;
    seen = sdk.log.length;
  }
}
const mark = () => sdk.log.length;
const writes = (from, id) => sdk.log.slice(from).filter((call) => call.fn === 'setLedColors' && call.id === id);
const lastWrite = (id) => writes(0, id).at(-1);
// A device's last frame as 'r,g,b,a' per LED.
const frame = (id) => lastWrite(id).colors.map((c) => `${c.r},${c.g},${c.b},${c.a}`);
const ring = () => frame('pretend-pump').slice(0, 3);
const fan = () => frame('pretend-pump').slice(3);
const BACK = '0,0,0,0';
const RED = '#ff0000';
const BLUE = '#0000ff';

after(async () => {
  lighting.setPumpRing(null);
  lighting.applyConfig({ enabled: false, effects: { timer: false } });
  lighting.disconnect();
  await quiet();
});

test('a ring with nothing to show yet does not wake the lights', async () => {
  lighting.applyConfig({ enabled: false, pauseDuringGame: false, brightness: 1, devices: {} });
  lighting.setPumpRing({ follow: 'screen', all: false, colours: [] });
  await quiet();
  assert.deepEqual(sdk.log.filter((call) => call.fn === 'connect'), [], 'no session for a ring without colours');
});

test('with Xenon\'s lights off, only the pump\'s LEDs take the screen\'s colours', async () => {
  lighting.setPumpRing({ follow: 'screen', all: false, colours: [RED, BLUE] });
  await until(() => writes(0, 'pretend-pump').some((call) => call.colors[0].a === 255), 'the ring painted');
  await quiet();
  assert.deepEqual(ring(), ['255,0,0,255', '127,0,255,255', '127,0,255,255'], 'red round to blue and back, a full purple between: no seam where the ring closes');
  assert.deepEqual(fan(), [BACK, BACK], 'the fan on the same channel is left to iCUE');
  assert.ok(writes(0, 'pretend-keys').length, 'the keyboard was handed back on the way in');
  assert.ok(frame('pretend-keys').every((c) => c.endsWith(',0')), 'and left to iCUE: alpha 0 only');
});

test('new colours rewrite the ring and nothing else', async () => {
  const from = mark();
  lighting.setPumpRing({ follow: 'screen', all: false, colours: [BLUE] });
  await until(() => writes(from, 'pretend-pump').length, 'the ring repainted');
  await quiet();
  assert.deepEqual(ring(), Array(3).fill('0,0,255,255'));
  assert.deepEqual(fan(), [BACK, BACK]);
  assert.equal(writes(from, 'pretend-keys').length, 0, 'the keyboard is not written again');
  const again = mark();
  lighting.setPumpRing({ follow: 'screen', all: false, colours: [BLUE] });
  await quiet();
  assert.equal(sdk.log.length, again, 'the same colours say nothing to the SDK');
});

test('the theme colour, dark, and a device left out', async () => {
  lighting.applyConfig({ accent: { r: 0, g: 200, b: 100 } });
  lighting.setPumpRing({ follow: 'theme', all: false, colours: [] });
  await until(() => frame('pretend-pump')[0] === '0,200,100,255', 'the ring in the theme colour');
  lighting.setPumpRing({ follow: 'off', all: false, colours: [] });
  await until(() => frame('pretend-pump')[0] === '0,0,0,255', 'the ring dark');
  await quiet();
  const from = mark();
  lighting.applyConfig({ devices: { 'pretend-pump': false } });
  lighting.setPumpRing({ follow: 'screen', all: false, colours: [RED] });
  await quiet();
  assert.ok(writes(from, 'pretend-pump').every((call) => call.colors.every((c) => c.a === 0)), 'a device left out is never painted');
  lighting.applyConfig({ devices: {} });
  await until(() => frame('pretend-pump')[0] === '255,0,0,255', 'painted again once let back in');
});

test('with Xenon\'s lights on, the ring keeps the screen and the rest Xenon\'s colour', async () => {
  lighting.applyConfig({ enabled: true, manualColor: '#00ff00' });
  await until(() => frame('pretend-keys')[0] === '0,255,0,255', 'the keyboard in Xenon\'s colour');
  await quiet();
  assert.deepEqual(ring(), Array(3).fill('255,0,0,255'), 'the ring still shows the screen');
  assert.deepEqual(fan(), Array(2).fill('0,255,0,255'), "the fan beside it takes Xenon's colour");
  lighting.setPumpRing({ follow: 'lights', all: false, colours: [] });
  await until(() => frame('pretend-pump')[0] === '0,255,0,255', 'following Xenon, the ring is like every light');
  lighting.applyConfig({ enabled: false });
  await until(() => frame('pretend-pump')[0].endsWith(',0') && frame('pretend-keys')[0].endsWith(',0'), 'everything handed back');
  await quiet();
});

test('"every other light too" paints the whole PC in the screen\'s colour', async () => {
  lighting.setPumpRing({ follow: 'screen', all: true, colours: [BLUE, RED] });
  await until(() => frame('pretend-keys')[0] === '0,0,255,255', 'the keyboard in the screen\'s first colour');
  await quiet();
  assert.deepEqual(ring(), ['0,0,255,255', '255,0,127,255', '255,0,127,255']);
  assert.deepEqual(fan(), Array(2).fill('0,0,255,255'), 'the fan too');
  lighting.setPumpRing({ follow: 'screen', all: false, colours: [BLUE, RED] });
  await until(() => frame('pretend-keys')[0].endsWith(',0'), 'the keyboard back to iCUE');
  await quiet();
});

test('the fan beside the ring keeps the cover gradient Xenon shows, not one flat colour', async () => {
  const fx = require('../lights/lighting-effects.js');
  lighting.applyConfig({ effects: { musicAlbum: true } });
  lighting.setAlbumColor(RED, [RED, BLUE]);
  await until(() => frame('pretend-keys')[0] === '255,0,0,255' && frame('pretend-keys')[3] === '0,0,255,255', 'the keyboard in the cover gradient');
  await quiet();
  const gradient = fx.paletteGradient([fx.parseColorName(RED), fx.parseColorName(BLUE)], 5).map((c) => `${c.r},${c.g},${c.b},255`);
  assert.deepEqual(fan(), gradient.slice(3), 'the fan takes its part of the gradient');
  assert.deepEqual(ring(), ['0,0,255,255', '255,0,127,255', '255,0,127,255'], 'the ring still shows the screen');
  lighting.clearAlbum();
  lighting.applyConfig({ effects: { musicAlbum: false } });
  await until(() => frame('pretend-keys')[0].endsWith(',0'), 'the keyboard back to iCUE');
  await quiet();
});

test('a flash takes the pump too, then the ring comes back', async () => {
  lighting.applyConfig({ effects: { timer: { enabled: true, color: '#ff00ff', style: 'solid', durationMs: 400 } } });
  await quiet();
  const from = mark();
  lighting.onEvent('timer');
  await until(() => writes(from, 'pretend-pump').some((call) => call.colors.every((c) => c.r === 255 && c.g === 0 && c.b === 255)), 'the flash on the pump');
  await until(() => frame('pretend-pump')[0] === '0,0,255,255', 'the ring back after the flash');
  lighting.applyConfig({ effects: { timer: false } });
  await quiet();
});

// The sound the reader last heard, as audio/audio-levels.js gives it; put back after each test.
const audio = require('../audio/audio-levels.js');
function pretendSound(t) {
  const real = { latest: audio.latest, isRunning: audio.isRunning, available: audio.available };
  let peaks = {};
  audio.latest = () => peaks;
  audio.isRunning = () => true;
  audio.available = () => true;
  t.after(() => Object.assign(audio, real));
  return (next) => { peaks = next; };
}
const red = () => Number(ring()[0].split(',')[0]);

test('a ring that pulses keeps the lights moving and breathes with the sound', async (t) => {
  const hear = pretendSound(t);
  hear({ player: 1 });
  lighting.setPumpRing({ follow: 'screen', all: false, effect: 'beat', colours: [RED] });
  await until(() => bridge.animTimer, 'the lights tick for the pulse');
  await until(() => red() === 255, 'loud: full colour');
  hear({ player: 0.01 });
  await until(() => red() < 140 && red() > 100, 'quiet: down toward the floor, never dark');
  lighting.setPumpRing({ follow: 'screen', all: false, effect: 'still', colours: [RED] });
  await until(() => !bridge.animTimer, 'no pulse: no ticking');
  await until(() => red() === 255, 'steady again');
});

test('where this PC cannot read the sound, a pulse asked for keeps the ring steady and the lights still', async (t) => {
  const pumpRing = require('../lights/pump-ring.js');
  const real = audio.available;
  audio.available = () => false;
  t.after(() => { audio.available = real; });
  lighting.setPumpRing({ follow: 'screen', all: false, effect: 'beat', colours: [RED] });
  await quiet();
  assert.equal(pumpRing.pulsing(), false, 'no pulse here');
  assert.equal(bridge.animTimer, null, 'no ticking for it');
  assert.equal(red(), 255, 'the ring in its colour');
  lighting.setPumpRing({ follow: 'screen', all: false, effect: 'still', colours: [RED] });
  await quiet();
});

test('turning the pulse on starts the sound reader while a page is open, and off stops it', async (t) => {
  const { sseClients } = require('../http/sse-clients.js');
  const real = { available: audio.available, start: audio.start, stop: audio.stop };
  const calls = [];
  const page = {};
  Object.assign(audio, { available: () => true, start: () => calls.push('start'), stop: () => calls.push('stop') });
  sseClients.add(page);
  t.after(() => { Object.assign(audio, real); sseClients.delete(page); });
  lighting.setPumpRing({ follow: 'screen', all: false, effect: 'beat', colours: [BLUE] });
  assert.equal(calls.at(-1), 'start');
  lighting.setPumpRing({ follow: 'screen', all: false, effect: 'still', colours: [BLUE] });
  assert.equal(calls.at(-1), 'stop');
  await quiet();
});

test('a ring in colours of its own, lit up to the reading: the LEDs past it dim, the fan as before', async () => {
  const rgb = (c) => c.split(',').map(Number);
  lighting.setPumpRing({ follow: 'own', all: false, effect: 'level', level: 0.5, colours: [RED, BLUE] });
  await until(() => ring()[0] === '255,0,0,255' && rgb(ring()[2])[2] < 60, 'the ring lit half way');
  await quiet();
  const [, middle, last] = ring().map(rgb);
  assert.ok(middle[0] > 110 && middle[0] < 160 && middle[0] === middle[2], `the LED the level ends in is lit as far as it reaches, half of a full purple (${middle})`);
  assert.ok(last[2] > 0 && last[2] < 60, `past the level: dim, so the scale still shows (${last})`);
  const before = fan();
  lighting.setPumpRing({ follow: 'own', all: false, effect: 'level', level: 1, colours: [RED, BLUE] });
  await until(() => ring()[2] === '0,0,255,255', 'the ring lit all the way');
  assert.deepEqual(fan(), before, 'the fan on the same channel is left as it was');
});

test('giving the ring back hands every light to iCUE', async () => {
  lighting.setPumpRing(null);
  await until(() => frame('pretend-pump').every((c) => c.endsWith(',0')), 'the pump handed back');
  await quiet();
  const from = mark();
  await sleep(150);
  assert.equal(sdk.log.length, from, 'nothing more is written');
});

test('the sound level: up at once, down by half every 180 ms, steady with no reader or after a silence', () => {
  const pumpRing = require('../lights/pump-ring.js');
  const T = 1e9;
  assert.equal(pumpRing.soundLevel(T, { a: 0.5 }, false) == null, false, 'a reading counts even as the reader stops');
  assert.equal(pumpRing.soundLevel(T + 1e6, {}, false), null, 'no reader: steady');
  assert.equal(pumpRing.soundLevel(T + 2e6, { a: 0.25, b: 0.75 }, true), 0.75, 'the loudest app');
  assert.equal(pumpRing.soundLevel(T + 2e6 + 180, {}, true), 0.375, 'half after 180 ms of a gap');
  assert.equal(pumpRing.soundLevel(T + 2e6 + 360, { a: 0.1 }, true), 0.1875, 'a quieter sound does not cut the fall short');
  assert.equal(pumpRing.soundLevel(T + 2e6 + 2361, {}, true), null, 'two seconds of silence: steady');
  assert.equal(pumpRing.soundLevel(T + 3e6, { a: 7 }, true), 1, 'never above 1');
});

test('a ring on the beat dims its colours with the sound, never under its floor; a dark ring has nothing to pulse', () => {
  const pumpRing = require('../lights/pump-ring.js');
  const real = { latest: audio.latest, isRunning: audio.isRunning, available: audio.available };
  let peaks = {};
  audio.latest = () => peaks;
  audio.isRunning = () => true;
  audio.available = () => true;
  const red = { r: 255, g: 0, b: 0 };
  const one = (now) => pumpRing.frame(null, 1, now)[0];
  try {
    pumpRing.set({ follow: 'screen', effect: 'beat', colours: [RED] });
    assert.equal(pumpRing.pulsing(), true);
    peaks = { player: 1 };
    assert.deepEqual(one(2e9), red, 'loud: full colour');
    peaks = { player: 0.04 };
    assert.deepEqual(one(2e9 + 1e5), { r: Math.round(255 * (0.4 + 0.6 * 0.2)), g: 0, b: 0 }, 'quiet: dimmed, over the floor');
    peaks = {};
    assert.deepEqual(one(2e9 + 2e5), red, 'a long silence: steady');
    pumpRing.set({ follow: 'theme', effect: 'meter' });
    assert.equal(pumpRing.pulsing(), true, 'the sound meter on the theme colour reads the sound too');
    pumpRing.set({ follow: 'off', effect: 'beat' });
    assert.equal(pumpRing.pulsing(), false, 'a dark ring has nothing to pulse');
    pumpRing.set({ follow: 'screen', colours: [RED] });
    peaks = { player: 0.04 };
    assert.deepEqual(one(2e9 + 3e5), red, 'no pulse: the sound changes nothing');
  } finally {
    Object.assign(audio, real);
    pumpRing.set(null);
  }
});

test('the pulse is consent to read the sound, where this PC can', () => {
  const pumpRing = require('../lights/pump-ring.js');
  const { audioLevelsWanted } = require('../audio/levels-wanted.js');
  const realAvailable = audio.available;
  try {
    audio.available = () => true;
    pumpRing.set({ follow: 'screen', colours: [RED] });
    const before = audioLevelsWanted();
    pumpRing.set({ follow: 'screen', effect: 'beat', colours: [RED] });
    assert.equal(audioLevelsWanted(), true, 'a pulsing ring wants the sound');
    pumpRing.set({ follow: 'screen', colours: [RED] });
    assert.equal(audioLevelsWanted(), before, 'and lets it go');
    audio.available = () => false;
    pumpRing.set({ follow: 'screen', effect: 'beat', colours: [RED] });
    assert.equal(audioLevelsWanted(), false, 'no reader on this PC: nothing to start');
  } finally {
    audio.available = realAvailable;
    pumpRing.set(null);
  }
});

test('a ring LED with no colour of its own follows Xenon, and the ring spreads its colours in LED order', () => {
  const { ledFrame } = require('../lights/lighting-led-colors.js');
  const { RING_LED } = require('../lights/pump-ring.js');
  const follow = { r: 1, g: 2, b: 3 };
  const leds = { 11: RING_LED, 12: RING_LED };
  const ctx = { follow, temperature: null, album: null, brightness: 1, nowMs: 0 };
  assert.deepEqual(ledFrame([10, 11, 12], leds, { ...ctx, pump: null }), [follow, follow, follow]);
  const red = { r: 255, g: 0, b: 0 };
  const blue = { r: 0, g: 0, b: 255 };
  const pump = (count) => [red, blue].slice(0, count);
  assert.deepEqual(ledFrame([10, 11, 12], leds, { ...ctx, pump }), [follow, red, blue]);
  assert.deepEqual(ledFrame([10, 11, 12], leds, { ...ctx, follow: null, pump }), [null, red, blue], 'no colour for the rest: left to iCUE');
  assert.deepEqual(ledFrame([10, 11, 12], leds, { ...ctx, pump: () => null }), [follow, follow, follow], "nothing of its own now: Xenon's colour");
});

test('a breathing ring rises and falls on its own, never dark; a running light lights a head and its tail', () => {
  const pumpRing = require('../lights/pump-ring.js');
  const { ledFrame } = require('../lights/lighting-led-colors.js');
  const red = { r: 255, g: 0, b: 0 };
  try {
    pumpRing.set({ follow: 'screen', effect: 'breathe', colours: [RED] });
    assert.equal(pumpRing.moving(), true, 'the lights tick for it');
    assert.equal(pumpRing.pulsing(), false, 'no sound is read for a breath');
    const low = pumpRing.frame(null, 1, 0)[0];
    assert.deepEqual(pumpRing.frame(null, 1, 2000)[0], red, 'the top of the breath: full colour');
    assert.ok(low.r > 0 && low.r < 80, `the bottom: dim, never dark (${low.r})`);

    pumpRing.set({ follow: 'screen', effect: 'spin', colours: [RED] });
    assert.equal(pumpRing.moving(), true);
    const ids = Array.from({ length: 8 }, (_, i) => 'l' + i);
    const leds = Object.fromEntries(ids.map((id) => [id, pumpRing.RING_LED]));
    const quarter = ledFrame(ids, leds, { follow: null, pump: (count) => pumpRing.frame(null, count, 600), brightness: 1, nowMs: 0 });
    assert.deepEqual(quarter[2], red, 'the head, a quarter of the way round, is full');
    assert.ok(quarter[1].r < 255 && quarter[1].r > quarter[0].r, 'its tail fades behind it');
    assert.ok(quarter[4].r < 60, 'the LEDs ahead of it are dim');

    pumpRing.set({ follow: 'screen', effect: 'spin', speed: 'slow', reverse: true, colours: [RED] });
    const back = pumpRing.frame(null, 8, 600 * 1.7);
    assert.deepEqual(back[6], red, 'slow and the other way round: the same quarter, from the other side');

    pumpRing.set({ follow: 'off', effect: 'spin' });
    assert.equal(pumpRing.moving(), false, 'a dark ring never moves');
    pumpRing.set({ follow: 'screen', effect: 'confetti', colours: [RED] });
    assert.equal(pumpRing.moving(), false, 'an effect it does not know: still');
  } finally {
    pumpRing.set(null);
  }
});
