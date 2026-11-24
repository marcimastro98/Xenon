'use strict';
// The small colour sums the lighting effects are built from: a channel kept between 0 and 255,
// a hex colour read and written, hue, saturation and value turned into red, green and blue, a
// brightness applied, and a few colours spread along a strip.

const clamp8 = n => Math.max(0, Math.min(255, Math.round(n)));

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

function applyBrightness(color, scale) {
  const s = Math.max(0, Math.min(1, Number(scale)));
  return { r: clamp8(color.r * s), g: clamp8(color.g * s), b: clamp8(color.b * s) };
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

module.exports = { clamp8, hexToRgb, rgbToHex, applyBrightness, hsvToRgb, paletteGradient };
