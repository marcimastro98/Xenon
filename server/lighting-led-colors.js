'use strict';
// Per-LED looks for the lighting map's "custom" device mode:
// { "<luid>": "#rrggbb" | { style, color, speed } }. A hex is a fixed colour; an
// object is an effect of that LED's own (breathing, rainbow, wave, aurora,
// candle, CPU temperature, album colour). A LED with no entry follows Xenon.
// Pure; validates everything that reaches the stored config, from the API or
// from settings.json, and renders one frame of a device (ledFrame).
const fx = require('./lighting-effects');

// CORSAIR_DEVICE_LEDCOUNT_MAX in the iCUE SDK header: no device has more.
const MAX_LED_COLORS = 512;
// Keep in step with the client mirror in js/settings.js (normalizeLightingLedValue).
const LED_EFFECT_STYLES = ['breathing', 'cycle', 'wave', 'aurora', 'candle', 'temperature', 'album'];
// Styles that loop: a device using one needs the animation ticker.
const LED_DYNAMIC_STYLES = ['breathing', 'cycle', 'wave', 'aurora', 'candle'];
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
  return Object.values(leds).some(v => v && typeof v === 'object' && LED_DYNAMIC_STYLES.includes(v.style));
}

// The colours of one device for this instant, one per entry of `ledIds`.
// ctx: { follow, temperature, album, brightness, nowMs } — `follow` is the
// colour Xenon is showing (brightness already applied), `temperature`/`album`
// the raw reactive colours or null. LEDs sharing the same effect move together,
// and a wave runs across them as one strip, in luid order.
function ledFrame(ledIds, leds, ctx) {
  const map = leds || {};
  const bright = (c) => fx.applyBrightness(c, ctx.brightness);
  const groups = new Map();   // effect key → indexes into ledIds
  const out = ledIds.map((id, i) => {
    const v = map[id];
    if (!v) return ctx.follow;
    if (typeof v === 'string') { const c = fx.parseColorName(v); return c ? bright(c) : ctx.follow; }
    if (v.style === 'temperature') return ctx.temperature ? bright(ctx.temperature) : ctx.follow;
    if (v.style === 'album') return ctx.album ? bright(ctx.album) : ctx.follow;
    const key = `${v.style}|${v.color}|${v.speed}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
    return null;
  });
  for (const [key, idx] of groups) {
    const [style, color, speed] = key.split('|');
    const opts = { style, color, speed: Number(speed), nowMs: ctx.nowMs };
    const spread = fx.isSpatialAnimation(style) ? fx.animationGradientAt(opts, idx.length) : null;
    const one = spread ? null : fx.animationColorAt(opts);
    idx.forEach((at, j) => { out[at] = spread ? bright(spread[j]) : (one ? bright(one) : ctx.follow); });
  }
  return out;
}

module.exports = {
  normalizeLedColors, normalizeLedValue, mergeLedColors, hasDynamicLeds, ledFrame,
  MAX_LED_COLORS, LED_EFFECT_STYLES,
};
