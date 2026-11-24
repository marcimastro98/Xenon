'use strict';
// Per-LED looks for the lighting map's "custom" device mode:
// { "<luid>": "#rrggbb" | { style, color, speed } }. A hex is a fixed colour; an
// object is an effect (any of the Lighting list, lights/look-fields.js), the CPU
// temperature or the album colour. A LED with no entry follows Xenon.
// Pure; validates everything that reaches the stored config, from the API or
// from settings.json, and renders one frame of a device (ledFrame).
const fx = require('./lighting-effects');
const fxLook = require('./fx-look.js');
const { STYLES } = require('./look-fields.js');

// CORSAIR_DEVICE_LEDCOUNT_MAX in the iCUE SDK header: no device has more.
const MAX_LED_COLORS = 512;
// Keep in step with the client mirror in server/js/settings/normalize-lighting.js (normalizeLightingLedValue).
// 'solid' is a hex of its own, and the old 'palette' needs a list of colours a LED does not keep.
const LED_EFFECT_STYLES = Object.freeze([...STYLES.filter((s) => !['none', 'solid', 'palette'].includes(s)), 'temperature', 'album']);
const DEFAULT_EFFECT_COLOR = '#1ed760';
const CANDLE_COLOR = '#ff9329';
const HEX = /^#[0-9a-f]{6}$/i;
const LUID = /^\d{1,10}$/;

function validKey(k) { return LUID.test(k) && Number(k) <= 0xffffffff; }

// One LED's value, or null when it is not valid.
function normalizeLedValue(v) {
  if (typeof v === 'string') return HEX.test(v) ? v.toLowerCase() : null;
  if (!v || typeof v !== 'object' || Array.isArray(v) || !LED_EFFECT_STYLES.includes(v.style)) return null;
  const speed = Number(v.speed);
  return {
    style: v.style,
    color: typeof v.color === 'string' && HEX.test(v.color) ? v.color.toLowerCase()
      : (v.style === 'candle' ? CANDLE_COLOR : DEFAULT_EFFECT_COLOR),
    speed: Number.isFinite(speed) ? Math.max(1, Math.min(100, Math.round(speed))) : 50,
  };
}

function normalizeLedColors(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  let n = 0;
  for (const [k, v] of Object.entries(value)) {
    if (n >= MAX_LED_COLORS) break;
    const clean = validKey(k) ? normalizeLedValue(v) : null;
    if (!clean) continue;
    out[String(Number(k))] = clean;
    n++;
  }
  return out;
}

// patch: { "<luid>": value | null } — a value sets the LED, null gives it back to
// Xenon. New LEDs past the cap are ignored; existing ones can always be changed
// or cleared.
function mergeLedColors(prev, patch) {
  const next = normalizeLedColors(prev);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return next;
  for (const [k, v] of Object.entries(patch)) {
    if (!validKey(k)) continue;
    const key = String(Number(k));
    if (v === null) { delete next[key]; continue; }
    const clean = normalizeLedValue(v);
    if (!clean) continue;
    if (!(key in next) && Object.keys(next).length >= MAX_LED_COLORS) continue;
    next[key] = clean;
  }
  return next;
}

function hasDynamicLeds(leds) {
  if (!leds || typeof leds !== 'object') return false;
  return Object.values(leds).some(v => v && typeof v === 'object' && v.style !== 'temperature' && v.style !== 'album' && fxLook.moves(v));
}

// The colours of one device for this instant, one per entry of `ledIds`.
// ctx: { follow, under, temperature, album, pump, brightness, nowMs } — `follow` is the
// colour Xenon is showing (brightness already applied; null leaves the LED to its
// own software), `under` what the device would show without its map, one colour per
// LED (the album gradient or an effect), taken instead of `follow` where it has one, `temperature`/`album` the raw reactive colours or null, `pump`
// (count) => the pump screen's ring LED by LED now (lights/pump-ring.js frame), or null, asked once
// per ring (a pump and the screen on its cap are two), `dev` the device. LEDs sharing
// the same effect move together: a fan or a ring they fill whole in its own shape, the
// rest as one strip in luid order (fx-look.js drawSome); the ring's colours run round it.
function ledFrame(ledIds, leds, ctx) {
  const map = leds || {};
  const bright = (c) => fx.applyBrightness(c, ctx.brightness);
  const groups = new Map();   // effect key → indexes into ledIds
  const rings = new Map();    // pump ring → indexes of its LEDs
  const base = (i) => ctx.under?.[i] || ctx.follow;
  const out = ledIds.map((id, i) => {
    const v = map[id];
    if (!v) return base(i);
    if (v.style === 'pump') { const k = v.ring || 0; if (!rings.has(k)) rings.set(k, []); rings.get(k).push(i); return base(i); }
    if (typeof v === 'string') { const c = fx.parseColorName(v); return c ? bright(c) : base(i); }
    if (v.style === 'temperature') return ctx.temperature ? bright(ctx.temperature) : base(i);
    if (v.style === 'album') return ctx.album ? bright(ctx.album) : base(i);
    const key = `${v.style}|${v.color}|${v.speed}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
    return null;
  });
  for (const ring of rings.values()) {
    const stops = typeof ctx.pump === 'function' ? ctx.pump(ring.length) : null;
    if (stops) ring.forEach((at, j) => { out[at] = bright(stops[j]); });
  }
  for (const [key, idx] of groups) {
    const [style, color, speed] = key.split('|');
    const drawn = fxLook.drawSome({ style, color, speed: Number(speed) }, ctx.dev, idx, ctx.nowMs);
    idx.forEach((at, j) => { out[at] = drawn?.[j] ? bright(drawn[j]) : base(at); });
  }
  return out;
}

module.exports = {
  normalizeLedColors, normalizeLedValue, mergeLedColors, hasDynamicLeds, ledFrame,
  MAX_LED_COLORS, LED_EFFECT_STYLES,
};
