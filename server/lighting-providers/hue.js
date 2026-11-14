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

const fx = require('../lighting-effects');

const meta = {
  id: 'hue',
  name: 'Philips Hue',
  type: 'lan',
  maxHz: 10,            // Hue tolerates ~10 commands/sec; the manager rate-limits to match
  needsPairing: true,
  download: 'https://www.philips-hue.com/',
};

const { httpJson, normHost, bridgeIdKey, bridgeIdOf, httpsJson } = require('./hue-bridge.js');

const { rgbToXy, buildV2State, rgbToHueState } = require('./hue-colour.js');

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
