'use strict';
// External (non-iCUE) lighting providers: catalogue + colour fan-out + config +
// on-demand discovery. Provider modules are lazy-loaded — a module is required
// only when it has a configured device, so an unused provider costs nothing.
// Every colour push is fire-and-forget and per-device rate-limited, so a slow or
// unreachable LAN device can never block the Node event loop or starve the others.

const discovery = require('./lighting-discovery');

// Static catalogue of external (non-iCUE) providers. DELIBERATELY EMPTY: external
// RGB systems (WLED/OpenRGB/Hue/Nanoleaf) were removed from the product — the hub
// controls iCUE only. The fan-out/discovery machinery below stays but is inert
// (no providers = no devices, scans return nothing, writes are no-ops), so the
// rest of the lighting bridge keeps working unchanged. Re-add entries here to
// bring providers back.
const CATALOG = [];

const catalogById = id => CATALOG.find(p => p.id === id) || null;

const moduleCache = {};
const lastError = {};             // providerId → message
function providerModule(id) {
  if (moduleCache[id]) return moduleCache[id];
  const entry = catalogById(id);
  if (!entry) return null;
  try { moduleCache[id] = entry.loader(); return moduleCache[id]; }
  catch (e) { lastError[id] = 'load failed: ' + e.message; return null; }
}

function providerMaxHz(id) {
  const mod = moduleCache[id];
  return (mod && mod.meta && mod.meta.maxHz) || 20;
}

// providerId → { devices: [{ id, name, host, optedIn }] }
let config = {};
const lastWrite = new Map();      // device id → "r,g,b" (on-change guard)
const lastWriteAt = new Map();    // device id → ms timestamp (rate-limit)

// Replace the whole external config (called on startup + when providers change).
// Pairing tokens are preserved: if an incoming device lacks a token (e.g. a client
// settings round-trip that never sees tokens), the existing one is kept.
function applyConfig(providers) {
  const prev = config;
  config = {};
  if (!providers || typeof providers !== 'object') return;
  for (const entry of CATALOG) {
    const p = providers[entry.id];
    if (!p || typeof p !== 'object') continue;
    const prevDevices = (prev[entry.id] && prev[entry.id].devices) || [];
    const devices = Array.isArray(p.devices) ? p.devices : [];
    config[entry.id] = {
      devices: devices.map(d => {
        const id = String(d.id || `${entry.id}:${d.host}`).slice(0, 160);
        const old = prevDevices.find(o => o.id === id);
        const token = d.token ? String(d.token).slice(0, 256) : (old ? old.token : undefined);
        return {
          id,
          name: String(d.name || entry.name).slice(0, 80),
          host: String(d.host || '').slice(0, 120),
          optedIn: d.optedIn !== false,
          token,
        };
      }).filter(d => d.host),
    };
  }
}

function getConfig() {
  const out = {};
  for (const id of Object.keys(config)) out[id] = { devices: config[id].devices.map(d => ({ ...d })) };
  return out;
}

// Has any external device been configured at all? Lets the orchestrator decide
// whether to paint even when no iCUE session exists (external-only setups).
function hasDevices() {
  return Object.values(config).some(p => p.devices.length > 0);
}

// Fan colours out to every opted-in external device (on-change + per-provider
// rate-limited). `resolve(deviceId)` returns the colour for that device (per-device
// modes) or null to skip it. Fire-and-forget; each device's error is isolated.
function writeWith(resolve) {
  const now = Date.now();
  for (const entry of CATALOG) {
    const pc = config[entry.id];
    if (!pc || !pc.devices.length) continue;
    const mod = providerModule(entry.id);
    if (!mod) continue;
    const minInterval = 1000 / providerMaxHz(entry.id);
    for (const dev of pc.devices) {
      if (dev.optedIn === false) continue;
      const color = resolve(dev.id);
      if (!color) continue;
      const key = `${color.r},${color.g},${color.b}`;
      if (lastWrite.get(dev.id) === key) continue;                       // unchanged → skip
      if (now - (lastWriteAt.get(dev.id) || 0) < minInterval) continue;  // too soon → retry next tick
      lastWrite.set(dev.id, key);
      lastWriteAt.set(dev.id, now);
      Promise.resolve(mod.write(dev, color)).catch(e => { lastError[entry.id] = 'write: ' + e.message; });
    }
  }
}

