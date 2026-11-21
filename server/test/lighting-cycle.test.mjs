// The lighting bridge from end to end against a pretend iCUE SDK: switching the lights on connects,
// lists the devices and paints them; a colour, a device mode, an animation and an event flash reach
// the LEDs; a session that died is rebuilt on the next tick, a device that answered without its
// lights is asked again, and switching off hands the lights back. Only what the bridge says to the
// SDK and what it answers its callers is read here, so the test holds however lighting.js is cut
// into files.
//
// No real device is touched: the pretend SDK is put in the bridge's shared state before anything
// asks for the real library (loadLib() returns at once when one is already there), every device in
// it is a keyboard or a memory stick (never a motherboard, which would wake a USB controller), and
// the native controllers and the external providers stay switched off. What this cannot show is
// what the real SDK and real hardware do with these calls.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pretendSdk } from './pretend-icue-sdk.mjs';

const require = createRequire(import.meta.url);
const { bridge } = require('../lights/bridge-state.js');

const KEYBOARD = 0x1;
const MEMORY = 0x40;
const SESSION_LOST = 2;
const NOT_CONNECTED = 1;   // CE_NotConnected

const ledBase = (id) => (id === 'pretend-keys' ? 100 : 200);
const DEVICES = [
  { type: KEYBOARD, id: 'pretend-keys', serial: '', model: 'Pretend Keys', ledCount: 4, channelCount: 0 },
  { type: MEMORY, id: 'pretend-ram', serial: '', model: 'Pretend RAM', ledCount: 3, channelCount: 0 },
];

assert.equal(bridge.lib, null, 'nothing loaded the real SDK before the pretend one is in place');
const sdk = pretendSdk({ devices: DEVICES, ledBase });
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
// Nothing in flight and nothing said to the SDK for a few turns of the loop.
async function quiet() {
  for (let same = 0, seen = -1; same < 3;) {
    await sleep(15);
    same = sdk.log.length === seen && !bridge.applyInFlight && !bridge.enumerating ? same + 1 : 0;
    seen = sdk.log.length;
  }
}
const names = (from = 0) => sdk.log.slice(from).map((call) => call.fn);
const writes = (from = 0, id = null) => sdk.log.slice(from).filter((call) => call.fn === 'setLedColors' && (!id || call.id === id));
const lastWrite = (id, from = 0) => writes(from, id).at(-1);
const rgb = (c) => [c.r, c.g, c.b];
const allAre = (call, colour) => call.colors.every((c) => rgb(c).join() === colour.join());
const mark = () => sdk.log.length;

after(async () => {
  lighting.applyConfig({ enabled: false, animation: { style: 'none' }, effects: { timer: false } });
  lighting.disconnect();
  await quiet();
});

test('switching the lights on connects, lists the devices with their LEDs and paints them', async () => {
  assert.equal(lighting.isConnected(), false);
  lighting.applyConfig({ enabled: true, pauseDuringGame: false, brightness: 1, manualColor: '#102030' });
  await until(() => writes(0, 'pretend-keys').length && writes(0, 'pretend-ram').length, 'both devices painted');
  await quiet();
  assert.equal(bridge.lib.pretend, true, 'the real library was never asked for');
  assert.deepEqual(names().slice(0, 4), ['connect', 'getDevices', 'getLedPositions', 'getLedPositions']);
  assert.equal(names().filter((name) => name === 'connect').length, 1);
  assert.equal(lighting.isConnected(), true);
  assert.deepEqual(lighting.getDevices().map((d) => [d.id, d.model, d.type, d.ledCount, d.source]),
    [['pretend-keys', 'Pretend Keys', KEYBOARD, 4, 'icue'], ['pretend-ram', 'Pretend RAM', MEMORY, 3, 'icue']]);
  assert.deepEqual(lastWrite('pretend-keys').colors, [100, 101, 102, 103].map((id) => ({ id, r: 16, g: 32, b: 48, a: 255 })));
  assert.deepEqual(lastWrite('pretend-ram').colors, [200, 201, 202].map((id) => ({ id, r: 16, g: 32, b: 48, a: 255 })));
  assert.equal(lighting.getStatus().connected, true);
});

