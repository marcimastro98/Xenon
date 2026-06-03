import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fx = require('../lighting-effects.js');

test('tempToColor maps cool→warm across the range', () => {
  const cold = fx.tempToColor(20, { min: 35, max: 85 }); // clamped to min → blue
  assert.deepEqual(cold, { r: 0, g: 120, b: 255 });
  const hot = fx.tempToColor(95, { min: 35, max: 85 });  // clamped to max → red
  assert.deepEqual(hot, { r: 255, g: 40, b: 0 });
  const mid = fx.tempToColor(60, { min: 35, max: 85 });  // halfway
  assert.equal(mid.r, 128); assert.equal(mid.g, 80); assert.equal(mid.b, 128);
});

test('applyBrightness scales channels and clamps to 0..255 ints', () => {
  assert.deepEqual(fx.applyBrightness({ r: 200, g: 100, b: 50 }, 0.5), { r: 100, g: 50, b: 25 });
  assert.deepEqual(fx.applyBrightness({ r: 200, g: 100, b: 50 }, 0), { r: 0, g: 0, b: 0 });
});

test('resolveColor honours priority override > overlay > album > base', () => {
  const base = { r: 1, g: 1, b: 1 }, overlay = { r: 2, g: 2, b: 2 }, override = { r: 3, g: 3, b: 3 }, album = { r: 4, g: 4, b: 4 };
  assert.deepEqual(fx.resolveColor({ base, overlay, album, override }, 1), { r: 3, g: 3, b: 3 });
  assert.deepEqual(fx.resolveColor({ base, overlay, album, override: null }, 1), { r: 2, g: 2, b: 2 });
  assert.deepEqual(fx.resolveColor({ base, overlay: null, album, override: null }, 1), { r: 4, g: 4, b: 4 }); // album beats base
  assert.deepEqual(fx.resolveColor({ base, overlay: null, album: null, override: null }, 1), { r: 1, g: 1, b: 1 });
  assert.deepEqual(fx.resolveColor({ base: null, overlay: null, album: null, override: null }, 1), { r: 0, g: 0, b: 0 });
});

test('parseColorName accepts hex and common EN/IT names, else null', () => {
  assert.deepEqual(fx.parseColorName('#ff0000'), { r: 255, g: 0, b: 0 });
  assert.deepEqual(fx.parseColorName('rosso'), { r: 255, g: 0, b: 0 });
  assert.deepEqual(fx.parseColorName('red'), { r: 255, g: 0, b: 0 });
  assert.equal(fx.parseColorName('banana'), null);
});

test('eventColorAt solid holds the colour then ends', () => {
  const o = { style: 'solid', color: '#ff0000', startMs: 0, durationMs: 1000 };
  assert.deepEqual(fx.eventColorAt({ ...o, nowMs: 0 }), { r: 255, g: 0, b: 0 });
  assert.deepEqual(fx.eventColorAt({ ...o, nowMs: 500 }), { r: 255, g: 0, b: 0 });
  assert.equal(fx.eventColorAt({ ...o, nowMs: 1000 }), null);
});

test('eventColorAt blink toggles colour and off', () => {
  const o = { style: 'blink', color: '#00ff00', startMs: 0, durationMs: 1000 };
  assert.deepEqual(fx.eventColorAt({ ...o, nowMs: 0 }), { r: 0, g: 255, b: 0 });   // on
  assert.deepEqual(fx.eventColorAt({ ...o, nowMs: 125 }), { r: 0, g: 0, b: 0 });   // off
  assert.deepEqual(fx.eventColorAt({ ...o, nowMs: 250 }), { r: 0, g: 255, b: 0 }); // on
});

test('eventColorAt pulse stays in range and ends at duration', () => {
  const o = { style: 'pulse', color: '#ffffff', startMs: 0, durationMs: 1000 };
  const mid = fx.eventColorAt({ ...o, nowMs: 500 });
  assert.ok(mid.r >= 0 && mid.r <= 255 && mid.g >= 0 && mid.b <= 255);
  assert.equal(fx.eventColorAt({ ...o, nowMs: 1000 }), null);
});

test('eventColorAt accepts an {r,g,b} colour and rejects out-of-window', () => {
  assert.deepEqual(fx.eventColorAt({ style: 'solid', color: { r: 1, g: 2, b: 3 }, startMs: 0, durationMs: 100, nowMs: 50 }), { r: 1, g: 2, b: 3 });
  assert.equal(fx.eventColorAt({ style: 'solid', color: { r: 1, g: 2, b: 3 }, startMs: 0, durationMs: 100, nowMs: 200 }), null);
});
