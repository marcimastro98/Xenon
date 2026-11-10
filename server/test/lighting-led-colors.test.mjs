// The lighting map stores one look per LED in the 'custom' device mode: a colour
// or an effect. Every path that writes it (the API patch, settings.json on boot,
// the browser mirror) must accept only luid → valid look, cap the size, and
// survive a round trip; the frame renderer must follow Xenon where nothing is set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const { normalizeLedColors, normalizeLedValue, mergeLedColors, hasDynamicLeds, ledFrame, MAX_LED_COLORS } = require('../lighting-led-colors.js');
const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..');

// On a PC with the iCUE SDK DLL, lighting.js would connect to the real iCUE: the
// tests would drive the real lights, and a busy iCUE holds the call and hangs the run.
const fs = require('fs');
const realExists = fs.existsSync;
fs.existsSync = (p) => !String(p).endsWith('iCUESDK.x64_2019.dll') && realExists(p);

test('the real iCUE SDK stays out of these tests', () => {
  const lighting = require('../lighting.js');
  lighting.refreshAvailability();
  assert.equal(lighting.isAvailable(), false);
});

test('normalize keeps luid → hex and drops everything else', () => {
  const out = normalizeLedColors({ 720897: '#FF0000', '12': '#00ff00', abc: '#0000ff', '-1': '#ffffff', 5: 'red', 6: null, 99999999999: '#123456' });
  assert.deepEqual(out, { 12: '#00ff00', 720897: '#ff0000' });
  assert.deepEqual(normalizeLedColors(null), {});
  assert.deepEqual(normalizeLedColors(['#ff0000']), {});
});

test('normalize caps the map at the SDK LED maximum', () => {
  const big = Object.fromEntries(Array.from({ length: MAX_LED_COLORS + 50 }, (_, i) => [String(i + 1), '#ffffff']));
  assert.equal(Object.keys(normalizeLedColors(big)).length, MAX_LED_COLORS);
});

test('merge sets, replaces and clears LEDs; invalid entries are ignored', () => {
  let m = mergeLedColors({}, { 1: '#ff0000', 2: '#00ff00' });
  m = mergeLedColors(m, { 1: '#0000ff', 2: null, x: '#ffffff', 3: 'nope' });
  assert.deepEqual(m, { 1: '#0000ff' });
});

test('merge never grows past the cap but can still change existing LEDs', () => {
  const full = Object.fromEntries(Array.from({ length: MAX_LED_COLORS }, (_, i) => [String(i + 1), '#ffffff']));
  const m = mergeLedColors(full, { 1: '#000000', 9999: '#000000' });
  assert.equal(Object.keys(m).length, MAX_LED_COLORS);
  assert.equal(m[1], '#000000');
  assert.equal(m[9999], undefined);
});

test('setDeviceMode: custom mode merges LEDs, keeps no base colour, and survives a round trip', () => {
  const lighting = require('../lighting.js');
  assert.ok(lighting.setDeviceMode('dev-a', { mode: 'custom', leds: { 65537: '#FF0000' } }));
  lighting.setDeviceMode('dev-a', { leds: { 65538: { style: 'wave', speed: 70 } } });
  let m = lighting.getConfig().deviceModes['dev-a'];
  assert.equal(m.mode, 'custom');
  // LEDs nobody painted follow Xenon: the map has no base colour of its own.
  assert.equal(m.color, undefined);
  assert.deepEqual(m.leds, { 65537: '#ff0000', 65538: { style: 'wave', color: '#1ed760', speed: 70 } });
  lighting.setDeviceMode('dev-a', { leds: { 65537: null } });
  assert.deepEqual(Object.keys(lighting.getConfig().deviceModes['dev-a'].leds), ['65538']);
  lighting.setDeviceMode('dev-a', { clearLeds: true });
  m = lighting.getConfig().deviceModes['dev-a'];
  assert.deepEqual(m.leds, {});
  // Handing the last LED back to Xenon leaves "per part" for "follows Xenon".
  lighting.setDeviceMode('dev-a', { mode: 'custom', leds: { 9: '#ffffff' } });
  lighting.setDeviceMode('dev-a', { leds: { 9: null } });
  assert.equal(lighting.getConfig().deviceModes['dev-a'].mode, 'follow');
  lighting.setDeviceMode('dev-a', { mode: 'custom' });
  // Round trip through the persisted shape keeps the map.
  lighting.setDeviceMode('dev-a', { leds: { 7: '#abcdef', 8: { style: 'album' } } });
  lighting.applyConfig({ deviceModes: lighting.getConfig().deviceModes });
  assert.deepEqual(lighting.getConfig().deviceModes['dev-a'].leds, { 7: '#abcdef', 8: { style: 'album', color: '#1ed760', speed: 50 } });
});

