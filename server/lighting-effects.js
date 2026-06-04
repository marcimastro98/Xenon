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

// CPU temp → cool blue (min) ramping to warm red (max).
function tempToColor(tempC, opts) {
  const min = opts && opts.min != null ? opts.min : 35;
  const max = opts && opts.max != null ? opts.max : 85;
  const t = Math.max(0, Math.min(1, (Number(tempC) - min) / (max - min || 1)));
  const cool = { r: 0, g: 120, b: 255 };
  const warm = { r: 255, g: 40, b: 0 };
  return {
    r: clamp8(cool.r + (warm.r - cool.r) * t),
    g: clamp8(cool.g + (warm.g - cool.g) * t),
    b: clamp8(cool.b + (warm.b - cool.b) * t),
  };
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

// Volume (0..100) → accent colour scaled by level (for the volume overlay).
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

// Map a 1..100 speed onto a period in ms (high speed → short period).
function speedToPeriod(speed, slowMs, fastMs) {
  const s = Math.max(1, Math.min(100, Number(speed) || 50));
  return Math.round(slowMs + (fastMs - slowMs) * (s - 1) / 99);
}

// Sample an ambient animation colour at nowMs. Pure + cheap so the render loop
// can call it every tick; the caller skips the device write when the rounded
// colour is unchanged (most ticks are a no-op). Whole-device uniform colour only
// (spatial per-LED effects are a later phase). Returns {r,g,b}, or null for
// 'none' (no animation layer → reactive/base behaviour stays in charge).
//   - solid:     constant `color`
//   - breathing: `color` with brightness easing in/out (never fully dark)
//   - cycle:     full-spectrum hue rotation (a.k.a. rainbow for a uniform device)
function animationColorAt(opts) {
  const o = opts || {};
  const style = o.style || 'none';
  if (style === 'none') return null;
  const base = (o.color && typeof o.color === 'object') ? o.color : (hexToRgb(o.color) || { r: 30, g: 215, b: 96 });
  if (style === 'solid') return { r: base.r, g: base.g, b: base.b };
  const now = Number(o.nowMs) || 0;
  if (style === 'breathing') {
    const period = speedToPeriod(o.speed, 6000, 900);
    const phase = (now % period) / period;                 // 0..1
    const b = 0.18 + 0.82 * (0.5 - 0.5 * Math.cos(2 * Math.PI * phase));
    return applyBrightness(base, b);
  }
  if (style === 'cycle') {
    const period = speedToPeriod(o.speed, 30000, 2500);
    const hue = ((now % period) / period) * 360;
    return hsvToRgb(hue, 1, 1);
  }
  return null;
}

module.exports = { clamp8, hexToRgb, hsvToRgb, tempToColor, applyBrightness, resolveColor, parseColorName, volumeToColor, eventColorAt, animationColorAt, speedToPeriod };