test('a colour is written once: the same picture again says nothing to the SDK', async () => {
  let from = mark();
  assert.equal(lighting.setManualColor('#ff0000'), true);
  await until(() => writes(from).length >= 2, 'the new colour on both devices');
  await quiet();
  assert.deepEqual(writes(from).map((call) => [call.id, allAre(call, [255, 0, 0])]), [['pretend-keys', true], ['pretend-ram', true]]);
  from = mark();
  lighting.onStatus();
  lighting.onSystem({ cpuTemp: 50 });
  await quiet();
  assert.deepEqual(names(from), [], 'unchanged: no call at all');
  assert.equal(lighting.setManualColor('not a colour'), false);
});

test('brightness, a device left out and a device with its own colour', async () => {
  let from = mark();
  lighting.applyConfig({ brightness: 0.5, devices: { 'pretend-ram': false } });
  lighting.setManualColor('#00ff00');
  await until(() => writes(from, 'pretend-keys').length, 'the keyboard repainted');
  await quiet();
  assert.equal(writes(from, 'pretend-ram').length, 0, 'a device left out is not written to');
  const [r, g, b] = rgb(lastWrite('pretend-keys', from).colors[0]);
  assert.ok(r === 0 && b === 0 && g > 100 && g < 140, `half brightness of full green, got ${g}`);

  from = mark();
  lighting.applyConfig({ brightness: 1, devices: {} });
  assert.equal(lighting.setDeviceMode('pretend-ram', { mode: 'color', color: '#0000ff' }), true);
  await until(() => writes(from, 'pretend-ram').length && writes(from, 'pretend-keys').length, 'both repainted');
  await quiet();
  assert.ok(allAre(lastWrite('pretend-ram', from), [0, 0, 255]), 'its own colour');
  assert.ok(allAre(lastWrite('pretend-keys', from), [0, 255, 0]), 'the other follows');

  from = mark();
  lighting.setDeviceMode('pretend-ram', { mode: 'off' });
  await until(() => writes(from, 'pretend-ram').length, 'the stick dark');
  assert.ok(allAre(lastWrite('pretend-ram', from), [0, 0, 0]));
  lighting.setDeviceMode('pretend-ram', { mode: 'follow' });
  await quiet();
});

test('an animation keeps painting new frames by itself and stops when it is switched off', async () => {
  let from = mark();
  assert.equal(lighting.setAnimation({ style: 'breathing', color: '#ff0000', speed: 100 }), true);
  const frames = () => new Set(writes(from, 'pretend-keys').map((call) => rgb(call.colors[0]).join()));
  await until(() => frames().size >= 4, 'four different frames with nobody asking');
  assert.ok(writes(from, 'pretend-ram').length >= 2, 'every device gets the frames');

  lighting.setAnimation({ style: 'none' });
  await quiet();
  from = mark();
  await sleep(250);
  assert.deepEqual(names(from), [], 'the loop stopped: nothing is written any more');
  assert.ok(allAre(lastWrite('pretend-keys'), [0, 255, 0]), 'back on the fixed colour');
});

test('an event flash takes the lights, ends by itself and gives them back', async () => {
  lighting.applyConfig({ effects: { timer: { enabled: true, color: '#ff00ff', style: 'solid', durationMs: 500 } } });
  await quiet();
  const from = mark();
  lighting.onEvent('timer');
  await until(() => writes(from, 'pretend-keys').some((call) => allAre(call, [255, 0, 255])), 'the flash colour');
  await until(() => allAre(lastWrite('pretend-keys', from), [0, 255, 0]) && allAre(lastWrite('pretend-ram', from), [0, 255, 0]), 'the fixed colour back after the flash');
  await quiet();
  const then = mark();
  await sleep(200);
  assert.deepEqual(names(then), [], 'the flash loop stopped');
  lighting.onEvent('nothing of the kind');
  await quiet();
  assert.deepEqual(names(then), []);
  lighting.applyConfig({ effects: { timer: false } });
  await quiet();
});