test('LED effects are validated: known style, hex colour, speed 1..100', () => {
  assert.deepEqual(normalizeLedValue({ style: 'breathing', color: '#ABCDEF', speed: 500 }), { style: 'breathing', color: '#abcdef', speed: 100 });
  assert.deepEqual(normalizeLedValue({ style: 'candle' }), { style: 'candle', color: '#ff9329', speed: 50 });
  assert.equal(normalizeLedValue({ style: 'palette' }), null);
  assert.equal(normalizeLedValue({ style: 'cycle', color: 'javascript:1' }).color, '#1ed760');
  assert.equal(normalizeLedValue(['#ff0000']), null);
  assert.equal(normalizeLedValue(42), null);
  assert.deepEqual(mergeLedColors({}, { 1: { style: 'nope' }, 2: { style: 'aurora', speed: 0 } }), { 2: { style: 'aurora', color: '#1ed760', speed: 1 } });
});

test('ledFrame: unpainted LEDs follow Xenon, colours get the brightness, reactive LEDs fall back', () => {
  const follow = { r: 10, g: 20, b: 30 };
  const ctx = { follow, temperature: null, album: { r: 200, g: 0, b: 0 }, brightness: 0.5, nowMs: 0 };
  const out = ledFrame([1, 2, 3, 4], { 2: '#ffffff', 3: { style: 'temperature' }, 4: { style: 'album' } }, ctx);
  assert.deepEqual(out[0], follow);
  assert.deepEqual(out[1], { r: 128, g: 128, b: 128 });
  assert.deepEqual(out[2], follow, 'no temperature reading yet: the LED follows Xenon');
  assert.deepEqual(out[3], { r: 100, g: 0, b: 0 });
});

test('ledFrame: a wave runs across the LEDs that share it, a breathing group moves as one', () => {
  const ctx = { follow: { r: 0, g: 0, b: 0 }, temperature: null, album: null, brightness: 1, nowMs: 1234 };
  const wave = { style: 'wave', color: '#1ed760', speed: 50 };
  const out = ledFrame([1, 2, 3, 4, 5, 6], { 1: wave, 2: wave, 3: wave, 4: wave, 5: { style: 'breathing', color: '#ff0000', speed: 50 }, 6: { style: 'breathing', color: '#ff0000', speed: 50 } }, ctx);
  const hues = out.slice(0, 4).map(c => `${c.r},${c.g},${c.b}`);
  assert.equal(new Set(hues).size, 4, 'each LED of the wave has its own hue');
  assert.deepEqual(out[4], out[5]);
  assert.equal(out[4].g, 0);
  assert.ok(hasDynamicLeds({ 1: wave }));
  assert.ok(!hasDynamicLeds({ 1: '#ffffff', 2: { style: 'album' } }));
});

test('every normalizer knows the custom mode and its LED map', () => {
  const server = readFileSync(join(SERVER, 'server.js'), 'utf8');
  const client = readFileSync(join(SERVER, 'js', 'settings.js'), 'utf8');
  const bridge = readFileSync(join(SERVER, 'lighting.js'), 'utf8');
  for (const [name, src] of [['server.js', server], ['settings.js', client], ['lighting.js', bridge]]) {
    assert.match(src, /(LIGHTING_)?DEVICE_MODES = \[[^\]]*'custom'/, `${name} drops the custom mode`);
  }
  assert.match(server, /e\.leds = normalizeLedColors\(v\.leds\)/);
  assert.match(client, /e\.leds = normalizeLightingLedColors\(v\.leds\)/);
  assert.match(bridge, /e\.leds = ledColors\.normalizeLedColors\(v\.leds\)/);
});

