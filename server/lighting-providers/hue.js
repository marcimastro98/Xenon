'use strict';
// Philips Hue provider — drives a local Hue Bridge over its HTTP API (no cloud).
// Pairing: the user presses the round link button on the bridge, then we POST to
// create an API username (token). Colour is pushed to group 0 ("all lights") in a
// single request, so one HTTP call updates the whole room — cheap and light.
// No dependencies. API: https://developers.meethue.com/

const meta = {
  id: 'hue',
  name: 'Philips Hue',
  type: 'lan',
  maxHz: 10,            // Hue tolerates ~10 commands/sec; the manager rate-limits to match
  needsPairing: true,
  download: 'https://www.philips-hue.com/',
};

async function httpJson(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || 1500);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const ct = res.headers.get('content-type') || '';
    const body = ct.includes('json') ? await res.json().catch(() => null) : null;
    return { ok: res.ok, status: res.status, body };
  } catch {
    return { ok: false, status: 0, body: null };
  } finally {
    clearTimeout(t);
  }
}

function normHost(host) {
  return String(host || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
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

// Probe: an unauthenticated /api/config carries a `bridgeid` only on a real bridge.
async function probe(host) {
  const h = normHost(host);
  if (!h) return null;
  const res = await httpJson(`http://${h}/api/config`, { method: 'GET' }, 1500);
  if (!res.ok || !res.body || !res.body.bridgeid) return null;
  return {
    id: 'hue:' + h,
    host: h,
    name: res.body.name || 'Hue Bridge',
    model: 'Philips Hue',
    ledCount: 0,
  };
}

// Pairing: requires the physical link button to have been pressed within ~30s.
async function pair(host) {
  const h = normHost(host);
  if (!h) return { ok: false };
  const res = await httpJson(`http://${h}/api`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ devicetype: 'xenonedge#dashboard' }),
  }, 2500);
  const entry = Array.isArray(res.body) ? res.body[0] : null;
  if (entry && entry.success && entry.success.username) {
    return { ok: true, device: { id: 'hue:' + h, host: h, name: 'Hue Bridge', model: 'Philips Hue', ledCount: 0, token: entry.success.username } };
  }
  // type 101 = link button not pressed.
  return { ok: false, needsButton: true };
}

async function write(device, color) {
  const h = normHost(device && device.host);
  const user = device && device.token;
  if (!h || !user) return;
  const st = rgbToHueState(color);
  await httpJson(`http://${h}/api/${user}/groups/0/action`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ on: st.on, bri: st.bri, hue: st.hue, sat: st.sat }),
  }, 1500);
}

// Per-bulb album gradient: list the bridge's colour-capable lights (cached) and
// spread the palette stops across them — bulb 1 takes the cover's dominant
// colour, the rest walk the gradient. Album pushes happen once per track, so the
// one-PUT-per-light cost is negligible against the bridge's ~10 cmd/s budget.
const _lights = new Map();   // host|token → { ids, at }
const LIGHTS_TTL = 10 * 60 * 1000;
async function lightIdsOf(h, user) {
  const key = h + '|' + user;
  const hit = _lights.get(key);
  if (hit && Date.now() - hit.at < LIGHTS_TTL) return hit.ids;
  const res = await httpJson(`http://${h}/api/${user}/lights`, { method: 'GET' }, 1500);
  const ids = [];
  if (res.ok && res.body && typeof res.body === 'object' && !Array.isArray(res.body)) {
    for (const [id, l] of Object.entries(res.body)) {
      if (l && l.state && ('hue' in l.state)) ids.push(id);   // colour-capable only
    }
  }
  if (ids.length) _lights.set(key, { ids, at: Date.now() });
  return ids;
}
async function writeGradient(device, palette) {
  const h = normHost(device && device.host);
  const user = device && device.token;
  const stops = Array.isArray(palette) ? palette.filter(c => c && typeof c === 'object') : [];
  if (!h || !user || !stops.length) return;
  const ids = await lightIdsOf(h, user).catch(() => []);
  if (ids.length < 2 || stops.length < 2) {   // one bulb / one colour → uniform group write
    await write(device, stops[0]);
    return;
  }
  const fx = require('../lighting-effects');
  const cols = fx.paletteGradient(stops, ids.length);
  await Promise.all(ids.map((id, i) => {
    const st = rgbToHueState(cols[i]);
    return httpJson(`http://${h}/api/${user}/lights/${id}/state`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on: st.on, bri: st.bri, hue: st.hue, sat: st.sat }),
    }, 1500);
  }));
}

async function release(device) {
  const h = normHost(device && device.host);
  const user = device && device.token;
  if (!h || !user) return;
  await httpJson(`http://${h}/api/${user}/groups/0/action`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ on: false }),
  }, 1500);
}

module.exports = { meta, probe, pair, write, writeGradient, release };
