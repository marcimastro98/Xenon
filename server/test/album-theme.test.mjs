import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pickAccent, rgbToHsl, hslToRgb } = require('../js/album-theme.js');

// Build a flat RGBA pixel array from [r,g,b,count] runs — the same shape
// pickAccent reads from a canvas ImageData.
function pixels(...runs) {
  const out = [];
  for (const [r, g, b, n] of runs) {
    for (let i = 0; i < n; i++) out.push(r, g, b, 255);
  }
  return Uint8ClampedArray.from(out);
}

test('pickAccent: a vivid cover yields accent + led + palette', () => {
  const pair = pickAccent(pixels([230, 30, 40, 400]));
  assert.ok(pair, 'expected a colour pair');
  assert.match(pair.accent, /^#[0-9a-f]{6}$/);
  assert.match(pair.led, /^#[0-9a-f]{6}$/);
  assert.ok(Array.isArray(pair.ledPalette) && pair.ledPalette.length >= 1);
  // The LED variant must be highly saturated (that was the whole point).
  const [r, g, b] = [1, 3, 5].map(i => parseInt(pair.led.slice(i, i + 2), 16));
  const [, s] = rgbToHsl(r, g, b);
  assert.ok(s >= 0.75, `led saturation ${s} should be vivid`);
});

test('pickAccent: a greyscale cover falls back to null', () => {
  const pair = pickAccent(pixels([120, 120, 120, 300], [180, 180, 180, 300]));
  assert.equal(pair, null);
});

test('pickAccent: three distinct bands produce a 3-colour palette, dominant first', () => {
  const pair = pickAccent(pixels(
    [230, 25, 35, 500],   // red — most pixels → dominant
    [25, 85, 230, 300],   // blue
    [25, 230, 75, 200],   // green
  ));
  assert.ok(pair);
  assert.equal(pair.ledPalette.length, 3);
  assert.equal(pair.ledPalette[0], pair.led, 'palette starts with the dominant LED colour');
  // All three palette entries are distinct.
  assert.equal(new Set(pair.ledPalette).size, 3);
});

test('pickAccent: near-identical hues collapse into one palette entry', () => {
  const pair = pickAccent(pixels(
    [230, 25, 35, 400],   // red
    [235, 45, 30, 300],   // nearly the same red
  ));
  assert.ok(pair);
  assert.equal(pair.ledPalette.length, 1, 'no fake gradient from one-hue covers');
});

test('pickAccent: a dark muted cover still yields its hue (loosened mono guard)', () => {
  const pair = pickAccent(pixels([60, 40, 90, 600]));   // dark muted purple
  assert.ok(pair, 'dark covers should not be rejected as grey');
});

test('hslToRgb/rgbToHsl roundtrip preserves the hue', () => {
  const [h] = rgbToHsl(200, 60, 30);
  const [r, g, b] = hslToRgb(h, 0.9, 0.5);
  const [h2] = rgbToHsl(r, g, b);
  assert.ok(Math.abs(h - h2) < 0.02, `hue drifted: ${h} → ${h2}`);
});
