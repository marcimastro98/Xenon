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

// Priority: override > overlay > album > base; null layers fall through; black if
// all null. `album` is the now-playing cover colour — a steady ambient tint that
// sits above the reactive temperature base but yields to transient flashes
// (volume overlay, event) and to an explicit manual override.
function resolveColor(layers, brightness) {
  const picked = layers.override || layers.overlay || layers.album || layers.base || { r: 0, g: 0, b: 0 };
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

module.exports = { clamp8, hexToRgb, tempToColor, applyBrightness, resolveColor, parseColorName, volumeToColor, eventColorAt };