test('a Deck key and the SDK can switch a device to its LED colours', () => {
  const src = readFileSync(join(SERVER, 'js', 'deck-actions.js'), 'utf8');
  const line = src.split('\n').find(l => l.includes("type: 'lightDevice'"));
  assert.ok(line, 'lightDevice action missing');
  assert.match(line, /options: \[[^\]]*'custom'/, 'the Deck cannot pick the custom mode');
  const i18n = readFileSync(join(SERVER, 'js', 'i18n.js'), 'utf8');
  assert.equal((i18n.match(/deck_opt_custom:/g) || []).length, 11, 'deck_opt_custom must exist in all 11 languages');
});

// The browser mirror (settings.js) must keep exactly what the server keeps, or a
// full settings save would drop or mangle the LED effects the server stored.
test('the settings.js LED mirror agrees with the server normalizer', () => {
  const src = readFileSync(join(SERVER, 'js', 'settings.js'), 'utf8');
  const pick = (name) => {
    const m = src.match(new RegExp('\\nfunction ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
    assert.ok(m, name + ' not found in settings.js');
    return m[0];
  };
  const ctx = {};
  vm.runInNewContext(pick('clampNumber') + pick('normalizeLightingLedValue') + pick('normalizeLightingLedColors')
    + '\nthis.fn = normalizeLightingLedColors;', ctx);
  const input = {
    1: '#ABCDEF', 2: { style: 'wave', speed: 300 }, 3: { style: 'candle' }, 4: { style: 'palette' },
    5: { style: 'album', color: 'red' }, 6: 'nope', x: '#ffffff', 7: { style: 'breathing', color: '#00FF00', speed: 12.6 },
  };
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.fn(input))), normalizeLedColors(input));
});

test('an event flash or a Deck reaction still takes a device that has a LED map', () => {
  const bridge = readFileSync(join(SERVER, 'lighting.js'), 'utf8');
  assert.match(bridge, /dm\.mode === 'custom' && !eventColor && !deckColor/);
  assert.match(bridge, /m\.mode === 'custom' && ledColors\.hasDynamicLeds\(m\.leds\)/, 'looping LED effects must keep the ticker running');
});

test('touching one part of a single-look device keeps the other LEDs looking the same', () => {
  const src = readFileSync(join(SERVER, 'js', 'lighting-device.js'), 'utf8');
  const ctx = { window: {} };
  vm.runInNewContext(src, ctx);
  const { kindOf, wholeDeviceLook } = ctx.window.LightingDevice;
  assert.equal(kindOf({ mode: 'temperature' }), 'effect');
  assert.equal(kindOf({ mode: 'custom' }), 'parts');
  assert.equal(kindOf({}), 'follow');
  assert.equal(wholeDeviceLook({ mode: 'follow' }), null);
  assert.equal(wholeDeviceLook({ mode: 'color', modeColor: '#123456' }), '#123456');
  assert.equal(wholeDeviceLook({ mode: 'off' }), '#000000');
  assert.deepEqual({ ...wholeDeviceLook({ mode: 'album' }) }, { style: 'album' });
  assert.deepEqual({ ...wholeDeviceLook({ mode: 'animation', modeAnim: { style: 'aurora', color: '#00ff00', speed: 30 } }) },
    { style: 'aurora', color: '#00ff00', speed: 30 });
  assert.equal(wholeDeviceLook({ mode: 'animation', modeAnim: { style: 'solid', color: '#ff00ff' } }), '#ff00ff');
  // Every look it hands the server must survive the server's own validation.
  for (const dev of [{ mode: 'album' }, { mode: 'temperature' }, { mode: 'animation', modeAnim: { style: 'candle' } }]) {
    assert.ok(normalizeLedValue({ ...wholeDeviceLook(dev) }), JSON.stringify(dev));
  }
});

