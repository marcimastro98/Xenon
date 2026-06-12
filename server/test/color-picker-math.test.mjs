import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { hexToRgb, rgbToHex, rgbToHsv, hsvToRgb } = require('../js/color-picker.js');

test('hexToRgb parses #rrggbb (with or without #) and rejects junk', () => {
  assert.deepEqual(hexToRgb('#1ed760'), [0x1e, 0xd7, 0x60]);
  assert.deepEqual(hexToRgb('1ED760'), [0x1e, 0xd7, 0x60]);
  assert.equal(hexToRgb('#abc'), null);
  assert.equal(hexToRgb('not-a-colour'), null);
  assert.equal(hexToRgb(''), null);
});

test('rgbToHex clamps and pads', () => {
  assert.equal(rgbToHex(255, 0, 8), '#ff0008');
  assert.equal(rgbToHex(300, -5, 12.6), '#ff000d');
});

test('hex → hsv → hex roundtrip is lossless-ish for every swatch', () => {
  const swatches = ['#ff3b30', '#ffcc00', '#34c759', '#2b6cff', '#af52de', '#e7e9ee', '#8e8e93', '#000000', '#ffffff'];
  for (const hex of swatches) {
    const [h, s, v] = rgbToHsv(...hexToRgb(hex));
    const back = rgbToHex(...hsvToRgb(h, s, v));
    // Allow ±1 per channel for float rounding.
    const a = hexToRgb(hex), b = hexToRgb(back);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(a[i] - b[i]) <= 1, `${hex} → ${back}`);
  }
});

test('rgbToHsv puts primaries on the expected hue', () => {
  assert.equal(Math.round(rgbToHsv(255, 0, 0)[0]), 0);
  assert.equal(Math.round(rgbToHsv(0, 255, 0)[0]), 120);
  assert.equal(Math.round(rgbToHsv(0, 0, 255)[0]), 240);
});
