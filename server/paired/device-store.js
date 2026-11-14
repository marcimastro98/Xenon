'use strict';
// The saved list of paired devices as it is read back from disk: each record cleaned, and the
// part of a device the settings page may see.

const { ASSET_KEY_RE } = require('./widget-asset-path.js');

const STORE_VERSION = 1;
const STORE_FILENAME = 'remote-devices.json';

const MAX_DEVICES = 16;

const DEVICE_NAME_MAX = 40;

function cleanName(value, fallback) {
  const s = String(value == null ? '' : value)
    // The name is rendered in the device list and echoed back to the phone.
    // Control characters are REPLACED, not stripped, so a name carrying one
    // cannot silently collapse into a different, legitimate-looking name.
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DEVICE_NAME_MAX)
    .trim();
  return s || fallback;
}

/**
 * Explicit key-by-key rebuild of the persisted store — never a spread of what
 * was on disk. A device whose token hash is unusable is dropped rather than
 * kept as an entry that can never authenticate.
 */
function normalizeDeviceStore(value) {
  const src = (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
  const list = Array.isArray(src.devices) ? src.devices : [];
  const devices = [];
  const seenIds = new Set();
  for (const d of list) {
    if (devices.length >= MAX_DEVICES) break;
    if (!d || typeof d !== 'object') continue;
    const id = typeof d.id === 'string' && /^[a-f0-9]{16}$/.test(d.id) ? d.id : '';
    const tokenHash = typeof d.tokenHash === 'string' && /^[a-f0-9]{64}$/.test(d.tokenHash) ? d.tokenHash : '';
    if (!id || !tokenHash || seenIds.has(id)) continue;
    seenIds.add(id);
    devices.push({
      id,
      tokenHash,
      name: cleanName(d.name, 'Device'),
      createdAt: Number.isFinite(d.createdAt) && d.createdAt > 0 ? Math.floor(d.createdAt) : 0,
      lastSeenAt: Number.isFinite(d.lastSeenAt) && d.lastSeenAt > 0 ? Math.floor(d.lastSeenAt) : 0,
      lastIp: typeof d.lastIp === 'string' ? d.lastIp.slice(0, 45) : '',
      // Empty for a device paired before widget assets needed one; load() mints
      // it. Minting here would make this function impure, and it is the one
      // piece of the store that is unit-tested as a pure normalizer.
      assetKey: typeof d.assetKey === 'string' && ASSET_KEY_RE.test(d.assetKey) ? d.assetKey : '',
    });
  }
  return { version: STORE_VERSION, devices };
}

/** The shape sent to the dashboard: never the hash, never the token. */
function publicDevice(d) {
  return { id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, lastIp: d.lastIp };
}

module.exports = {
  STORE_VERSION, STORE_FILENAME, MAX_DEVICES, DEVICE_NAME_MAX, cleanName, normalizeDeviceStore,
  publicDevice,
};