// "Colour one part" (Deck, AI): the part gets the look on top of the device's own
// look, nothing is saved, and switching the lights off from a key hands it back.
// While a key holds the lights, the music colour does not cover what it set.
test('setPartLook paints one part on top of the device look, saves nothing, ends on release', async (t) => {
  const lighting = require('../lighting.js');
  const native = require('../lighting-native');
  const seg = (base, n) => ({ kind: 'fan', ledIds: Array.from({ length: n }, (_, i) => base + i) });
  const board = { id: 'fusion2-test', type: 0x200, source: 'native', segments: [seg(65536, 3), seg(65539, 2)] };
  board.ledIds = board.segments.flatMap(s => s.ledIds);
  const frames = [];
  t.mock.method(native, 'devices', () => [board]);
  t.mock.method(native, 'hasDevices', () => true);
  t.mock.method(native, 'owns', () => true);
  t.mock.method(native, 'write', (dev, colors) => { frames.push(colors.map(c => `${c.r},${c.g},${c.b}`)); });
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };

  lighting.setDeviceMode(board.id, { mode: 'color', color: '#112233' });
  const before = JSON.stringify(lighting.getConfig().deviceModes[board.id]);
  lighting.setAlbumColor('#00ff00');
  assert.ok(lighting.setPartLook(board.id, 1, '#ff0000'));
  await settle();
  assert.equal(JSON.stringify(lighting.getConfig().deviceModes[board.id]), before, 'the saved map is untouched');
  let f = frames.at(-1);
  assert.equal(f[3], f[4]);
  assert.match(f[3], /^\d+,0,0$/, 'the part is red');
  assert.equal(f[0], f[2]);
  assert.notEqual(f[0], f[3], 'the rest keeps the device colour');

  assert.ok(lighting.setPartLook(board.id, 0, null), 'null gives a part back');
  assert.equal(lighting.setPartLook(board.id, 5, '#ff0000'), false, 'unknown part');
  assert.equal(lighting.setPartLook('nope', 0, '#ff0000'), false, 'unknown device');
  assert.equal(lighting.setPartLook(board.id, 0, 'not a colour'), false, 'invalid look');

  lighting.releaseKeyLook();
  lighting.setEnabled(true);
  await settle();
  f = frames.at(-1);
  assert.ok(f.every(c => c === f[0]), 'released: the whole device has one look again');
  lighting.setEnabled(false);
  lighting.clearAlbum();
  lighting.setDeviceMode(board.id, { mode: 'follow', clearLeds: true });
});

test('a key colour wins over the music colour until the lights go off', async (t) => {
  const lighting = require('../lighting.js');
  const native = require('../lighting-native');
  const board = { id: 'fusion2-test2', type: 0x200, source: 'native', segments: [{ kind: 'fan', ledIds: [65536, 65537] }] };
  board.ledIds = [65536, 65537];
  const frames = [];
  t.mock.method(native, 'devices', () => [board]);
  t.mock.method(native, 'hasDevices', () => true);
  t.mock.method(native, 'owns', () => true);
  t.mock.method(native, 'write', (dev, colors) => { frames.push(colors[0]); });
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };

  lighting.setEffectEnabled('musicAlbum', true);
  lighting.setAlbumColor('#00ff00');
  lighting.setManualColor('#000000');
  lighting.holdKeyLook();
  await settle();
  assert.deepEqual(frames.at(-1), { r: 0, g: 0, b: 0 }, 'black from the key, not the green cover');
  lighting.releaseKeyLook();
  await settle();
  assert.ok(frames.at(-1).g > 0 && frames.at(-1).r === 0, 'the music colour is back');
  lighting.clearAlbum();
  lighting.clearManual();
});

test('a key colour for the whole rig drops the parts an earlier key coloured', () => {
  const keyLook = require('../lighting-key-look.js');
  keyLook.release();
  keyLook.setPart('dev', [1, 2], '#ffffff');
  keyLook.hold();
  assert.deepEqual(keyLook.partsOf('dev'), { 1: '#ffffff', 2: '#ffffff' }, 'a plain hold keeps them');
  keyLook.hold({ wholeRig: true });
  assert.equal(keyLook.partsOf('dev'), null);
  assert.equal(keyLook.isHeld(), true);
  keyLook.setPart('dev', [1], '#ffffff');
  keyLook.setPart('dev', [1], null);
  assert.equal(keyLook.partsOf('dev'), null, 'giving every LED back leaves nothing');
  assert.equal(keyLook.release(), true);
  assert.equal(keyLook.isHeld(), false);
  assert.equal(keyLook.release(), false, 'nothing left to release');
});
