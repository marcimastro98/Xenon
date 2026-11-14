'use strict';
// A phone's push subscription as it is accepted and kept: a public HTTPS endpoint, its keys,
// and the saved list cleaned.

const { isPublicUrl } = require('../net-guard.js');
const { fromB64u } = require('./push-crypto.js');

const STORE_VERSION = 1;

// A subscription is a URL the push service handed the browser. It is a bearer
// address: anyone holding it can ask the service to wake that install, which is
// what VAPID exists to make useless to them.
const MAX_SUBSCRIPTIONS = 32;
const MAX_ENDPOINT_LEN = 1024;

/**
 * Validate what the browser handed us. Everything here arrives from a client,
 * and the endpoint in particular becomes an outbound request from the user's
 * PC — so it is checked the way `/sdk/fetch` checks a host, not the way a
 * settings field is checked.
 */
function normalizeSubscription(input, { deviceId = '' } = {}) {
  const s = input && typeof input === 'object' ? input : {};
  const endpoint = String(s.endpoint || '');
  if (!endpoint || endpoint.length > MAX_ENDPOINT_LEN) return null;
  let u;
  try { u = new URL(endpoint); } catch { return null; }
  // https only, and no credentials in the URL: both would end up in a log.
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (!isPublicUrl(endpoint)) return null;
  const keys = s.keys && typeof s.keys === 'object' ? s.keys : s;
  const p256dh = String(keys.p256dh || '');
  const auth = String(keys.auth || '');
  try {
    const pub = fromB64u(p256dh);
    if (pub.length !== 65 || pub[0] !== 0x04) return null;
    if (fromB64u(auth).length !== 16) return null;
  } catch { return null; }
  return {
    endpoint, p256dh, auth,
    deviceId: String(deviceId || '').slice(0, 64),
    createdAt: 0, lastOkAt: 0, failures: 0,
  };
}

function normalizeStore(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const jwk = r.keys && typeof r.keys === 'object' ? r.keys : null;
  const ok = jwk && jwk.kty === 'EC' && jwk.crv === 'P-256'
    && typeof jwk.x === 'string' && typeof jwk.y === 'string' && typeof jwk.d === 'string';
  const subs = [];
  const seen = new Set();
  for (const s of Array.isArray(r.subs) ? r.subs : []) {
    const n = normalizeSubscription(s, { deviceId: s && s.deviceId });
    if (!n || seen.has(n.endpoint)) continue;
    seen.add(n.endpoint);
    n.createdAt = Number.isFinite(s.createdAt) && s.createdAt > 0 ? Math.floor(s.createdAt) : 0;
    n.lastOkAt = Number.isFinite(s.lastOkAt) && s.lastOkAt > 0 ? Math.floor(s.lastOkAt) : 0;
    n.failures = Number.isFinite(s.failures) && s.failures > 0 ? Math.min(999, Math.floor(s.failures)) : 0;
    subs.push(n);
    if (subs.length >= MAX_SUBSCRIPTIONS) break;
  }
  return { version: STORE_VERSION, keys: ok ? { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d } : null, subs };
}

module.exports = {
  STORE_VERSION, MAX_SUBSCRIPTIONS, MAX_ENDPOINT_LEN, normalizeSubscription, normalizeStore,
};