test('a write the SDK refuses as not connected drops the session; the next tick rebuilds it and asks a device without lights again', async () => {
  const from = mark();
  sdk.writeAnswers.push(NOT_CONNECTED);
  sdk.withoutLights.set('pretend-ram', 1);   // the stick answers with no LED positions the first time
  lighting.setManualColor('#0000ff');
  await until(() => lighting.isConnected() === false || names(from).includes('connect'), 'the dead session noticed');
  assert.match(String(lighting.getLastError()), /CorsairSetLedColors rc=1 \(CE_NotConnected\)/);
  lighting.onStatus();   // the next tick of the engine
  await until(() => writes(from, 'pretend-ram').some((call) => allAre(call, [0, 0, 255])), 'the stick painted after being asked again');
  await quiet();
  const said = names(from);
  assert.equal(said.filter((name) => name === 'connect').length, 1, 'one new session');
  assert.equal(said.filter((name) => name === 'getDevices').length, 2, 'listed once on connect, once more for the device without lights');
  assert.equal(lighting.isConnected(), true);
  assert.ok(allAre(lastWrite('pretend-keys', from), [0, 0, 255]));
  assert.equal(lastWrite('pretend-ram', from).colors.length, 3);
  assert.equal(sdk.registered, 2, 'a state callback per session');
});

test('a session the SDK reports lost is rebuilt by the ticks, not sooner than the pause between two tries', async () => {
  const from = mark();
  const lostAt = Date.now();
  sdk.say(SESSION_LOST);
  assert.equal(lighting.isConnected(), false);
  lighting.onStatus();
  await quiet();
  assert.deepEqual(names(from), [], 'the try before was a moment ago: this tick waits');
  // The engine's ticks, as server.js sends them.
  const ticks = setInterval(() => lighting.onStatus(), 50);
  try {
    await until(() => lighting.isConnected() && writes(from, 'pretend-keys').length, 'the session back and painted', 8000);
  } finally {
    clearInterval(ticks);
  }
  await quiet();
  assert.ok(Date.now() - lostAt >= 1000, 'not rebuilt at once');
  assert.equal(names(from).filter((name) => name === 'connect').length, 1);
  assert.ok(allAre(lastWrite('pretend-keys', from), [0, 0, 255]));
});

test('before the PC goes off the lights are handed back and nothing paints until it is awake again', async () => {
  let from = mark();
  await lighting.powerDown();
  await quiet();
  const handed = writes(from);
  assert.deepEqual(handed.map((call) => call.id), ['pretend-keys', 'pretend-ram']);
  assert.ok(handed.every((call) => call.colors.every((c) => c.a === 0)), 'alpha 0: the device shows its own lighting');
  from = mark();
  lighting.setManualColor('#ffffff');
  await quiet();
  assert.deepEqual(names(from), [], 'nothing is painted while the PC is going down');
  lighting.powerUp();
  await until(() => writes(from).length >= 2, 'painted again when awake');
  await quiet();
  assert.ok(allAre(lastWrite('pretend-keys', from), [255, 255, 255]));
});

test('"lights off" from a key darkens every device, and back on shows what was there', async () => {
  let from = mark();
  lighting.setLightsOut(true);
  await until(() => writes(from).length >= 2, 'both dark');
  await quiet();
  assert.equal(lighting.isLightsOut(), true);
  assert.ok(writes(from).every((call) => allAre(call, [0, 0, 0]) && call.colors.every((c) => c.a === 255)), 'black, still ours');
  from = mark();
  lighting.setLightsOut(false);
  await until(() => writes(from).length >= 2, 'both back');
  await quiet();
  assert.ok(allAre(lastWrite('pretend-ram', from), [255, 255, 255]));
});

test('switching the lights off hands every device back and ends the session', async () => {
  const from = mark();
  lighting.setEnabled(false);
  await until(() => names(from).includes('disconnect'), 'the session ended');
  await quiet();
  const said = sdk.log.slice(from);
  const handed = said.filter((call) => call.fn === 'setLedColors');
  assert.deepEqual(handed.map((call) => call.id).slice(0, 2), ['pretend-keys', 'pretend-ram']);
  assert.ok(handed.every((call) => call.colors.every((c) => c.a === 0)), 'handed back, not painted');
  assert.ok(said.findIndex((call) => call.fn === 'disconnect') > said.findIndex((call) => call.fn === 'setLedColors'), 'handed back before the session ends');
  assert.equal(lighting.isConnected(), false);
  assert.equal(sdk.unregistered >= 1, true, 'the state callback is let go');
  const then = mark();
  lighting.onStatus();
  lighting.onSystem({ cpuTemp: 60 });
  await sleep(150);
  assert.deepEqual(names(then), [], 'off: nothing asks for a session');
});
