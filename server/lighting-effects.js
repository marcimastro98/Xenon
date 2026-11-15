'use strict';
// Pure colour + layer math for the lighting bridge. No SDK, no DOM — unit-tested.

const {
  clamp8, hexToRgb, rgbToHex, applyBrightness, hsvToRgb,
} = require('./lights/colour-basics.js');

const NAMED = {
  rosso: '#ff0000', red: '#ff0000', verde: '#00ff00', green: '#00ff00',
  blu: '#0000ff', blue: '#0000ff', bianco: '#ffffff', white: '#ffffff',
  giallo: '#ffff00', yellow: '#ffff00', arancione: '#ff8000', orange: '#ff8000',
  viola: '#8000ff', purple: '#8000ff', rosa: '#ff40a0', pink: '#ff40a0',
  ciano: '#00ffff', cyan: '#00ffff', spento: '#000000', off: '#000000', nero: '#000000', black: '#000000',
};

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

// LEGACY — the volume-flash effect was removed (server/lights/feeds.js onAudio is a no-op);
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

const {
  paletteGradient, speedToPeriod, candleLevel, isSpatialAnimation, animationColorAt,
  animationFrameKey, animationGradientAt,
} = require('./lights/animation-colours.js');


module.exports = { clamp8, hexToRgb, rgbToHex, splitVivid, hsvToRgb, tempToColor, applyBrightness, resolveColor, parseColorName, volumeToColor, eventColorAt, animationColorAt, animationGradientAt, animationFrameKey, candleLevel, isSpatialAnimation, speedToPeriod, paletteGradient };
