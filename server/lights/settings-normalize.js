// Checks the saved lighting settings piece by piece: styles, palette, animation, providers and
// the reaction to an event.

const { clampNumber, normalizeHex } = require('../settings/values.js');

// RGB lighting bridge config. Mirrors the client default (master OFF). Accepts
// the legacy effect-booleans and the new {enabled,color,style} event objects.
const LIGHTING_STYLES = ['blink', 'pulse', 'solid'];
const LIGHTING_ANIM_STYLES = ['none', 'solid', 'breathing', 'cycle', 'wave', 'aurora', 'candle', 'palette'];
// User palette for the 'palette' ambient style: 2–5 hex colours.
function normalizeLightingPalette(value, fallback) {
  const hexes = (Array.isArray(value) ? value : []).slice(0, 5)
    .map(h => (/^#?[0-9a-f]{6}$/i.test(String(h)) ? normalizeHex(h, null) : null))
    .filter(Boolean);
  return hexes.length >= 2 ? hexes : fallback.slice();
}
const LIGHTING_PROVIDER_IDS = ['govee', 'lifx', 'wled', 'hue', 'nanoleaf', 'openrgb', 'homeassistant', 'yeelight'];
function normalizeLightingAnimation(value, fallback) {
  const f = fallback || { style: 'none', color: '#1ed760', speed: 50, palette: ['#1ed760', '#0066ff'] };
  const v = value && typeof value === 'object' ? value : {};
  return {
    style: LIGHTING_ANIM_STYLES.includes(v.style) ? v.style : f.style,
    color: normalizeHex(v.color, f.color),
    speed: clampNumber(v.speed, 1, 100, f.speed),
    palette: normalizeLightingPalette(v.palette, f.palette || ['#1ed760', '#0066ff']),
  };
}
function normalizeLightingProviders(value) {
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const id of LIGHTING_PROVIDER_IDS) {
    const p = value[id];
    if (!p || typeof p !== 'object' || !Array.isArray(p.devices)) continue;
    const devices = p.devices.map(d => {
      const host = String(d && d.host || '').trim().slice(0, 120);
      if (!host) return null;
      const dev = {
        id: String(d.id || `${id}:${host}`).slice(0, 160),
        name: String(d && d.name || id).slice(0, 80),
        host,
        optedIn: !(d && d.optedIn === false),
      };
      if (d && d.token) dev.token = String(d.token).slice(0, 256); // pairing token (Hue/Nanoleaf)
      // The paired bridge's own id. Dropped here, it would be re-learned from
      // whatever answers the address instead of from what was paired.
      if (d && d.bridgeId) dev.bridgeId = String(d.bridgeId).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 32);
      return dev;
    }).filter(Boolean).slice(0, 32);
    if (devices.length) out[id] = { devices };
  }
  return out;
}
const LIGHTING_DEVICE_MODES = ['follow', 'color', 'animation', 'temperature', 'album', 'off', 'custom'];
// Per-device styles: no 'palette' (its colour list lives on the global animation)
// and no 'wave' (per-device renders uniform = identical to 'cycle').
const LIGHTING_ANIM_SUB = ['solid', 'breathing', 'cycle', 'aurora', 'candle'];

function normalizeLightingEvent(value, fallback) {
  const f = fallback || { enabled: true, color: '#ff0000', style: 'blink', durationMs: 1800 };
  const fDur = clampNumber(f.durationMs, 500, 10000, 1800);
  if (typeof value === 'boolean') return { enabled: value, color: f.color, style: f.style, durationMs: fDur }; // legacy
  const v = value && typeof value === 'object' ? value : {};
  return {
    enabled: typeof v.enabled === 'boolean' ? v.enabled : f.enabled,
    color: normalizeHex(v.color, f.color),
    style: LIGHTING_STYLES.includes(v.style) ? v.style : f.style,
    durationMs: clampNumber(v.durationMs, 500, 10000, fDur),
  };
}

module.exports = {
  LIGHTING_STYLES, LIGHTING_ANIM_STYLES, normalizeLightingPalette, LIGHTING_PROVIDER_IDS,
  normalizeLightingAnimation, normalizeLightingProviders, LIGHTING_DEVICE_MODES, LIGHTING_ANIM_SUB,
  normalizeLightingEvent,
};
