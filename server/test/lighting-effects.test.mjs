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

// --- v4.0 ambient styles: wave / aurora / candle / palette ---

test('animationColorAt wave (uniform sample) rotates like cycle', () => {
  const a = fx.animationColorAt({ style: 'wave', speed: 50, nowMs: 0 });
  const b = fx.animationColorAt({ style: 'wave', speed: 50, nowMs: 5000 });
  assert.ok(a && b);
  assert.notDeepEqual(a, b); // hue advanced over time
});

test('animationColorAt aurora stays vivid, is periodic (no seam at the wrap)', () => {
  const period = fx.speedToPeriod(50, 45000, 6000);
  const start = fx.animationColorAt({ style: 'aurora', speed: 50, nowMs: 0 });
  const wrap = fx.animationColorAt({ style: 'aurora', speed: 50, nowMs: period });
  assert.deepEqual(start, wrap);                       // exactly periodic
  for (const t of [0, 1000, 5000, 12000, 20000]) {
    const c = fx.animationColorAt({ style: 'aurora', speed: 50, nowMs: t });
    assert.ok(c.r >= 0 && c.g >= 0 && c.b >= 0);
    assert.ok(c.g > 0 || c.b > 0, 'aurora should live in the green/blue/purple band');
  }
});

test('candleLevel is deterministic, bounded, and speed-sensitive', () => {
  assert.equal(fx.candleLevel(1234, 50), fx.candleLevel(1234, 50)); // deterministic
  for (let t = 0; t < 20000; t += 137) {
    const v = fx.candleLevel(t, 50);
    assert.ok(v >= 0.25 && v <= 0.95, `level out of range at ${t}: ${v}`);
  }
  assert.notEqual(fx.candleLevel(5000, 1), fx.candleLevel(5000, 100)); // speed shifts the flicker
});

test('animationColorAt candle flickers a warm default colour', () => {
  const c = fx.animationColorAt({ style: 'candle', speed: 50, nowMs: 777 });
  assert.ok(c.r > c.g && c.g > c.b, 'candle default should be warm (r > g > b)');
  const later = fx.animationColorAt({ style: 'candle', speed: 50, nowMs: 3777 });
  assert.notDeepEqual(c, later); // brightness flickers over time
});

test('animationColorAt palette walks the user colours and wraps', () => {
  const pal = ['#ff0000', '#0000ff'];
  const period = fx.speedToPeriod(50, 24000, 3000);
  const atStart = fx.animationColorAt({ style: 'palette', palette: pal, speed: 50, nowMs: 0 });
  assert.deepEqual(atStart, { r: 255, g: 0, b: 0 });   // stop 0 exactly at phase 0
  const mid = fx.animationColorAt({ style: 'palette', palette: pal, speed: 50, nowMs: period / 4 });
  assert.ok(mid.r < 255 && mid.b > 0, 'quarter period = blending toward the next stop');
  const wrap = fx.animationColorAt({ style: 'palette', palette: pal, speed: 50, nowMs: period });
  assert.deepEqual(wrap, atStart);                     // wraps back to stop 0
});

test('animationColorAt palette degrades: 1 colour → constant, none → null', () => {
  assert.deepEqual(fx.animationColorAt({ style: 'palette', palette: ['#00ff00'], nowMs: 123 }), { r: 0, g: 255, b: 0 });
  assert.equal(fx.animationColorAt({ style: 'palette', palette: [], nowMs: 123 }), null);
});

test('animationGradientAt wave spreads the full hue circle across the LEDs', () => {
  const g = fx.animationGradientAt({ style: 'wave', speed: 50, nowMs: 0 }, 12);
  assert.equal(g.length, 12);
  const distinct = new Set(g.map(c => `${c.r},${c.g},${c.b}`));
  assert.ok(distinct.size >= 8, 'wave should paint many distinct hues at once');
  const shifted = fx.animationGradientAt({ style: 'wave', speed: 50, nowMs: 5000 }, 12);
  assert.notDeepEqual(g, shifted); // the wave scrolls
});

test('animationGradientAt palette rotates the gradient by whole LEDs', () => {
  const pal = ['#ff0000', '#0000ff'];
  const period = fx.speedToPeriod(50, 24000, 3000);
  const g0 = fx.animationGradientAt({ style: 'palette', palette: pal, speed: 50, nowMs: 0 }, 10);
  assert.equal(g0.length, 10);
  const g1 = fx.animationGradientAt({ style: 'palette', palette: pal, speed: 50, nowMs: period / 2 }, 10);
  assert.deepEqual(g1[0], g0[5]); // rotated by half the strip at half period
});

