// Cleans the saved lighting settings and the profiles that switch with the app in front.
'use strict';

// Smart context profiles (context-profiles.js owns the behavior). Rebuild from
// known keys only: page/deck are free strings (loosely bounded — the live lists
// validate at apply time), lighting is a fixed enum. Off by default.
function normalizeContextProfiles(value) {
  const v = value && typeof value === 'object' ? value : {};
  const srcMap = v.map && typeof v.map === 'object' ? v.map : {};
  const map = {};
  for (const act of PERF_ACTIVITIES) {
    const e = srcMap[act] && typeof srcMap[act] === 'object' ? srcMap[act] : {};
    // style is 'glass'/'retro' OR a saved custom theme id (ct_…). Loosely bounded
    // like page/deck — the gallery validates it at apply time (an id that no
    // longer exists simply no-ops), so a removed theme never wedges a profile.
    const styleId = typeof e.style === 'string' ? e.style.slice(0, 40) : '';
    map[act] = {
      page: typeof e.page === 'string' ? e.page.slice(0, 64) : '',
      lighting: CONTEXT_LIGHTING_STYLES.includes(e.lighting) ? e.lighting : '',
      deck: typeof e.deck === 'string' ? e.deck.slice(0, 80) : '',
      style: /^[a-z0-9_-]+$/i.test(styleId) ? styleId : '',
    };
  }
  return { enabled: v.enabled === true, revertOnExit: v.revertOnExit !== false, map };
}

function normalizeLightingEvent(value, fallback) {
  const f = fallback || { enabled: true, color: '#ff0000', style: 'blink', durationMs: 1800 };
  const fDur = clampNumber(f.durationMs, 500, 10000, 1800);
  if (typeof value === 'boolean') return { enabled: value, color: f.color, style: f.style, durationMs: fDur };
  const v = value && typeof value === 'object' ? value : {};
  return {
    enabled: typeof v.enabled === 'boolean' ? v.enabled : f.enabled,
    color: normalizeHex(v.color, f.color),
    style: LIGHTING_STYLES.includes(v.style) ? v.style : f.style,
    durationMs: clampNumber(v.durationMs, 500, 10000, fDur),
  };
}
function normalizeLighting(value) {
  const v = value && typeof value === 'object' ? value : {};
  const d = DEFAULT_HUB_SETTINGS.lighting;
  const fx = v.effects && typeof v.effects === 'object' ? v.effects : {};
  return {
    enabled: v.enabled === true,
    brightness: clampNumber(v.brightness, 0, 1, d.brightness),
    pauseDuringGame: v.pauseDuringGame !== false,
    devices: (v.devices && typeof v.devices === 'object') ? v.devices : {},
    effects: {
      temperature: fx.temperature === true,
      volume: fx.volume === true,
      musicAlbum: fx.musicAlbum === true,
      timer: normalizeLightingEvent(fx.timer, d.effects.timer),
      notification: normalizeLightingEvent(fx.notification, d.effects.notification),
      reminder: normalizeLightingEvent(fx.reminder, d.effects.reminder),
    },
    animation: normalizeLightingAnimation(v.animation, d.animation),
    manualColor: /^#[0-9a-f]{6}$/i.test(String(v.manualColor)) ? v.manualColor : '',
    providers: normalizeLightingProviders(v.providers),
    deviceModes: normalizeLightingDeviceModes(v.deviceModes),
    native: normalizeLightingNative(v.native),
  };
}

// Server-owned (POST /settings keeps the persisted copy and the server normalizes
// the layouts): the mirror only keeps the shape, so a page reading it never trips.
function normalizeLightingNative(value) {
  const v = value && typeof value === 'object' ? value : {};
  const layouts = v.layouts && typeof v.layouts === 'object' && !Array.isArray(v.layouts) ? v.layouts : {};
  return { enabled: v.enabled === true, layouts };
}

