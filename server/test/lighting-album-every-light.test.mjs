// "Colours from the album cover" (lights/paint.js) against a pretend iCUE SDK: while a song plays
// its cover reaches every light not switched off, a light with an effect or a map of its own too,
// and when it stops each light goes back to what it had. Only what the bridge says to the SDK is
// read here; no real device is touched (pretend-icue-sdk.mjs is in the bridge before lighting.js).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pretendSdk } from './pretend-icue-sdk.mjs';

const require = createRequire(import.meta.url);
const { bridge } = require('../lights/bridge-state.js');

const KEYBOARD = 0x1;
const MOUSE = 0x2;
const COOLER = 0x100;
const BASE = { 'pretend-keys': 100, 'pretend-fans': 300, 'pretend-mouse': 500 };
const DEVICES = [
  { type: KEYBOARD, id: 'pretend-keys', serial: '', model: 'Pretend Keys', ledCount: 4, channelCount: 0 },
  { type: COOLER, id: 'pretend-fans', serial: '', model: 'Pretend Fans', ledCount: 3, channelCount: 0 },
  { type: MOUSE, id: 'pretend-mouse', serial: '', model: 'Pretend Mouse', ledCount: 2, channelCount: 0 },
];

assert.equal(bridge.lib, null, 'nothing loaded the real SDK before the pretend one is in place');
const sdk = pretendSdk({ devices: DEVICES, ledBase: (id) => BASE[id] });
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
const frame = (id) => {
  const call = sdk.log.filter((c) => c.fn === 'setLedColors' && c.id === id).at(-1);
  return call ? call.colors.map((c) => `${c.r},${c.g},${c.b}`) : [];
};
const all = (id, rgb) => frame(id).length > 0 && frame(id).every((c) => c === rgb);

after(async () => {
  lighting.clearAlbum();
  lighting.applyConfig({ enabled: false, effects: { musicAlbum: false } });
  lighting.disconnect();
  await sleep(50);
});

test('a song\'s cover reaches a light with its own colour or map, and each goes back after', async () => {
  lighting.applyConfig({ enabled: true, pauseDuringGame: false, brightness: 1, devices: {}, manualColor: '#00ff00', effects: { musicAlbum: true } });
  lighting.setDeviceMode('pretend-keys', { mode: 'color', color: '#ffff00' });
  lighting.setDeviceMode('pretend-fans', { mode: 'custom', leds: { [BASE['pretend-fans']]: '#ff00ff', [BASE['pretend-fans'] + 1]: '#ff00ff', [BASE['pretend-fans'] + 2]: '#ff00ff' } });
  lighting.setDeviceMode('pretend-mouse', { mode: 'off' });
  await until(() => all('pretend-keys', '255,255,0') && all('pretend-fans', '255,0,255'), 'each light in its own look');

  lighting.setAlbumColor('#0000ff');
  await until(() => all('pretend-keys', '0,0,255') && all('pretend-fans', '0,0,255'), 'the cover on the keyboard and on the mapped fans');
  assert.ok(all('pretend-mouse', '0,0,0'), 'a light switched off stays dark');

  lighting.clearAlbum();
  await until(() => all('pretend-keys', '255,255,0') && all('pretend-fans', '255,0,255'), 'back to each light\'s own look');
});

test('with the cover switched off in Lighting, a song leaves every light as it is', async () => {
  lighting.applyConfig({ effects: { musicAlbum: false } });
  lighting.setAlbumColor('#0000ff');
  await sleep(80);
  assert.ok(all('pretend-keys', '255,255,0'), 'the keyboard keeps its colour');
  assert.ok(all('pretend-fans', '255,0,255'), 'the fans keep their map');
  lighting.clearAlbum();
});
