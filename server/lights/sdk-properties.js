'use strict';
// What the iCUE SDK says about a device: the LEDs on each of its channels and its battery.

const { bridge } = require('./bridge-state.js');
const { withSdkTimeout } = require('./sdk-call.js');

// --- Channel layout (which LEDs are which fan / pump / RAM stick) ------------
// CDPI ids and the Int32-array shape ({ int* items; uint count; } in the value
// union at offset 8) are from the official iCUE SDK v4 header; index = channel.
// rc-tolerant like the battery read: a device that does not answer simply draws
// as one block on the map. Cached per device + LED count, because the wiring
// only changes on a hot-plug and the slow rescan would otherwise re-read it
// every DEVICE_RESCAN_MS.
const CDPI_CHANNEL_DEVICE_LED_COUNTS = 12;
const CDPI_CHANNEL_DEVICE_TYPES = 13;
const CT_STRING = 3;              // first non-scalar CorsairDataType
const CT_INT32_ARRAY = 17;
const MAX_CHANNELS = 8;
const MAX_CHANNEL_DEVICES = 64;
const channelCache = new Map();   // deviceId → { ledCount, channels }

async function readInt32ArrayProperty(deviceId, propertyId, index) {
  const buf = Buffer.alloc(CORSAIR_PROPERTY_BYTES);
  const rc = await withSdkTimeout(new Promise((resolve, reject) =>
    bridge.fns.readProperty.async(deviceId, propertyId, index, buf, (err, rc) => err ? reject(err) : resolve(rc))
  ), 'CorsairReadDeviceProperty');
  if (rc !== 0) return null;
  const dataType = buf.readInt32LE(0);
  try {
    if (dataType !== CT_INT32_ARRAY) return null;
    const count = buf.readUInt32LE(16);
    if (count > MAX_CHANNEL_DEVICES) return null;
    if (!count) return [];
    return Array.from(bridge.koffi.decode(bridge.koffi.decode(buf, 8, 'void *'), 'int', count));
  } finally {
    // Every non-scalar payload is an SDK-side allocation (see getBatteryLevels).
    if (dataType >= CT_STRING) { try { bridge.fns.freeProperty.async(buf, () => {}); } catch { /* best-effort */ } }
  }
}

async function channelLayout(deviceId, channelCount, ledCount) {
  if (!(channelCount > 0)) return null;
  const hit = channelCache.get(deviceId);
  if (hit && hit.ledCount === ledCount) return hit.channels;
  let channels = [];
  try {
    for (let c = 0; c < Math.min(channelCount, MAX_CHANNELS); c++) {
      const ledCounts = await readInt32ArrayProperty(deviceId, CDPI_CHANNEL_DEVICE_LED_COUNTS, c);
      const types = await readInt32ArrayProperty(deviceId, CDPI_CHANNEL_DEVICE_TYPES, c);
      if (!ledCounts || !types) { channels = null; break; }
      channels.push({ ledCounts, types });
    }
  } catch { channels = null; }
  // Only a complete read is cached; a timeout gets another try on the next scan.
  if (channels) channelCache.set(deviceId, { ledCount, channels });
  return channels;
}

// --- Device battery (CDPI_BatteryLevel) ------------------------------------
// Battery percent of the enumerated wireless Corsair devices. Read-only and
// side-effect free: it NEVER connects on demand — when the RGB bridge is off
// or disconnected the caller degrades to its other sources (Bluetooth PnP).
// Values confirmed against the official iCUE SDK v4 header (CorsairOfficial/
// cue-sdk): CDPI_BatteryLevel = 9, CT_Int32 = 1, CE_Success = 0; wired or
// unsupported devices answer CE_NotAllowed and are skipped. The v4 SDK has no
// charging-state property, so only the percent is reported.
const CDPI_BATTERY_LEVEL = 9;
const CT_INT32 = 1;
const CORSAIR_PROPERTY_BYTES = 24; // sizeof(CorsairProperty) on x64 — see fns.readProperty

async function getBatteryLevels() {
  if (!bridge.connected || !bridge.fns) return { ok: false, reason: 'icue_off', devices: [] };
  const out = [];
  for (const dev of bridge.devices) {
    try {
      const buf = Buffer.alloc(CORSAIR_PROPERTY_BYTES);
      const rc = await withSdkTimeout(new Promise((resolve, reject) =>
        bridge.fns.readProperty.async(dev.id, CDPI_BATTERY_LEVEL, 0, buf, (err, rc) => err ? reject(err) : resolve(rc))
      ), 'CorsairReadDeviceProperty');
      if (rc !== 0) continue; // wired / unsupported device (CE_NotAllowed etc.)
      const dataType = buf.readInt32LE(0);
      if (dataType !== CT_INT32) {
        // Unexpected payload (string/array): free the SDK-side allocation and
        // skip. Fire-and-forget on the async worker path — no sync FFI on the
        // event loop, and nothing to wait for on a best-effort free.
        try { bridge.fns.freeProperty.async(buf, () => {}); } catch { /* best-effort */ }
        continue;
      }
      const percent = buf.readInt32LE(8);
      if (percent < 0 || percent > 100) continue;
      // The SDK's own CorsairDeviceType: battery.js turns it into the device's kind.
      out.push({ name: String(dev.model || '').trim(), percent, unit: String(dev.id || ''), corsairType: Number(dev.type) || 0 });
    } catch { /* per-device failure: skip, never fail the batch */ }
  }
  return { ok: true, devices: out.filter(d => d.name) };
}

module.exports = {
  CDPI_CHANNEL_DEVICE_LED_COUNTS, CDPI_CHANNEL_DEVICE_TYPES, CT_STRING, CT_INT32_ARRAY,
  MAX_CHANNELS, MAX_CHANNEL_DEVICES, channelCache, readInt32ArrayProperty, channelLayout,
  CDPI_BATTERY_LEVEL, CT_INT32, CORSAIR_PROPERTY_BYTES, getBatteryLevels,
};
