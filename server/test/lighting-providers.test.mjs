import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const wled = require('../lighting-providers/wled.js');
const nanoleaf = require('../lighting-providers/nanoleaf.js');
const hue = require('../lighting-providers/hue.js');
const yeelight = require('../lighting-providers/yeelight.js');
const ha = require('../lighting-providers/homeassistant.js');

// --- WLED gradient band builder ---
test('wled buildBands spreads stops across the strip as [start,end,HEX] triples', () => {
  const red = { r: 255, g: 0, b: 0 }, blue = { r: 0, g: 0, b: 255 };
  const i = wled._buildBands([red, blue], 10);
  assert.equal(i.length, 10 * 3);                 // 10 LEDs → 10 bands
  assert.deepEqual(i.slice(0, 3), [0, 1, 'FF0000']);   // first band = first stop
  assert.equal(i[i.length - 3], 9);               // last band starts at LED 9
  assert.equal(i[i.length - 2], 10);              // …and ends at the strip length
  assert.equal(i[i.length - 1], '0000FF');        // last band = last stop
});

test('wled buildBands caps at 24 bands and covers the whole strip', () => {
  const i = wled._buildBands([{ r: 255, g: 0, b: 0 }, { r: 0, g: 255, b: 0 }], 300);
  assert.equal(i.length, 24 * 3);
  assert.equal(i[0], 0);                          // first band starts at 0
  assert.equal(i[i.length - 2], 300);             // last band ends at the strip length
  // Bands are contiguous: each band's end equals the next band's start.
  for (let b = 0; b < 23; b++) assert.equal(i[b * 3 + 1], i[(b + 1) * 3]);
});

// --- Nanoleaf probe classifier (over-match fix) ---
test('nanoleaf probe accepts only real OpenAPI responses', () => {
  assert.ok(nanoleaf._isNanoleafResponse(401, null));            // unauthorized = a real Nanoleaf
  assert.ok(nanoleaf._isNanoleafResponse(403, null));
  assert.ok(nanoleaf._isNanoleafResponse(405, null));            // firmware that only routes POST /new
  assert.ok(nanoleaf._isNanoleafResponse(200, { auth_token: 'x' }));
  assert.ok(!nanoleaf._isNanoleafResponse(200, null));           // 200 + HTML/non-JSON → not Nanoleaf
  assert.ok(!nanoleaf._isNanoleafResponse(404, null));           // some other web service on :16021
  assert.ok(!nanoleaf._isNanoleafResponse(0, null));             // unreachable
});

// --- Hue: v1 HSB conversion + CLIP v2 body builders ---
test('hue rgbToHueState maps primaries to the v1 hue/sat/bri ranges', () => {
  const red = hue._rgbToHueState({ r: 255, g: 0, b: 0 });
  assert.equal(red.hue, 0);
  assert.equal(red.sat, 254);
  assert.equal(red.bri, 254);
  assert.ok(red.on);
  const green = hue._rgbToHueState({ r: 0, g: 255, b: 0 });
  assert.equal(green.hue, Math.round(120 / 360 * 65535));
  assert.ok(!hue._rgbToHueState({ r: 0, g: 0, b: 0 }).on); // black = off
});

test('hue rgbToXy lands primaries in the right CIE region', () => {
  const red = hue._rgbToXy({ r: 255, g: 0, b: 0 });
  assert.ok(red.x > 0.6 && red.y < 0.4, `red xy off: ${JSON.stringify(red)}`);
  const green = hue._rgbToXy({ r: 0, g: 255, b: 0 });
  assert.ok(green.y > 0.5, `green xy off: ${JSON.stringify(green)}`);
  const blue = hue._rgbToXy({ r: 0, g: 0, b: 255 });
  assert.ok(blue.x < 0.2 && blue.y < 0.2, `blue xy off: ${JSON.stringify(blue)}`);
  assert.deepEqual(hue._rgbToXy({ r: 0, g: 0, b: 0 }), { x: 0.3127, y: 0.329 }); // black → neutral
});

test('hue buildV2State: colour + brightness split, black turns off', () => {
  const st = hue._buildV2State({ r: 128, g: 0, b: 0 });   // half-bright red
  assert.equal(st.on.on, true);
  assert.equal(st.dimming.brightness, 50);
  assert.ok(st.color && typeof st.color.xy.x === 'number');
  assert.deepEqual(hue._buildV2State({ r: 0, g: 0, b: 0 }), { on: { on: false } });
});

// --- Yeelight: discovery parsing + command builders ---
test('yeelight parses an SSDP discovery reply', () => {
  const reply = [
    'HTTP/1.1 200 OK',
    'Cache-Control: max-age=3600',
    'Location: yeelight://192.168.1.77:55443',
    'id: 0x0000000007fb2d9e',
    'model: color',
    'support: get_prop set_default set_power toggle set_bright set_rgb',
    'name: Scrivania',
  ].join('\r\n');
  const dev = yeelight._parseDiscoveryReply(reply, '192.168.1.77');
  assert.equal(dev.host, '192.168.1.77');
  assert.equal(dev.id, 'yeelight:0x0000000007fb2d9e');
  assert.equal(dev.name, 'Scrivania');
  assert.equal(dev.model, 'color');
});

test('yeelight rejects non-Yeelight SSDP traffic', () => {
  assert.equal(yeelight._parseDiscoveryReply('HTTP/1.1 200 OK\r\nLocation: http://192.168.1.5/desc.xml', '192.168.1.5'), null);
  assert.equal(yeelight._parseDiscoveryReply('', '192.168.1.5'), null);
});

test('yeelight command builder emits one CRLF-terminated JSON line', () => {
  const line = yeelight._buildCommand('set_scene', ['color', 16711680, 100]);
  assert.ok(line.endsWith('\r\n'));
  assert.deepEqual(JSON.parse(line), { id: 1, method: 'set_scene', params: ['color', 16711680, 100] });
  assert.equal(yeelight._rgbInt({ r: 255, g: 0, b: 0 }), 0xff0000);
  assert.equal(yeelight._rgbInt({ r: 0, g: 128, b: 255 }), 0x0080ff);
});

// --- Home Assistant: entity filtering + service payloads ---
test('homeassistant accepts only rgb-capable light entities', () => {
  assert.ok(ha._isRgbLight({ domain: 'light', colorModes: ['color_temp', 'rgb'] }));
  assert.ok(ha._isRgbLight({ domain: 'light', colorModes: ['hs'] }));
  assert.ok(ha._isRgbLight({ domain: 'light', colorModes: ['xy'] }));
  assert.ok(!ha._isRgbLight({ domain: 'light', colorModes: ['color_temp'] })); // tunable-white only
  assert.ok(!ha._isRgbLight({ domain: 'light', colorModes: [] }));             // plain on/off bulb
  assert.ok(!ha._isRgbLight({ domain: 'switch', colorModes: ['rgb'] }));       // wrong domain
});

test('homeassistant turn_on payload splits baked-in brightness back out', () => {
  const data = ha._buildTurnOnData({ r: 128, g: 64, b: 0 });   // half-bright orange
  assert.deepEqual(data.rgb_color, [255, 128, 0]);             // re-vivified hue
  assert.equal(data.brightness, 128);                          // brightness carried separately
  assert.equal(ha._buildTurnOnData({ r: 0, g: 0, b: 0 }), null); // black → caller turns off
});
