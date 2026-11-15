'use strict';
// The looks a device can take: the modes and styles allowed, the default colours, and what one
// device or one LED shows.

const fx = require('./lighting-effects.js');
const { DYNAMIC_ANIM_STYLES } = require('./paint-rules.js');

const DEVICE_MODES = ['follow', 'color', 'animation', 'temperature', 'album', 'off', 'custom'];

const ANIM_STYLES = ['none', 'solid', ...DYNAMIC_ANIM_STYLES];
const PER_DEVICE_ANIM_STYLES = ['solid', ...DYNAMIC_ANIM_STYLES.filter(s => s !== 'palette' && s !== 'wave')];

const EVENT_DURATION_MS = 1800;
// One source for the user-configurable flash-duration bounds (mirrored by the
// slider in lighting-page.js and the settings normalizers).
const clampEventDuration = (ms, fallback) =>
  Number.isFinite(Number(ms)) ? Math.max(500, Math.min(10000, Number(ms))) : fallback;

const OFF_COLOR = { r: 0, g: 0, b: 0 };

// Validate a user palette: 2–5 parseable colours, stored as normalized hex.
function sanitizePalette(input) {
  if (!Array.isArray(input)) return null;
  const hexes = input.slice(0, 5)
    .map(h => fx.parseColorName(h))
    .filter(Boolean)
    .map(c => fx.rgbToHex(c));
  return hexes.length >= 2 ? hexes : null;
}

// Switching to the candle while the colour is still the generic green default
// swaps in a warm flame tint. Lives HERE (not the UI) so every entry point —
// settings page, AI set_animation, per-device modes — gets the same warm flame.
const GENERIC_DEFAULT_COLOR = '#1ed760';
const CANDLE_DEFAULT_COLOR = '#ff9329';

// The look a single-look device gives every LED, as a per-LED value: what the
// other LEDs keep when one part gets its own. null = follows Xenon. Mirrors
// wholeDeviceLook() in js/lighting/lighting-device.js.
function wholeDeviceLook(m) {
  const mode = (m && m.mode) || 'follow';
  if (mode === 'color') return m.color || null;
  if (mode === 'off') return '#000000';
  if (mode === 'temperature' || mode === 'album') return { style: mode };
  if (mode === 'animation' && m.anim) {
    return m.anim.style === 'solid' ? m.anim.color : { style: m.anim.style, color: m.anim.color, speed: m.anim.speed };
  }
  return null;
}

// A device's own per-LED look, which a key's part colours go on top of: its
// map, or the one look a single-look device gives every LED.
function deviceLeds(dev, m) {
  if (m && m.mode === 'custom') return m.leds || {};
  const keep = wholeDeviceLook(m);
  const leds = {};
  if (keep) dev.ledIds.forEach((luid) => { leds[luid] = keep; });
  return leds;
}

module.exports = {
  DEVICE_MODES, ANIM_STYLES, PER_DEVICE_ANIM_STYLES, EVENT_DURATION_MS, clampEventDuration,
  OFF_COLOR, sanitizePalette, GENERIC_DEFAULT_COLOR, CANDLE_DEFAULT_COLOR, wholeDeviceLook,
  deviceLeds,
};
