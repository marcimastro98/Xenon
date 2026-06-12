'use strict';
// WLED provider — drives WLED devices over their local HTTP JSON API.
// No dependencies and no pairing: a WLED device is just an IP on the LAN.
// API reference: https://kno.wled.ge/interfaces/json-api/

const fx = require('../lighting-effects');

const meta = {
  id: 'wled',
  name: 'WLED',
  type: 'lan',          // discoverable by LAN sweep
  maxHz: 20,            // cap update rate so animations never flood the device
  needsPairing: false,
  download: 'https://kno.wled.ge/basics/getting-started/',
};

// Minimal fetch wrapper with a hard timeout. Returns parsed JSON / text, or null
// on any failure — callers treat null as "device not reachable", never throwing.
async function httpJson(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || 1500);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    return ct.includes('json') ? await res.json() : await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function normHost(host) {
  return String(host || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

// Probe a host: resolve a WLED device descriptor or null if it isn't WLED.
async function probe(host) {
  const h = normHost(host);
  if (!h) return null;
  const info = await httpJson(`http://${h}/json/info`, { method: 'GET' }, 1500);
  // WLED's /json/info always carries a brand string + an `leds` object.
  if (!info || typeof info !== 'object' || !info.leds) return null;
  const leds = typeof info.leds === 'object' ? info.leds : {};
  return {
    id: 'wled:' + h,
    host: h,
    name: info.name || 'WLED',
    model: ('WLED ' + (info.ver || '')).trim(),
    ledCount: Number(leds.count) || 0,
  };
}

// Push a single uniform colour. Brightness is already baked into the colour by
// the resolver, so we hold WLED's master `bri` at full and set segment 0 colour.
// `frz:false` unfreezes the segment in case a per-LED gradient froze it before.
async function write(device, color) {
  const h = normHost(device && device.host);
  if (!h) return;
  await httpJson(`http://${h}/json/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ on: true, bri: 255, seg: [{ col: [[color.r, color.g, color.b]], frz: false }] }),
  }, 1500);
}

// Per-LED album gradient. The strip length comes from /json/info, fetched lazily
// and cached in-memory (the stored device config doesn't persist ledCount); a
// failed probe isn't cached, so a momentarily-offline strip recovers on the next
// track. The palette is spread as up to 24 even bands through the shared
// interpolator — compact JSON, visually smooth, and only sent on track change.
const _ledCount = new Map();   // host → positive LED count
async function ledCountOf(h) {
  const hit = _ledCount.get(h);
  if (hit) return hit;
  const info = await httpJson(`http://${h}/json/info`, { method: 'GET' }, 1500);
  const n = (info && typeof info === 'object' && info.leds && Number(info.leds.count)) || 0;
  if (n > 0) _ledCount.set(h, n);
  return n;
}
async function writeGradient(device, palette) {
  const h = normHost(device && device.host);
  if (!h) return;
  const stops = Array.isArray(palette) ? palette.filter(c => c && typeof c === 'object') : [];
  const count = await ledCountOf(h);
  if (count < 2 || stops.length < 2) {   // unknown length / single colour → uniform
    if (stops.length) await write(device, stops[0]);
    return;
  }
  const bands = Math.min(count, 24);
  const cols = fx.paletteGradient(stops, bands);
  const i = [];
  for (let b = 0; b < bands; b++) {
    const start = Math.round(b * count / bands);
    const end = Math.round((b + 1) * count / bands);
    const c = cols[b];
    i.push(start, end, [c.r, c.g, c.b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase());
  }
  // Individual-LED ranges freeze the segment on the device; the next uniform
  // write() above carries frz:false, so leaving album mode can't stick.
  await httpJson(`http://${h}/json/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ on: true, bri: 255, seg: [{ id: 0, i }] }),
  }, 1500);
}

// Hand control back: turn the device off (WLED has no "release to other app"
// concept; off is the predictable neutral state when the dashboard stops driving).
async function release(device) {
  const h = normHost(device && device.host);
  if (!h) return;
  await httpJson(`http://${h}/json/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ on: false }),
  }, 1500);
}

module.exports = { meta, probe, write, writeGradient, release };
