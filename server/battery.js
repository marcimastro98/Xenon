'use strict';
// Wireless-device battery monitor. Merges three independent, optional sources:
//   - Corsair peripherals via the iCUE SDK bridge (lighting.getBatteryLevels —
//     reads only while the RGB bridge is already connected; NEVER forces a
//     connect for battery's sake)
//   - generic Bluetooth peripherals via the battery.ps1 PnP collector
//   - mice, keyboards, headsets and controllers behind a 2.4 GHz dongle, read by
//     device-battery/, most of which report a charging state
// Any source can be absent (iCUE off, no Bluetooth devices) and the monitor
// degrades silently; the widget shows a friendly empty state when nothing
// reports. Neither the iCUE SDK v4 nor the Bluetooth PnP property exposes a
// charging state — but the collector's Win32_Battery entries (laptop packs,
// USB-connected UPS units, marked type:'system') do, so `charging` is a real
// boolean for those and null for everything else.

const path = require('path');
const { createTwins } = require('./device-battery/twins');

const BATTERY_SCRIPT = path.join(__dirname, 'battery.ps1');
const PERIPHERAL_SOURCES = new Set(['logitech', 'razer', 'dongle', 'usb', 'bluetooth']);
const TTL_MS = 60 * 1000;        // sources are expensive vs. how fast battery moves
const STALE_MS = 10 * 60 * 1000; // drop devices not re-seen for 10 min (asleep/off)
// Asking a dozing mouse wakes its radio, so this source is read far less often, and
// well inside STALE_MS so its devices never flicker out between two reads.
const PERIPHERAL_TTL_MS = 5 * 60 * 1000;
// A mouse left alone sleeps and its dongle stops knowing it: its charge barely moves
// meanwhile, so the last reading stays on screen instead of the device vanishing.
const ASLEEP_MS = 12 * 60 * 60 * 1000;
// A source can miss one read for no reason, so two have to go by before a reading counts as old.
const FRESH_MS = 2 * TTL_MS;
const DONGLE_SOURCES = new Set(['logitech', 'razer', 'dongle']);
const EMPTY_READS_AT_FULL_PACE = 5;
const SCRIPT_TIMEOUT_MS = 20 * 1000; // the CIM device sweep is ~1s, but scales with the paired-device count

// Pure merge, exported for tests. Later writes win a name collision, so the
// caller applies Bluetooth first, then dongle peripherals, then Corsair (the same
// device can be visible over both its dongle and Bluetooth; the dongle reading is
// the more direct one). Entries from prevMap survive a source hiccup until
// STALE_MS, so a sleeping mouse fades out instead of flickering.
function mergeSources(corsair, bluetooth, prevMap, now, peripherals = []) {
  const map = new Map(prevMap);
  const put = (dev, source) => {
    if (!dev || typeof dev !== 'object') return;
    const name = String(dev.name || '').trim();
    if (!name) return;
    const pct = Number(dev.percent);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return;
    const key = name.toLowerCase();
    map.set(key, {
      id: key,
      name,
      percent: Math.round(pct),
      charging: typeof dev.charging === 'boolean' ? dev.charging : null,
      source: dev.type === 'system' ? 'system' : source,
      updatedAt: now,
    });
  };
  for (const dev of (Array.isArray(bluetooth) ? bluetooth : [])) put(dev, 'bluetooth');
  for (const dev of (Array.isArray(peripherals) ? peripherals : [])) put(dev, PERIPHERAL_SOURCES.has(dev && dev.source) ? dev.source : 'usb');
  for (const dev of (Array.isArray(corsair) ? corsair : [])) put(dev, 'corsair');
  for (const [key, entry] of map) {
    const limit = DONGLE_SOURCES.has(entry.source) ? ASLEEP_MS : STALE_MS;
    if (now - entry.updatedAt > limit) map.delete(key);
  }
  return map;
}

// Asking was switched off: what those reads left behind goes with it.
function dropAsked(map) {
  return new Map([...map].filter(([, entry]) => !DONGLE_SOURCES.has(entry.source)));
}