// Uniform-colour convenience (same colour to every device).
function write(color) { if (color) writeWith(() => color); }

// Hand all external devices back (turn off / neutral). Fire-and-forget.
function release() {
  for (const entry of CATALOG) {
    const pc = config[entry.id];
    if (!pc || !pc.devices.length) continue;
    const mod = providerModule(entry.id);
    if (!mod) continue;
    for (const dev of pc.devices) {
      Promise.resolve(mod.release(dev)).catch(() => { /* best-effort */ });
    }
  }
  lastWrite.clear();
}

// Upsert found/paired devices into config. Existing entries keep their opt-in;
// a token on the incoming device (from pairing) is applied to the stored entry.
function mergeFound(providerId, found) {
  if (!config[providerId]) config[providerId] = { devices: [] };
  const existing = config[providerId].devices;
  for (const d of found || []) {
    const cur = existing.find(e => e.id === d.id || e.host === d.host);
    if (cur) {
      if (d.name) cur.name = d.name;
      if (d.token) cur.token = d.token;
    } else {
      existing.push({ id: d.id, name: d.name, host: d.host, optedIn: true, token: d.token });
    }
  }
}

// Pair a device (link-button / hold-button providers). Returns the provider's
// result; on success the (tokened) device is upserted into config.
async function pairDevice(providerId, host) {
  const mod = providerModule(providerId);
  if (!mod || typeof mod.pair !== 'function') return { ok: false };
  let r = { ok: false };
  try { r = await mod.pair(host); } catch (e) { lastError[providerId] = 'pair: ' + e.message; }
  if (r && r.ok && r.device) mergeFound(providerId, [r.device]);
  return r;
}

// On-demand discovery across all LAN providers (one subnet sweep, all probes).
async function scan() {
  const lan = CATALOG.filter(e => e.type === 'lan').map(e => {
    const mod = providerModule(e.id);
    return mod ? { id: e.id, probe: mod.probe } : null;
  }).filter(Boolean);

  let byProvider = {};
  try { byProvider = await discovery.sweep(lan); }
  catch (e) { for (const p of lan) lastError[p.id] = 'scan: ' + e.message; }

  for (const id of Object.keys(byProvider)) mergeFound(id, byProvider[id]);
  return { found: byProvider, config: getConfig() };
}

// Manually add a device by host (probe first; reject if it doesn't answer).
async function addDevice(providerId, host) {
  const mod = providerModule(providerId);
  if (!mod) return null;
  let dev = null;
  try { dev = await mod.probe(host); } catch { dev = null; }
  if (!dev) return null;
  mergeFound(providerId, [dev]);
  return dev;
}

function removeDevice(providerId, id) {
  const pc = config[providerId];
  if (!pc) return false;
  const before = pc.devices.length;
  pc.devices = pc.devices.filter(d => d.id !== id);
  lastWrite.delete(id);
  lastWriteAt.delete(id);
  return pc.devices.length !== before;
}

function setDeviceOptIn(providerId, id, on) {
  const pc = config[providerId];
  if (!pc) return false;
  const dev = pc.devices.find(d => d.id === id);
  if (!dev) return false;
  dev.optedIn = !!on;
  return true;
}

// Catalogue + current devices, for the UI (shows every provider — even with no
// devices — so the download link / "search" affordance is always visible).
function getStatus() {
  return {
    providers: CATALOG.map(entry => ({
      id: entry.id,
      name: entry.name,
      type: entry.type,
      needsPairing: !!entry.needsPairing,
      download: entry.download || null,
      // `paired` exposes token presence WITHOUT leaking the token to the client.
      devices: (config[entry.id] ? config[entry.id].devices : []).map(d => ({
        id: d.id, name: d.name, host: d.host, optedIn: d.optedIn !== false,
        paired: !!d.token, needsPairing: !!entry.needsPairing,
      })),
      reason: lastError[entry.id] || null,
    })),
  };
}

module.exports = {
  applyConfig, getConfig, getStatus, hasDevices,
  write, writeWith, release, scan, addDevice, removeDevice, setDeviceOptIn, pairDevice,
};
