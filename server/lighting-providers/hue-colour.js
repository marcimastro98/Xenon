'use strict';
// Turns a red-green-blue colour into what a Hue light takes, in the old and in the new form of
// the bridge's interface.

const fx = require('../lighting-effects.js');

// RGB (0..255, brightness baked in) → CIE xy + brightness% for CLIP v2. Pure.
function rgbToXy(c) {
  const lin = (v) => { const n = v / 255; return n > 0.04045 ? Math.pow((n + 0.055) / 1.055, 2.4) : n / 12.92; };
  const r = lin(c.r), g = lin(c.g), b = lin(c.b);
  const X = r * 0.4124 + g * 0.3576 + b * 0.1805;
  const Y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const Z = r * 0.0193 + g * 0.1192 + b * 0.9505;
  const sum = X + Y + Z;
  if (!sum) return { x: 0.3127, y: 0.329 };   // black → neutral white point
  return { x: Number((X / sum).toFixed(4)), y: Number((Y / sum).toFixed(4)) };
}

// CLIP v2 state body for a colour write. Pure — unit-tested.
function buildV2State(color) {
  const s = fx.splitVivid(color);
  if (!s) return { on: { on: false } };
  return {
    on: { on: true },
    dimming: { brightness: s.pct },
    color: { xy: rgbToXy(color) },   // chromaticity — scale-independent, so the baked colour is fine
  };
}

// RGB (0..255, brightness already baked in) → Hue hue/sat/bri state.
function rgbToHueState(c) {
  const r = c.r / 255, g = c.g / 255, b = c.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  const v = max;
  return { on: v > 0, hue: Math.round(h / 360 * 65535), sat: Math.round(s * 254), bri: Math.max(1, Math.round(v * 254)) };
}

module.exports = { rgbToXy, buildV2State, rgbToHueState };
