'use strict';
// Keeps the paired devices: pairing with a code, looking a device up by its token, renaming,
// revoking, and forgetting one that has not come back for a long time.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomic } = require('../atomic-write.js');
const {
  CODE_LENGTH, hashToken, newToken, newAssetKey, newCode, canonicalCode, formatCode, safeEqual,
} = require('./tokens-and-codes.js');
const { ASSET_KEY_RE } = require('./widget-asset-path.js');
const {
  STORE_VERSION, STORE_FILENAME, MAX_DEVICES, cleanName, normalizeDeviceStore, publicDevice,
} = require('./device-store.js');
const { createRateLimiter, DEVICE_RATE_LIMIT } = require('./rate-limit.js');

const CODE_TTL_MS = 3 * 60 * 1000;      // a pairing code is a live invitation, not a password
const CODE_MAX_ATTEMPTS = 5;            // wrong guesses before the code is burned

/**
 * Owns DATA_DIR/remote-devices.json and the in-memory pairing code.
 *
 * The store is loaded once and kept in memory: authenticate() runs on every
 * remote request and must not touch the disk. Writes go through
 * writeFileAtomic, like every other durable store.
 */
// How long a paired device may go unused before its token stops working.
const IDLE_EXPIRY_MS = 90 * 24 * 60 * 60 * 1000;

