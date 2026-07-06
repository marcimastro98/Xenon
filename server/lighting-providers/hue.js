'use strict';
// Philips Hue provider — drives a local Hue Bridge over its HTTP API (no cloud).
// Pairing: the user presses the round link button on the bridge, then we POST to
// create an API username (token). Colour is pushed to the whole-home group in a
// single request, so one HTTP call updates the whole room — cheap and light.
//
// API: prefers CLIP v2 (https://<bridge>/clip/v2, `hue-application-key` header —
// the v1 username doubles as the key) and falls back automatically to the legacy
// v1 REST API (`/api/<username>`) on bridges that don't answer v2. Philips has
// deprecated v1, so new bridges keep working here without any re-pairing.
// No dependencies. API: https://developers.meethue.com/

const https = require('https');
const fx = require('../lighting-effects');

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

// HTTPS JSON call for CLIP v2. The bridge serves a self-signed certificate, so
// TLS verification is skipped — HERE ONLY, for the stored bridge host, never as
// a general fetch override (Node's fetch cannot skip verification, hence the raw
// https.request).
function httpsJson(host, path, method, token, body, timeoutMs) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      host, path, method,
      headers: {
        ...(token ? { 'hue-application-key': token } : {}),
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
      rejectUnauthorized: false,
      timeout: timeoutMs || 1500,
    }, (res) => {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(buf); } catch { /* non-JSON body */ }
        resolve({ ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300, status: res.statusCode || 0, body: parsed });
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ ok: false, status: 0, body: null }));
    if (data) req.write(data);
    req.end();
  });
}

// RGB (0..255, brightness baked in) → CIE xy + brightness% for CLIP v2. Pure.
function rgbToXy(c) {
  const lin = (v) => { const n = v / 255; return n > 0.04045 ? Math.pow((n + 0.055) / 1.055, 2.4) : n / 12.92; };
  const r = lin(c.r), g = lin(c.g), b = lin(c.b);
  const X = r * 0.4124 + g * 0.3576 + b * 0.1805;
  const Y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const Z = r * 0.0193 + g * 0.1192 + b * 0.9505;
  const sum = X + Y + Z;
  if (!sum) return { x: 0.3127, y: 0.329 };   // black → neutral white point
  return { x: Number((X / sum).toFixed(4)), y: Number((Y / sum).toFixed(4)) };
}

// CLIP v2 state body for a colour write. Pure — unit-tested.
function buildV2State(color) {
  const s = fx.splitVivid(color);
  if (!s) return { on: { on: false } };
  return {
    on: { on: true },
    dimming: { brightness: s.pct },
    color: { xy: rgbToXy(color) },   // chromaticity — scale-independent, so the baked colour is fine
  };
}

// Per-bridge API detection, cached: 'v2' with the whole-home grouped_light id, or
// 'v1'. A v1 verdict expires (the bridge may have been rebooting), a v2 verdict
// sticks until a v2 write fails (then the next write re-detects → v1 fallback).
const _api = new Map();   // host|token → { v: 'v1'|'v2', groupId?, at }
const API_RETRY_TTL = 10 * 60 * 1000;
async function apiOf(h, user) {
  const key = h + '|' + user;
  const hit = _api.get(key);
  if (hit && (hit.v === 'v2' || Date.now() - hit.at < API_RETRY_TTL)) return hit;
  const bridge = await httpsJson(h, '/clip/v2/resource/bridge', 'GET', user, null, 1500);
  if (bridge.ok) {
    // The whole-home group: the grouped_light owned by the bridge_home resource.
    const groups = await httpsJson(h, '/clip/v2/resource/grouped_light', 'GET', user, null, 1500);
    const list = (groups.ok && groups.body && Array.isArray(groups.body.data)) ? groups.body.data : [];
    const home = list.find(g => g && g.owner && g.owner.rtype === 'bridge_home') || list[0];
    if (home && home.id) {
      const v2 = { v: 'v2', groupId: home.id, at: Date.now() };
      _api.set(key, v2);
      return v2;
    }
  }
  const v1 = { v: 'v1', at: Date.now() };
  _api.set(key, v1);
  return v1;
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
  const api = await apiOf(h, user);
  if (api.v === 'v2') {
    const r = await httpsJson(h, `/clip/v2/resource/grouped_light/${api.groupId}`, 'PUT', user, buildV2State(color));
    if (r.ok) return;
    _api.delete(h + '|' + user);   // v2 stopped answering → re-detect; fall through to v1 now
  }
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
// The cached ids are v2 resource ids on a v2 bridge, v1 numeric ids otherwise.
const _lights = new Map();   // host|token → { ids, at }
const LIGHTS_TTL = 10 * 60 * 1000;
async function lightIdsOf(h, user, api) {
  const key = h + '|' + user;
  const hit = _lights.get(key);
  if (hit && Date.now() - hit.at < LIGHTS_TTL && hit.v === api.v) return hit.ids;
  const ids = [];
  if (api.v === 'v2') {
    const res = await httpsJson(h, '/clip/v2/resource/light', 'GET', user, null, 1500);
    const list = (res.ok && res.body && Array.isArray(res.body.data)) ? res.body.data : [];
    for (const l of list) { if (l && l.id && l.color) ids.push(l.id); }   // colour-capable only
  } else {
    const res = await httpJson(`http://${h}/api/${user}/lights`, { method: 'GET' }, 1500);
    if (res.ok && res.body && typeof res.body === 'object' && !Array.isArray(res.body)) {
      for (const [id, l] of Object.entries(res.body)) {
        if (l && l.state && ('hue' in l.state)) ids.push(id);
      }
    }
  }
  if (ids.length) _lights.set(key, { ids, at: Date.now(), v: api.v });
  return ids;
}
async function writeGradient(device, palette) {
  const h = normHost(device && device.host);
  const user = device && device.token;
  const stops = Array.isArray(palette) ? palette.filter(c => c && typeof c === 'object') : [];
  if (!h || !user || !stops.length) return;
  const api = await apiOf(h, user);
  const ids = await lightIdsOf(h, user, api).catch(() => []);
  if (ids.length < 2 || stops.length < 2) {   // one bulb / one colour → uniform group write
    await write(device, stops[0]);
    return;
  }
  const cols = fx.paletteGradient(stops, ids.length);
  await Promise.all(ids.map((id, i) => {
    if (api.v === 'v2') return httpsJson(h, `/clip/v2/resource/light/${id}`, 'PUT', user, buildV2State(cols[i]));
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
  const api = await apiOf(h, user);
  if (api.v === 'v2') {
    const r = await httpsJson(h, `/clip/v2/resource/grouped_light/${api.groupId}`, 'PUT', user, { on: { on: false } });
    if (r.ok) return;
  }
  await httpJson(`http://${h}/api/${user}/groups/0/action`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ on: false }),
  }, 1500);
}

module.exports = {
  meta, probe, pair, write, writeGradient, release,
  // Pure helpers exported for the unit tests only.
  _rgbToXy: rgbToXy,
  _buildV2State: buildV2State,
  _rgbToHueState: rgbToHueState,
};