// updatedAt stays internal: on the wire it would change every cycle and defeat the SSE
// broadcast's JSON dedup. lastSeen does not, since it only exists once a device stopped
// answering. Whether a silent device is charging is not known any more.
function onWire({ updatedAt, ...device }, now) {
  return now - updatedAt > FRESH_MS ? { ...device, charging: null, lastSeen: updatedAt } : device;
}

// `runScript` is a one-shot PowerShell spawn, NOT the shared pwsh-worker: the
// worker answers the CPU/GPU/network collectors serially, and a ~1s Bluetooth
// device sweep on it would stall every sensor read behind it. Battery runs at
// most once a minute, so paying a process spawn buys full isolation from the
// permanent sensor host.
//
// `systemBattery` (optional): the PC's own pack from power/index.js, for the
// systems where battery.ps1 cannot run (macOS, Linux). Used only when the
// script reported no pack itself, so Windows never lists it twice.
function createBatteryMonitor({ runScript, lighting, systemBattery, peripherals = null }) {
  const twins = createTwins();
  let deviceMap = new Map();
  let cache = { payload: null, updatedAt: 0 };
  let pending = null;
  let peripheralRead = { result: { available: false, devices: [] }, at: -Infinity };
  let emptyReads = 0;
  let dongleSeen = false;

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

  async function readPeripherals(now) {
    if (typeof peripherals !== 'function') return peripheralRead.result;
    // Nothing found says little: a mouse that was asleep should show up within a minute
    // of waking. A PC that never had one is not worth a process every minute for ever.
    const looking = !peripheralRead.result.devices.length && (dongleSeen || emptyReads < EMPTY_READS_AT_FULL_PACE);
    const wait = looking ? TTL_MS : PERIPHERAL_TTL_MS;
    if (now - peripheralRead.at < wait) return peripheralRead.result;
    let result;
    try {
      result = await peripherals();
    } catch {
      result = { available: false, devices: [] };
    }
    peripheralRead = { result, at: now };
    if (result.devices.length) dongleSeen = true;
    else emptyReads += 1;
    return result;
  }

  async function readSystem(bluetooth) {
    if (typeof systemBattery !== 'function') return [];
    if (bluetooth.devices.some((d) => d && d.type === 'system')) return [];
    try {
      const b = await systemBattery();
      // Plugged in counts as charging, as battery.ps1 reads Win32_Battery.
      return b ? [{ name: 'Battery', percent: b.percent, charging: b.charging === true || b.plugged === true, type: 'system' }] : [];
    } catch {
      return [];
    }
  }

  async function getDevices({ force = false } = {}) {
    if (!force && cache.payload && Date.now() - cache.updatedAt < TTL_MS) return cache.payload;
    if (pending) return pending;
    pending = (async () => {
      try {
        const [corsair, bluetooth, dongles] = await Promise.all([readCorsair(), readBluetooth(), readPeripherals(Date.now())]);
        const system = await readSystem(bluetooth);
        const now = Date.now();
        // With iCUE running it already names the Corsair devices the dongle table would.
        const direct = corsair.devices.length ? dongles.devices.filter((d) => d.vendor !== 'corsair') : dongles.devices;
        if (dongles.asked === false) deviceMap = dropAsked(deviceMap);
        deviceMap = mergeSources(twins.label(corsair.devices), twins.label(bluetooth.devices).concat(system), deviceMap, now, twins.label(direct));
        const devices = [...deviceMap.values()]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((device) => onWire(device, now));
        cache = {
          payload: {
            devices,
            sources: { corsair: corsair.available, bluetooth: bluetooth.available, peripherals: dongles.available },
            ...(dongles.access ? { access: dongles.access } : {}),
          },
          updatedAt: now,
        };
      } catch {
        cache.updatedAt = Date.now();
      }
      pending = null;
      return cache.payload || { devices: [], sources: { corsair: false, bluetooth: false, peripherals: false } };
    })();
    return pending;
  }

  // The switch for asking devices changed: the next read follows it, not the old answer.
  function peripheralsChanged() {
    peripheralRead = { ...peripheralRead, at: -Infinity };
    cache.updatedAt = 0;
  }

  return { getDevices, peripheralsChanged };
}

module.exports = { createBatteryMonitor, mergeSources, ASLEEP_MS, STALE_MS, TTL_MS, PERIPHERAL_TTL_MS, FRESH_MS };
