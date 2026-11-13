// Checks the per-device parts of the lighting settings: each device's own mode and colours, and
// the layouts of directly driven controllers.

const { clampNumber, normalizeHex } = require('../settings/values.js');
const { LIGHTING_DEVICE_MODES, LIGHTING_ANIM_SUB } = require('./settings-normalize.js');
const { normalizeLedColors } = require('../lighting-led-colors.js');
const {
  normalizeLayouts: normalizeLightingLayouts, normalizeScanned: normalizeLightingScanned,
} = require('../lighting-layouts.js');

function normalizeLightingDeviceModes(value) {
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const [id, v] of Object.entries(value)) {
    if (!v || typeof v !== 'object') continue;
    const key = String(id).slice(0, 160);
    const e = { mode: LIGHTING_DEVICE_MODES.includes(v.mode) ? v.mode : 'follow' };
    if (typeof v.color === 'string' && /^#?[0-9a-f]{6}$/i.test(v.color)) e.color = normalizeHex(v.color, '#1ed760');
    if (v.anim && typeof v.anim === 'object') {
      e.anim = {
        style: LIGHTING_ANIM_SUB.includes(v.anim.style) ? v.anim.style : 'cycle',
        color: normalizeHex(v.anim.color, '#1ed760'),
        speed: clampNumber(v.anim.speed, 1, 100, 50),
      };
    }
    if (v.leds !== undefined) e.leds = normalizeLedColors(v.leds);
    out[key] = e;
  }
  return out;
}

function normalizeLightingNative(value) {
  const v = value && typeof value === 'object' ? value : {};
  return { enabled: v.enabled === true, layouts: normalizeLightingLayouts(v.layouts), scanned: normalizeLightingScanned(v.scanned) };
}

module.exports = { normalizeLightingDeviceModes, normalizeLightingNative };
