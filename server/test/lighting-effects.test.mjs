import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fx = require('../lighting-effects.js');

test('tempToColor maps a natural thermal ramp (blue→green→yellow→red)', () => {
  assert.deepEqual(fx.tempToColor(30), { r: 0, g: 120, b: 255 }); // below idle floor → cool blue
  assert.deepEqual(fx.tempToColor(55), { r: 0, g: 200, b: 90 });  // normal → green (exact stop)
  assert.deepEqual(fx.tempToColor(95), { r: 255, g: 30, b: 0 });  // above hot ceiling → red
  // ~67°C (a normal load temp) now reads yellow, not the old confusing magenta:
  const warm = fx.tempToColor(67);
  assert.ok(warm.r > 180 && warm.g > 180 && warm.b < 60, `expected yellow-ish, got ${JSON.stringify(warm)}`);
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

test('resolveColor: animation sits above base, below album', () => {
  const base = { r: 1, g: 1, b: 1 }, animation = { r: 5, g: 5, b: 5 }, album = { r: 4, g: 4, b: 4 };
  assert.deepEqual(fx.resolveColor({ base, animation, album: null, overlay: null, override: null }, 1), { r: 5, g: 5, b: 5 }); // animation beats base
  assert.deepEqual(fx.resolveColor({ base, animation, album, overlay: null, override: null }, 1), { r: 4, g: 4, b: 4 });     // album beats animation
  assert.deepEqual(fx.resolveColor({ base, overlay: null, album: null, override: null }, 1), { r: 1, g: 1, b: 1 });          // no animation key → base (back-compat)
});

test('hsvToRgb maps primary hues', () => {
  assert.deepEqual(fx.hsvToRgb(0, 1, 1), { r: 255, g: 0, b: 0 });
  assert.deepEqual(fx.hsvToRgb(120, 1, 1), { r: 0, g: 255, b: 0 });
  assert.deepEqual(fx.hsvToRgb(240, 1, 1), { r: 0, g: 0, b: 255 });
  assert.deepEqual(fx.hsvToRgb(360, 1, 1), { r: 255, g: 0, b: 0 }); // wraps
});

test('animationColorAt: none→null, solid constant, breathing in-range, cycle rotates', () => {
  assert.equal(fx.animationColorAt({ style: 'none' }), null);
  assert.deepEqual(fx.animationColorAt({ style: 'solid', color: '#1ed760' }), { r: 30, g: 215, b: 96 });
  const br = fx.animationColorAt({ style: 'breathing', color: '#ffffff', speed: 50, nowMs: 1234 });
  assert.ok(br.r >= 0 && br.r <= 255);
  const a = fx.animationColorAt({ style: 'cycle', speed: 50, nowMs: 0 });
  const b = fx.animationColorAt({ style: 'cycle', speed: 50, nowMs: 5000 });
  assert.notDeepEqual(a, b); // hue advanced over time
});

test('speedToPeriod is monotonic (faster speed → shorter period)', () => {
  assert.ok(fx.speedToPeriod(1, 6000, 900) > fx.speedToPeriod(100, 6000, 900));
  assert.equal(fx.speedToPeriod(1, 6000, 900), 6000);
  assert.equal(fx.speedToPeriod(100, 6000, 900), 900);
});

test('paletteGradient spreads stops across LEDs (ends exact, middle blended)', () => {
  const red = { r: 255, g: 0, b: 0 }, blue = { r: 0, g: 0, b: 255 };
  const g = fx.paletteGradient([red, blue], 5);
  assert.equal(g.length, 5);
  assert.deepEqual(g[0], red);                 // first LED = first stop
  assert.deepEqual(g[4], blue);                // last LED = last stop
  assert.deepEqual(g[2], { r: 128, g: 0, b: 128 }); // midpoint blend
});

test('paletteGradient handles 3 stops (middle stop lands mid-strip)', () => {
  const red = { r: 255, g: 0, b: 0 }, green = { r: 0, g: 255, b: 0 }, blue = { r: 0, g: 0, b: 255 };
  const g = fx.paletteGradient([red, green, blue], 9);
  assert.deepEqual(g[0], red);
  assert.deepEqual(g[4], green);               // exact centre LED = middle stop
  assert.deepEqual(g[8], blue);
});

test('paletteGradient degrades gracefully (1 colour → uniform, bad input → empty)', () => {
  const red = { r: 255, g: 0, b: 0 };
  assert.deepEqual(fx.paletteGradient([red], 3), [red, red, red]);
  assert.deepEqual(fx.paletteGradient([red, { r: 0, g: 0, b: 255 }], 1), [red]);
  assert.deepEqual(fx.paletteGradient([], 4), []);
  assert.deepEqual(fx.paletteGradient(null, 4), []);
  assert.deepEqual(fx.paletteGradient([red], 0), []);
});
