'use strict';
// Pure colour + layer math for the lighting bridge. No SDK, no DOM — unit-tested.

const clamp8 = n => Math.max(0, Math.min(255, Math.round(n)));

const NAMED = {
  rosso: '#ff0000', red: '#ff0000', verde: '#00ff00', green: '#00ff00',
  blu: '#0000ff', blue: '#0000ff', bianco: '#ffffff', white: '#ffffff',
  giallo: '#ffff00', yellow: '#ffff00', arancione: '#ff8000', orange: '#ff8000',
  viola: '#8000ff', purple: '#8000ff', rosa: '#ff40a0', pink: '#ff40a0',
  ciano: '#00ffff', cyan: '#00ffff', spento: '#000000', off: '#000000', nero: '#000000', black: '#000000',
};

function hexToRgb(hex) {
  const m = String(hex || '').trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return null;
  const h = m[1];
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

// Inverse of hexToRgb — the ONE place the '#rrggbb' string is built server-side.
function rgbToHex(c) {
  return '#' + [c.r, c.g, c.b].map(x => clamp8(x).toString(16).padStart(2, '0')).join('');
}

// Split a brightness-baked colour into its full-vivid hue + a separate level,
// for providers whose protocols carry colour and brightness apart (Home
// Assistant, Yeelight, Hue v2 — they renormalize a dim rgb back to full).
// Returns null for black: callers turn the light off instead.
function splitVivid(color) {
  const v = Math.max(color.r, color.g, color.b);
  if (v === 0) return null;
  const scale = 255 / v;
  return {
    vivid: { r: clamp8(color.r * scale), g: clamp8(color.g * scale), b: clamp8(color.b * scale) },
    level: v,                                       // 0-255
    pct: Math.max(1, Math.round((v / 255) * 100)),  // 1-100
  };
}

// CPU temperature → colour, as a natural thermal ramp that reads at a glance:
// cool BLUE when idle, GREEN when normal, YELLOW/ORANGE as it warms, RED when
// hot. Anchored to ABSOLUTE temperatures (not a 0..1 min/max scale) chosen for
// real CPUs — a CPU rarely drops near the old 35°C floor, so the everyday 50-70°C
// range used to sit in the blue→red midpoint and came out a confusing magenta.
// Below the first stop clamps to blue, above the last clamps to red; in between
// it interpolates linearly across the adjacent stops.
const TEMP_STOPS = [
  { t: 40, c: { r: 0,   g: 120, b: 255 } }, // idle     — cool blue
  { t: 55, c: { r: 0,   g: 200, b: 90  } }, // normal   — green
  { t: 70, c: { r: 255, g: 210, b: 0   } }, // warm     — yellow
  { t: 80, c: { r: 255, g: 110, b: 0   } }, // hot      — orange
  { t: 90, c: { r: 255, g: 30,  b: 0   } }, // very hot — red
];

function tempToColor(tempC) {
  const temp = Number(tempC);
  const first = TEMP_STOPS[0], last = TEMP_STOPS[TEMP_STOPS.length - 1];
  if (!Number.isFinite(temp) || temp <= first.t) return { ...first.c };
  if (temp >= last.t) return { ...last.c };
  for (let i = 1; i < TEMP_STOPS.length; i++) {
    const b = TEMP_STOPS[i];
    if (temp <= b.t) {
      const a = TEMP_STOPS[i - 1];
      const f = (temp - a.t) / (b.t - a.t);
      return {
        r: clamp8(a.c.r + (b.c.r - a.c.r) * f),
        g: clamp8(a.c.g + (b.c.g - a.c.g) * f),
        b: clamp8(a.c.b + (b.c.b - a.c.b) * f),
      };
    }
  }
  return { ...last.c };
}

function applyBrightness(color, scale) {
  const s = Math.max(0, Math.min(1, Number(scale)));
  return { r: clamp8(color.r * s), g: clamp8(color.g * s), b: clamp8(color.b * s) };
}

// Priority: override > overlay > album > animation > base; null layers fall
// through; black if all null. `album` is the now-playing cover colour — a steady
// ambient tint that sits above the chosen ambient `animation`, which in turn sits
// above the reactive temperature `base`; all yield to transient flashes (volume
// overlay, event) and to an explicit manual override.
function resolveColor(layers, brightness) {
  const picked = layers.override || layers.overlay || layers.album || layers.animation || layers.base || { r: 0, g: 0, b: 0 };
  return applyBrightness(picked, brightness == null ? 1 : brightness);
}

function parseColorName(input) {
  const raw = String(input || '').trim().toLowerCase();
  if (NAMED[raw]) return hexToRgb(NAMED[raw]);
  return hexToRgb(raw);
}

// LEGACY — the volume-flash effect was removed (lighting.js onAudio is a no-op);
// this stays exported only so old settings keep normalizing and the unit test
// keeps pinning the math. Do not wire new code to it.
function volumeToColor(volume, accent) {
  const base = (accent && typeof accent === 'object') ? accent : { r: 30, g: 215, b: 96 };
  return applyBrightness(base, Math.max(0, Math.min(100, Number(volume) || 0)) / 100);
}

// Sample an event-flash colour at nowMs. Returns {r,g,b} while playing, or null
// once finished (the caller then clears the event layer). `color` may be a hex
// string or an {r,g,b}. Styles: 'solid' (constant), 'blink' (~4 Hz on/off),
// 'pulse' (breathing brightness).
function eventColorAt(opts) {
  const o = opts || {};
  const c = (o.color && typeof o.color === 'object') ? o.color : (hexToRgb(o.color) || { r: 255, g: 0, b: 0 });
  const elapsed = Number(o.nowMs) - Number(o.startMs);
  const duration = Number(o.durationMs) || 0;
  if (!(elapsed >= 0) || elapsed >= duration) return null;
  if (o.style === 'solid') return { r: c.r, g: c.g, b: c.b };
  if (o.style === 'pulse') {
    const phase = elapsed / duration;                  // 0..1
    const b = 0.15 + 0.85 * Math.sin(Math.PI * phase); // ease in/out, never fully dark
    return applyBrightness(c, b);
  }
  // blink (default): 125 ms half-period → ~4 Hz
  const on = Math.floor(elapsed / 125) % 2 === 0;
  return on ? { r: c.r, g: c.g, b: c.b } : { r: 0, g: 0, b: 0 };
}

// HSV → RGB. h in degrees [0,360), s/v in [0,1]. Used by the cycle animation so a
// single rotating hue can drive every device with a uniform colour.
function hsvToRgb(h, s, v) {
  const hh = ((Number(h) % 360) + 360) % 360 / 60;
  const c = v * s;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (hh < 1) { r = c; g = x; }
  else if (hh < 2) { r = x; g = c; }
  else if (hh < 3) { g = c; b = x; }
  else if (hh < 4) { g = x; b = c; }
  else if (hh < 5) { r = x; b = c; }
  else { r = c; b = x; }
  return { r: clamp8((r + m) * 255), g: clamp8((g + m) * 255), b: clamp8((b + m) * 255) };
}

// Spread a 2-3 colour palette across `count` LEDs as a smooth multi-stop
// gradient (palette[0] at LED 0 → last colour at the last LED). Pure + cheap:
// called only when the palette changes, never per tick. Returns an array of
// `count` {r,g,b}; a single-colour palette (or count 1) degrades to uniform.
function paletteGradient(palette, count) {
  const stops = (Array.isArray(palette) ? palette : []).filter(c => c && typeof c === 'object');
  const n = Math.max(0, Math.round(Number(count) || 0));
  if (!n || !stops.length) return [];
  if (stops.length === 1 || n === 1) return Array(n).fill(null).map(() => ({ ...stops[0] }));
  const out = new Array(n);
  const segs = stops.length - 1;
  for (let i = 0; i < n; i++) {
    const pos = (i / (n - 1)) * segs;        // 0..segs across the strip
    const si = Math.min(segs - 1, Math.floor(pos));
    const f = pos - si;
    const a = stops[si], b = stops[si + 1];
    out[i] = {
      r: clamp8(a.r + (b.r - a.r) * f),
      g: clamp8(a.g + (b.g - a.g) * f),
      b: clamp8(a.b + (b.b - a.b) * f),
    };
  }
  return out;
}

// Map a 1..100 speed onto a period in ms (high speed → short period).
function speedToPeriod(speed, slowMs, fastMs) {
  const s = Math.max(1, Math.min(100, Number(speed) || 50));
  return Math.round(slowMs + (fastMs - slowMs) * (s - 1) / 99);
}

// Quantize the sampled phase so consecutive slow ticks produce the SAME colour
// and the per-device on-change write guard turns most 66ms ticks into free no-ops.
const quantHue = h => ((Math.round(h / 3) * 3) % 360 + 360) % 360;  // ~3° hue steps
const quantLevel = v => Math.round(v * 64) / 64;                    // 1/64 brightness steps

// Deterministic candle flicker level for `nowMs` — layered detuned sines stand in
// for noise (no Math.random, so the flame is reproducible and unit-testable).
// Returns a brightness in [0.25, 0.95]; `speed` scales the flicker rate.
function candleLevel(nowMs, speed) {
  const s = Math.max(1, Math.min(100, Number(speed) || 50));
  const t = (Number(nowMs) || 0) / 1000 * (0.6 + s / 50);
  const n = 0.62
    + 0.20 * Math.sin(t * 7.3)
    + 0.11 * Math.sin(t * 17.9 + 1.3)
    + 0.07 * Math.sin(t * 31.7 + 4.1);
  return Math.max(0.25, Math.min(0.95, n));
}

const CANDLE_WARM = { r: 255, g: 147, b: 41 };   // default flame colour

// Normalize a user palette (hex strings or {r,g,b}) to colour objects.
function paletteStops(palette) {
  return (Array.isArray(palette) ? palette : [])
    .map(c => (c && typeof c === 'object') ? c : hexToRgb(c))
    .filter(Boolean);
}

// Ambient styles that paint a spatial per-LED spread on capable devices (iCUE).
// Everything else — and every provider without per-LED writes — gets the uniform
// animationColorAt sample.
function isSpatialAnimation(style) { return style === 'wave' || style === 'palette'; }

// Sample an ambient animation colour at nowMs. Pure + cheap so the render loop
// can call it every tick; the caller skips the device write when the quantized
// colour is unchanged (most ticks are a no-op). Returns the whole-device uniform
// colour, or null for 'none' (no animation layer → reactive/base stays in charge).
//   - solid:     constant `color`
//   - breathing: `color` with brightness easing in/out (never fully dark)
//   - cycle:     full-spectrum hue rotation (rainbow on a uniform device)
//   - wave:      uniform sample = same hue rotation as cycle (the spatial spread
//                lives in animationGradientAt for per-LED-capable devices)
//   - aurora:    two hues drifting through the green→blue→purple band, blended
//                with a slow brightness swell — exactly periodic (integer
//                harmonics of one base phase, no seam at the wrap)
//   - candle:    warm flame flicker (deterministic — see candleLevel)
//   - palette:   walks the user's 2–5 colours in a smooth wrapping blend
function animationColorAt(opts) {
  const o = opts || {};
  const style = o.style || 'none';
  if (style === 'none') return null;
  const now = Number(o.nowMs) || 0;
  if (style === 'palette') {
    const stops = paletteStops(o.palette);
    if (!stops.length) return null;
    if (stops.length === 1) return { ...stops[0] };
    const period = speedToPeriod(o.speed, 24000, 3000);
    const pos = ((now % period) / period) * stops.length;    // walk stop→stop, wrapping
    const si = Math.floor(pos) % stops.length;
    const f = quantLevel(pos - Math.floor(pos));
    const a = stops[si], b = stops[(si + 1) % stops.length];
    return {
      r: clamp8(a.r + (b.r - a.r) * f),
      g: clamp8(a.g + (b.g - a.g) * f),
      b: clamp8(a.b + (b.b - a.b) * f),
    };
  }
  const base = (o.color && typeof o.color === 'object') ? o.color
    : (hexToRgb(o.color) || (style === 'candle' ? CANDLE_WARM : { r: 30, g: 215, b: 96 }));
  if (style === 'candle') return applyBrightness(base, quantLevel(candleLevel(now, o.speed)));
  if (style === 'solid') return { r: base.r, g: base.g, b: base.b };
  if (style === 'breathing') {
    const period = speedToPeriod(o.speed, 6000, 900);
    const phase = (now % period) / period;                 // 0..1
    const b = 0.18 + 0.82 * (0.5 - 0.5 * Math.cos(2 * Math.PI * phase));
    return applyBrightness(base, quantLevel(b));
  }
  if (style === 'cycle' || style === 'wave') {
    const period = speedToPeriod(o.speed, 30000, 2500);
    const hue = quantHue(((now % period) / period) * 360);
    return hsvToRgb(hue, 1, 1);
  }
  if (style === 'aurora') {
    const period = speedToPeriod(o.speed, 45000, 6000);
    const t = ((now % period) / period) * 2 * Math.PI;     // one base phase; harmonics keep it periodic
    const h1 = 150 + 60 * Math.sin(t);                     // green ↔ blue
    const h2 = 235 + 45 * Math.sin(2 * t + 2.1);           // blue ↔ purple
    const mix = 0.5 + 0.5 * Math.sin(3 * t + 0.7);
    const hue = quantHue(h1 * (1 - mix) + h2 * mix);
    const v = quantLevel(0.55 + 0.35 * (0.5 + 0.5 * Math.sin(2 * t + 1.9)));
    return hsvToRgb(hue, 0.85, v);
  }
  return null;
}

// Scalar identity of the spatial frame at nowMs — the quantized phase (wave) or
// integer LED shift (palette). Callers use it as the cheap on-change key and to
// SKIP building the full per-LED array when the frame hasn't advanced (at 15fps
// with slow speeds, most ticks haven't). Null for uniform-only styles.
function animationFrameKey(opts, count) {
  const o = opts || {};
  const now = Number(o.nowMs) || 0;
  const n = Math.max(0, Math.round(Number(count) || 0));
  if (o.style === 'wave') {
    const period = speedToPeriod(o.speed, 30000, 2500);
    return 'w' + quantHue(((now % period) / period) * 360);
  }
  if (o.style === 'palette') {
    const period = speedToPeriod(o.speed, 24000, 3000);
    return 'p' + (n ? Math.floor(((now % period) / period) * n) : 0);
  }
  return null;
}

// Spatial per-LED sample for the styles that support it (wave, palette): returns
// `count` colours for this instant, or null when the style is uniform-only (the
// caller then falls back to animationColorAt). Frame identity is quantized the
// same way as animationFrameKey, so key and frame always agree.
function animationGradientAt(opts, count) {
  const o = opts || {};
  const n = Math.max(0, Math.round(Number(count) || 0));
  if (!n) return null;
  const now = Number(o.nowMs) || 0;
  if (o.style === 'wave') {
    const period = speedToPeriod(o.speed, 30000, 2500);
    const phase = ((now % period) / period) * 360;
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = hsvToRgb(quantHue(phase + (i / n) * 360), 1, 1);
    return out;
  }
  if (o.style === 'palette') {
    const stops = paletteStops(o.palette);
    if (stops.length < 2) return null;
    const period = speedToPeriod(o.speed, 24000, 3000);
    const shift = Math.floor(((now % period) / period) * n);   // integer-LED rotation
    // CYCLIC gradient: append the first stop so the last LED blends back toward
    // it — rotating a linear (album-style) gradient would march a hard seam
    // across the device every cycle.
    const grad = paletteGradient(stops.concat([stops[0]]), n + 1);
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = grad[(i + shift) % n];
    return out;
  }
  return null;
}

module.exports = { clamp8, hexToRgb, rgbToHex, splitVivid, hsvToRgb, tempToColor, applyBrightness, resolveColor, parseColorName, volumeToColor, eventColorAt, animationColorAt, animationGradientAt, animationFrameKey, candleLevel, isSpatialAnimation, speedToPeriod, paletteGradient };