function createRemoteAccess({ dir, now = () => Date.now() } = {}) {
  const file = path.join(String(dir || '.'), STORE_FILENAME);
  let store = { version: STORE_VERSION, devices: [] };
  let loaded = false;

  // The live pairing invitation. At most one at a time: two open codes on
  // screen is a UI nobody asked for, and it doubles the guessing surface.
  let pending = null;   // { code, expiresAt, attempts }

  const redeemLimiter = createRateLimiter({ limit: 10, windowMs: 60 * 1000 });
  const deviceLimiter = createRateLimiter({ limit: DEVICE_RATE_LIMIT, windowMs: 60 * 1000 });

  async function load() {
    if (loaded) return store;
    try {
      const raw = await fs.promises.readFile(file, 'utf8');
      store = normalizeDeviceStore(JSON.parse(raw));
    } catch (e) {
      // ENOENT is the normal first-run case. A parse failure means the file is
      // damaged; starting from empty is right here (unlike notes, no user
      // content is lost — the user re-pairs), but say so rather than swallow it.
      if (e && e.code !== 'ENOENT') console.warn('[remote-access] device store unreadable, starting empty:', e.message);
      store = { version: STORE_VERSION, devices: [] };
    }
    // Devices paired before the widget-asset capability existed have no key.
    // Mint one rather than let their SDK widgets render unstyled — the user
    // would have to un-pair and re-pair to fix a thing they cannot see.
    let minted = 0;
    for (const d of store.devices) {
      if (!d.assetKey) { d.assetKey = newAssetKey(); minted++; }
    }
    loaded = true;
    if (minted) persist().catch((e) => console.warn('[remote-access] could not persist asset keys:', e.message));
    return store;
  }

  async function persist() {
    await writeFileAtomic(file, JSON.stringify(store, null, 2));
  }

  /** Open a pairing window. Replaces any previous code — see `pending`. */
  function startPairing() {
    const t = now();
    pending = { code: newCode(), expiresAt: t + CODE_TTL_MS, attempts: 0 };
    return { code: pending.code, display: formatCode(pending.code), expiresAt: pending.expiresAt };
  }

  function cancelPairing() { pending = null; }

  function pairingState() {
    if (!pending) return null;
    if (now() >= pending.expiresAt) { pending = null; return null; }
    return { code: pending.code, display: formatCode(pending.code), expiresAt: pending.expiresAt };
  }

  /**
   * Redeem a pairing code for a device token.
   * Returns `{ ok:true, token, device }` or `{ ok:false, error }` — never
   * throws, and never says WHICH part was wrong.
   */
  async function redeem(code, { name, ip } = {}) {
    await load();
    const t = now();
    if (!redeemLimiter.take('ip:' + (ip || '?'), t)) return { ok: false, error: 'rate_limited' };
    if (!pending || t >= pending.expiresAt) { pending = null; return { ok: false, error: 'no_pairing' }; }
    const got = canonicalCode(code);
    if (got.length !== CODE_LENGTH || !safeEqual(got, pending.code)) {
      pending.attempts++;
      // Burn the invitation rather than let it be ground down. The user taps
      // "Aggiungi dispositivo" again, which costs one tap and voids the guesses.
      if (pending.attempts >= CODE_MAX_ATTEMPTS) pending = null;
      return { ok: false, error: 'bad_code' };
    }
    if (store.devices.length >= MAX_DEVICES) return { ok: false, error: 'too_many_devices' };
    pending = null;                       // single use, always
    const token = newToken();
    const device = {
      id: crypto.randomBytes(8).toString('hex'),
      tokenHash: hashToken(token),
      name: cleanName(name, 'Device'),
      createdAt: t,
      lastSeenAt: t,
      lastIp: String(ip || '').slice(0, 45),
      assetKey: newAssetKey(),
    };
    store.devices.push(device);
    await persist();
    return { ok: true, token, device: publicDevice(device) };
  }

  /**
   * Resolve a token to a device. Hot path: called on every remote request, so
   * it hashes once and compares in constant time against each stored hash.
   * Returns null for anything that does not resolve.
   */
  function authenticate(token) {
    if (!loaded || !token) return null;
    const s = String(token);
    if (s.length < 16 || s.length > 128) return null;
    const h = hashToken(s);
    for (const d of store.devices) {
      if (!safeEqual(h, d.tokenHash)) continue;
      // A device unused for IDLE_EXPIRY_MS stops working: a phone sold, lost or
      // forgotten in a drawer should not keep a key to this PC for ever. It
      // stays listed so the user sees it and can pair it again or remove it.
      // A device from before lastSeenAt was recorded (0) is not judged on it.
      if (d.lastSeenAt > 0 && now() - d.lastSeenAt > IDLE_EXPIRY_MS) return null;
      return d;
    }
    return null;
  }

  /**
   * Resolve a widget-asset capability to its device. Deliberately NOT part of
   * `authenticate`: this key unlocks static package files and nothing else, so
   * it must never become an alternative way to present a device token. Compared
   * in constant time like the token, for the same reason.
   */
  function authenticateAssetKey(key) {
    if (!loaded || typeof key !== 'string' || !ASSET_KEY_RE.test(key)) return null;
    for (const d of store.devices) {
      if (d.assetKey && safeEqual(key, d.assetKey)) return d;
    }
    return null;
  }

  /** Budget check for an authenticated device. */
  function withinRate(deviceId, at) {
    return deviceLimiter.take('dev:' + deviceId, Number.isFinite(at) ? at : now());
  }

  /**
   * Budget check for the token-less surface, by source address. Shares the
   * limiter with redeem() on purpose: loading the pairing page and guessing a
   * code are the same door, and someone probing it should not get a fresh
   * allowance by alternating between the two.
   */
  function withinPreAuthRate(ip, at) {
    return redeemLimiter.take('ip:' + (ip || '?'), Number.isFinite(at) ? at : now());
  }

  // lastSeen/lastIp are UI comfort, not security — flush them lazily so a phone
  // holding an SSE stream open does not rewrite the store on every request.
  let dirtySince = 0;
  const TOUCH_FLUSH_MS = 60 * 1000;
  function touch(device, ip) {
    if (!device) return;
    const t = now();
    device.lastSeenAt = t;
    if (ip) device.lastIp = String(ip).slice(0, 45);
    if (!dirtySince) dirtySince = t;
    if (t - dirtySince < TOUCH_FLUSH_MS) return;
    dirtySince = 0;
    persist().catch(() => { /* a stale "last seen" is not worth an error path */ });
  }

  async function rename(id, name) {
    await load();
    const d = store.devices.find((x) => x.id === id);
    if (!d) return { ok: false, error: 'not_found' };
    d.name = cleanName(name, d.name);
    await persist();
    return { ok: true, device: publicDevice(d) };
  }

  async function revoke(id) {
    await load();
    const before = store.devices.length;
    store.devices = store.devices.filter((x) => x.id !== id);
    if (store.devices.length === before) return { ok: false, error: 'not_found' };
    await persist();
    return { ok: true };
  }

  async function revokeAll() {
    await load();
    const n = store.devices.length;
    store.devices = [];
    pending = null;
    await persist();
    return { ok: true, revoked: n };
  }

  function list() { return store.devices.map(publicDevice); }
  function count() { return store.devices.length; }
  /**
   * Has the store been read yet? Until it has, authenticate() cannot succeed —
   * so the gate must treat the feature as OFF rather than as "this device is
   * not paired". The distinction matters for the few milliseconds after boot:
   * refusing looks like a server still starting (and a refresh fixes it),
   * whereas sending a paired phone to the pairing page looks like it was
   * silently unpaired, which it was not.
   */
  function isLoaded() { return loaded; }

  /** Flush any pending lastSeen bookkeeping (called from graceful shutdown). */
  async function flush() {
    if (!dirtySince) return;
    dirtySince = 0;
    await persist().catch(() => {});
  }

  return {
    load, list, count, flush, isLoaded,
    startPairing, cancelPairing, pairingState, redeem,
    authenticate, authenticateAssetKey, withinRate, withinPreAuthRate, touch, rename, revoke, revokeAll,
    get file() { return file; },
  };
}

module.exports = { CODE_TTL_MS, CODE_MAX_ATTEMPTS, IDLE_EXPIRY_MS, createRemoteAccess };
