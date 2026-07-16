'use strict';
// Wireless-device battery monitor. Merges two independent, optional sources:
//   - Corsair peripherals via the iCUE SDK bridge (lighting.getBatteryLevels —
//     reads only while the RGB bridge is already connected; NEVER forces a
//     connect for battery's sake)
//   - generic Bluetooth peripherals via the battery.ps1 PnP collector
// Either source can be absent (iCUE off, no Bluetooth devices) and the monitor
// degrades silently; the widget shows a friendly empty state when nothing
// reports. Neither the iCUE SDK v4 nor the Bluetooth PnP property exposes a
// charging state, so `charging` is always null today (kept in the shape so a
// future source can fill it without a contract change).

const path = require('path');

const BATTERY_SCRIPT = path.join(__dirname, 'battery.ps1');
const TTL_MS = 60 * 1000;        // sources are expensive vs. how fast battery moves
const STALE_MS = 10 * 60 * 1000; // drop devices not re-seen for 10 min (asleep/off)
const SCRIPT_TIMEOUT_MS = 20 * 1000; // the CIM device sweep is ~1s, but scales with the paired-device count

// Pure merge, exported for tests. Later writes win a name collision, so the
// caller applies Bluetooth first and Corsair second (the same device can be
// visible over both its Slipstream dongle and Bluetooth; the Corsair reading
// is the more direct one). Entries from prevMap survive a source hiccup until
// STALE_MS, so a sleeping mouse fades out instead of flickering.
function mergeSources(corsair, bluetooth, prevMap, now) {
  const map = new Map(prevMap);
  const put = (dev, source) => {
    if (!dev || typeof dev !== 'object') return;
    const name = String(dev.name || '').trim();
    if (!name) return;
    const pct = Number(dev.percent);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return;
    const key = name.toLowerCase();
    map.set(key, { id: key, name, percent: Math.round(pct), charging: null, source, updatedAt: now });
  };
  for (const dev of (Array.isArray(bluetooth) ? bluetooth : [])) put(dev, 'bluetooth');
  for (const dev of (Array.isArray(corsair) ? corsair : [])) put(dev, 'corsair');
  for (const [key, entry] of map) {
    if (now - entry.updatedAt > STALE_MS) map.delete(key);
  }
  return map;
}

// `runScript` is a one-shot PowerShell spawn, NOT the shared pwsh-worker: the
// worker answers the CPU/GPU/network collectors serially, and a ~1s Bluetooth
// device sweep on it would stall every sensor read behind it. Battery runs at
// most once a minute, so paying a process spawn buys full isolation from the
// permanent sensor host.
function createBatteryMonitor({ runScript, lighting }) {
  let deviceMap = new Map();
  let cache = { payload: null, updatedAt: 0 };
  let pending = null;

  async function readCorsair() {
    try {
      const res = await lighting.getBatteryLevels();
      return { available: !!(res && res.ok), devices: (res && res.devices) || [] };
    } catch {
      return { available: false, devices: [] };
    }
  }

  async function readBluetooth() {
    try {
      const data = await runScript(BATTERY_SCRIPT, [], SCRIPT_TIMEOUT_MS);
      let devs = data && data.devices;
      // Windows PowerShell 5.1 can unwrap a single-element array on serialize.
      if (devs && !Array.isArray(devs)) devs = [devs];
      return { available: true, devices: Array.isArray(devs) ? devs : [] };
    } catch {
      return { available: false, devices: [] };
    }
  }

  async function getDevices({ force = false } = {}) {
    if (!force && cache.payload && Date.now() - cache.updatedAt < TTL_MS) return cache.payload;
    if (pending) return pending;
    pending = (async () => {
      try {
        const [corsair, bluetooth] = await Promise.all([readCorsair(), readBluetooth()]);
        const now = Date.now();
        deviceMap = mergeSources(corsair.devices, bluetooth.devices, deviceMap, now);
        // updatedAt stays internal (it drives stale eviction): on the wire it
        // would change every cycle and defeat the SSE broadcast's JSON dedup.
        const devices = [...deviceMap.values()]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(({ updatedAt, ...pub }) => pub);
        cache = {
          payload: { devices, sources: { corsair: corsair.available, bluetooth: bluetooth.available } },
          updatedAt: now,
        };
      } catch {
        cache.updatedAt = Date.now();
      }
      pending = null;
      return cache.payload || { devices: [], sources: { corsair: false, bluetooth: false } };
    })();
    return pending;
  }

  return { getDevices };
}

module.exports = { createBatteryMonitor, mergeSources, STALE_MS, TTL_MS };