function normalizeLightingDeviceModes(value) {
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const id of Object.keys(value)) {
    const v = value[id];
    if (!v || typeof v !== 'object') continue;
    const e = { mode: LIGHTING_DEVICE_MODES.includes(v.mode) ? v.mode : 'follow' };
    if (typeof v.color === 'string' && /^#[0-9a-f]{6}$/i.test(v.color)) e.color = v.color;
    if (v.anim && typeof v.anim === 'object') {
      e.anim = {
        style: ['solid', 'breathing', 'cycle', 'aurora', 'candle'].includes(v.anim.style) ? v.anim.style : 'cycle',
        color: /^#[0-9a-f]{6}$/i.test(String(v.anim.color)) ? v.anim.color : '#1ed760',
        speed: clampNumber(v.anim.speed, 1, 100, 50),
      };
    }
    if (v.leds !== undefined) e.leds = normalizeLightingLedColors(v.leds);
    out[String(id)] = e;
  }
  return out;
}

// Per-LED looks of the 'custom' (lighting map) mode. Mirrors
// server/lighting-led-colors.js: luid keys, a hex or { style, color, speed }
// values, max 512. Arrays inlined for the same TDZ reason as below.
function normalizeLightingLedValue(v) {
  if (typeof v === 'string') return /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : null;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  if (!['breathing', 'cycle', 'wave', 'aurora', 'candle', 'temperature', 'album'].includes(v.style)) return null;
  const color = /^#[0-9a-f]{6}$/i.test(String(v.color)) ? String(v.color).toLowerCase()
    : (v.style === 'candle' ? '#ff9329' : '#1ed760');
  return { style: v.style, color, speed: Math.round(clampNumber(v.speed, 1, 100, 50)) };
}

function normalizeLightingLedColors(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  let n = 0;
  for (const [k, v] of Object.entries(value)) {
    if (n >= 512) break;
    if (!/^\d{1,10}$/.test(k) || Number(k) > 0xffffffff) continue;
    const clean = normalizeLightingLedValue(v);
    if (!clean) continue;
    out[String(Number(k))] = clean;
    n++;
  }
  return out;
}

// Note: arrays inlined (not module-level consts) because normalizeLighting runs
// during the top-level hubSettings init, before a later const would initialise (TDZ).
function normalizeLightingAnimation(value, fallback) {
  const f = fallback || { style: 'none', color: '#1ed760', speed: 50, palette: ['#1ed760', '#0066ff'] };
  const v = value && typeof value === 'object' ? value : {};
  const hex = /^#[0-9a-f]{6}$/i.test(String(v.color)) ? v.color : f.color;
  const fPal = Array.isArray(f.palette) && f.palette.length >= 2 ? f.palette : ['#1ed760', '#0066ff'];
  const palette = (Array.isArray(v.palette) ? v.palette : []).slice(0, 5)
    .filter(h => /^#[0-9a-f]{6}$/i.test(String(h)));
  return {
    style: ['none', 'solid', 'breathing', 'cycle', 'wave', 'aurora', 'candle', 'palette'].includes(v.style) ? v.style : f.style,
    color: hex,
    speed: clampNumber(v.speed, 1, 100, f.speed),
    palette: palette.length >= 2 ? palette : fPal.slice(),
  };
}
// Mirror the server provider shape so a full-settings save round-trips the
// discovered devices instead of wiping them. Keep this id list aligned with the
// server's LIGHTING_PROVIDER_IDS (server.js).
function normalizeLightingProviders(value) {
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const id of ['govee', 'lifx', 'wled', 'hue', 'nanoleaf', 'openrgb', 'homeassistant', 'yeelight']) {
    const p = value[id];
    if (!p || typeof p !== 'object' || !Array.isArray(p.devices)) continue;
    const devices = p.devices.map(dev => {
      const host = String(dev && dev.host || '').trim();
      if (!host) return null;
      const out = {
        id: String(dev.id || `${id}:${host}`),
        name: String(dev && dev.name || id),
        host,
        optedIn: !(dev && dev.optedIn === false),
      };
      if (dev && dev.token) out.token = String(dev.token);
      if (dev && dev.bridgeId) out.bridgeId = String(dev.bridgeId).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 32);
      return out;
    }).filter(Boolean);
    if (devices.length) out[id] = { devices };
  }
  return out;
}