test('animationGradientAt returns null for uniform-only styles', () => {
  assert.equal(fx.animationGradientAt({ style: 'breathing', color: '#ffffff', nowMs: 0 }, 10), null);
  assert.equal(fx.animationGradientAt({ style: 'aurora', nowMs: 0 }, 10), null);
  assert.equal(fx.animationGradientAt({ style: 'candle', nowMs: 0 }, 10), null);
});

test('isSpatialAnimation flags only wave and palette', () => {
  assert.ok(fx.isSpatialAnimation('wave'));
  assert.ok(fx.isSpatialAnimation('palette'));
  assert.ok(!fx.isSpatialAnimation('cycle'));
  assert.ok(!fx.isSpatialAnimation('aurora'));
});

test('quantization: consecutive close ticks sample the SAME colour (free no-op writes)', () => {
  // 66ms apart on a slow cycle: the ~3° hue quantum hasn't advanced.
  const a = fx.animationColorAt({ style: 'cycle', speed: 1, nowMs: 10000 });
  const b = fx.animationColorAt({ style: 'cycle', speed: 1, nowMs: 10066 });
  assert.deepEqual(a, b);
  const c1 = fx.animationColorAt({ style: 'candle', speed: 1, nowMs: 50000 });
  const c2 = fx.animationColorAt({ style: 'candle', speed: 1, nowMs: 50008 });
  assert.deepEqual(c1, c2); // 1/64 level quantum
});

test('eventColorAt honours a custom durationMs window', () => {
  const o = { style: 'solid', color: '#ff0000', startMs: 0, durationMs: 5000 };
  assert.deepEqual(fx.eventColorAt({ ...o, nowMs: 4999 }), { r: 255, g: 0, b: 0 });
  assert.equal(fx.eventColorAt({ ...o, nowMs: 5000 }), null);
});

test('rgbToHex is the inverse of hexToRgb and clamps', () => {
  assert.equal(fx.rgbToHex({ r: 30, g: 215, b: 96 }), '#1ed760');
  assert.deepEqual(fx.hexToRgb(fx.rgbToHex({ r: 255, g: 0, b: 128 })), { r: 255, g: 0, b: 128 });
  assert.equal(fx.rgbToHex({ r: 300, g: -5, b: 0 }), '#ff0000'); // clamped
});

test('splitVivid separates baked brightness from the hue; black → null', () => {
  const s = fx.splitVivid({ r: 128, g: 64, b: 0 });   // half-bright orange
  assert.deepEqual(s.vivid, { r: 255, g: 128, b: 0 });
  assert.equal(s.level, 128);
  assert.equal(s.pct, 50);
  assert.equal(fx.splitVivid({ r: 0, g: 0, b: 0 }), null);
  assert.equal(fx.splitVivid({ r: 255, g: 255, b: 255 }).pct, 100);
});

test('animationFrameKey identifies frames: advances with phase, null for uniform styles', () => {
  // Wave: same quantized hue within a quantum, different across a big step.
  assert.equal(
    fx.animationFrameKey({ style: 'wave', speed: 1, nowMs: 10000 }, 60),
    fx.animationFrameKey({ style: 'wave', speed: 1, nowMs: 10066 }, 60));
  assert.notEqual(
    fx.animationFrameKey({ style: 'wave', speed: 50, nowMs: 0 }, 60),
    fx.animationFrameKey({ style: 'wave', speed: 50, nowMs: 5000 }, 60));
  // Palette: the key IS the integer LED shift — it advances even when the first
  // gradient stop happens to be unchanged (flat segments must not freeze frames).
  const period = fx.speedToPeriod(50, 24000, 3000);
  assert.equal(fx.animationFrameKey({ style: 'palette', speed: 50, nowMs: 0 }, 10), 'p0');
  assert.equal(fx.animationFrameKey({ style: 'palette', speed: 50, nowMs: period / 2 }, 10), 'p5');
  assert.equal(fx.animationFrameKey({ style: 'breathing', nowMs: 0 }, 10), null);
});

test('spatial palette gradient is cyclic — no hard seam when rotating', () => {
  const pal = ['#ff0000', '#0000ff'];
  const g = fx.animationGradientAt({ style: 'palette', palette: pal, speed: 50, nowMs: 0 }, 10);
  // The last LED must blend back toward the first stop, not sit at pure blue
  // next to pure red (that seam would march across the device while rotating).
  const last = g[9];
  assert.ok(last.r > last.b, `expected the tail to lean back toward red, got ${JSON.stringify(last)}`);
});
