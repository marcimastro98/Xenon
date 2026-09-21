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
const tls = require('tls');
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

// ── Who is actually answering on that address ───────────────────────────────
// A Hue bridge serves a certificate signed by Philips' own private CA, so the
// public trust store cannot verify it and `rejectUnauthorized` has to stay off.
// That is a decision about the SIGNATURE, and it was being read as a decision
// about the PEER: with verification off and nothing else checked, Xenon handed
// its bridge key to whatever answered on the stored address. Not much of an
// attack — it takes something on your LAN — but the ordinary way to get there
// is a DHCP lease moving the bridge's address onto another device, and then the
// key goes to a stranger's box for no better reason than the router reshuffling.
//
// So the certificate is not trusted for being signed; it is checked for being
// the bridge's. A Hue bridge's certificate carries its BRIDGE ID as the common
// name, and the bridge id is exactly what discovery and pairing already read.
//
// `createConnection` is what makes this safe rather than decorative: the socket
// is handshaken and inspected BEFORE it is handed to the request, so a refusal
// happens with the key still in this process. Checking on `secureConnect` of an
// already-issued request would race the header flush that carries it.
function certName(cert) {
  const cn = cert && cert.subject && cert.subject.CN;
  return String(cn || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
function bridgeIdKey(id) {
  return String(id || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
// A bridge always serves CLIP v2 here. Named rather than inlined so the tests
// can run the real function against a local TLS server without asking for a
// privileged port.
const HUE_TLS_PORT = 443;
function isIpLiteral(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(String(host || '')) || String(host || '').includes(':');
}

// The bridge id for a host: whatever pairing stored, else asked for once and
// remembered. An install that paired before this existed has nothing stored, and
// learning the id from the bridge is still worth doing — it is the same
// unauthenticated read discovery has always used, and it turns "anything at this
// address" into "the device that was there when Xenon last looked".
const _bridgeIds = new Map();   // host → { id, at }
const BRIDGE_ID_TTL = 60 * 60 * 1000;
async function bridgeIdOf(host, known) {
  if (known) return bridgeIdKey(known);
  const hit = _bridgeIds.get(host);
  if (hit && Date.now() - hit.at < BRIDGE_ID_TTL) return hit.id;
  const res = await httpJson(`http://${host}/api/config`, { method: 'GET' }, 1500);
  const id = bridgeIdKey(res && res.body && res.body.bridgeid);
  if (id) _bridgeIds.set(host, { id, at: Date.now() });
  return id;
}

// HTTPS JSON call for CLIP v2, over a socket whose peer has been identified.
// `bridgeId` is the id pairing recorded; without one the check falls back to
// whatever the bridge says it is (see bridgeIdOf).
function httpsJson(host, path, method, token, body, timeoutMs, bridgeId) {
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
      createConnection(opts, onSocket) {
        const socket = tls.connect({
          host, port: HUE_TLS_PORT,
          // SNI names a host, and RFC 6066 does not allow an address there —
          // Node already warns and will drop it. A bridge is normally reached by
          // IP, so it is sent only when there is a name to send.
          ...(isIpLiteral(host) ? {} : { servername: host }),
          rejectUnauthorized: false,      // Philips' own CA; the identity check below is the real gate
        });
        socket.once('secureConnect', () => {
          const want = bridgeIdKey(bridgeId);
          const got = certName(socket.getPeerCertificate());
          // No id to compare against (a bridge that answers nothing, an offline
          // first run) is not a pass: a check that waves through whatever it
          // could not identify is the behaviour being removed.
          if (!want || !got || want !== got) {
            socket.destroy();
            onSocket(new Error('hue_bridge_identity'));
            return;
          }
          onSocket(null, socket);
        });
        socket.once('error', (e) => onSocket(e));
        return undefined;               // the request waits for onSocket
      },
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
async function apiOf(h, user, bridgeId) {
  const key = h + '|' + user;
  const hit = _api.get(key);
  if (hit && (hit.v === 'v2' || Date.now() - hit.at < API_RETRY_TTL)) return hit;
  // Resolved once here and carried on the result, so the writers that call
  // apiOf() on every push do not re-ask for it.
  const bid = await bridgeIdOf(h, bridgeId);
  const bridge = await httpsJson(h, '/clip/v2/resource/bridge', 'GET', user, null, 1500, bid);
  if (bridge.ok) {
    // The whole-home group: the grouped_light owned by the bridge_home resource.
    const groups = await httpsJson(h, '/clip/v2/resource/grouped_light', 'GET', user, null, 1500, bid);
    const list = (groups.ok && groups.body && Array.isArray(groups.body.data)) ? groups.body.data : [];
    const home = list.find(g => g && g.owner && g.owner.rtype === 'bridge_home') || list[0];
    if (home && home.id) {
      const v2 = { v: 'v2', groupId: home.id, at: Date.now(), bridgeId: bid };
      _api.set(key, v2);
      return v2;
    }
  }
  const v1 = { v: 'v1', at: Date.now(), bridgeId: bid };
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
    // Carried from here on: it is what the bridge's certificate is checked
    // against, so a device record that has it is pinned to the bridge that was
    // actually paired rather than to an address.
    bridgeId: bridgeIdKey(res.body.bridgeid),
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
    // The link button was just pressed on a bridge standing in front of the
    // user, so this is the one moment its identity is known for certain. Record
    // it with the key it just handed out.
    const bridgeId = await bridgeIdOf(h, '');
    const device = { id: 'hue:' + h, host: h, name: 'Hue Bridge', model: 'Philips Hue', ledCount: 0, token: entry.success.username };
    if (bridgeId) device.bridgeId = bridgeId;
    return { ok: true, device };
  }
  // type 101 = link button not pressed.
  return { ok: false, needsButton: true };
}

async function write(device, color) {
  const h = normHost(device && device.host);
  const user = device && device.token;
  if (!h || !user) return;
  const api = await apiOf(h, user, device && device.bridgeId);
  if (api.v === 'v2') {
    const r = await httpsJson(h, `/clip/v2/resource/grouped_light/${api.groupId}`, 'PUT', user, buildV2State(color), 1500, api.bridgeId);
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
    const res = await httpsJson(h, '/clip/v2/resource/light', 'GET', user, null, 1500, api.bridgeId);
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
  const api = await apiOf(h, user, device && device.bridgeId);
  const ids = await lightIdsOf(h, user, api).catch(() => []);
  if (ids.length < 2 || stops.length < 2) {   // one bulb / one colour → uniform group write
    await write(device, stops[0]);
    return;
  }
  const cols = fx.paletteGradient(stops, ids.length);
  await Promise.all(ids.map((id, i) => {
    if (api.v === 'v2') return httpsJson(h, `/clip/v2/resource/light/${id}`, 'PUT', user, buildV2State(cols[i]), 1500, api.bridgeId);
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
  const api = await apiOf(h, user, device && device.bridgeId);
  if (api.v === 'v2') {
    const r = await httpsJson(h, `/clip/v2/resource/grouped_light/${api.groupId}`, 'PUT', user, { on: { on: false } }, 1500, api.bridgeId);
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
