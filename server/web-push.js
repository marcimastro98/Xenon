'use strict';

/* Web Push (T2c) — the last thing a phone can do that a web page on plain HTTP
 * cannot: reach you when it is closed.
 *
 * WHY THIS IS HAND-ROLLED. The obvious move is `npm i web-push`. This repo has
 * a standing rule against dependencies it does not need, and this is one of the
 * cases the rule is for: the whole protocol is two RFCs' worth of HMAC, one
 * ECDH and one AES-GCM call, all of which node:crypto already does. What we
 * would be importing is not capability, it is a transitive tree sitting on the
 * path of a message the user's PC sends to Apple and Google.
 *
 * WHAT IT IS. Two specs, and it is worth naming which does what because they
 * are easy to conflate:
 *   - RFC 8292 (VAPID) is IDENTITY. A signed JWT saying "the server that
 *     subscribed you is the one pushing now". It is what stops anyone who
 *     scrapes an endpoint URL from pushing to it.
 *   - RFC 8291 (aes128gcm) is PRIVACY. The payload is encrypted to a key pair
 *     the BROWSER generated, so the push service (Apple, Google, Mozilla) moves
 *     bytes it cannot read. This matters here more than usual: the text is
 *     "your timer finished" or "Claude wants to run a command", and it is
 *     travelling through a company Xenon otherwise has nothing to do with.
 *
 * WHAT THE USER TRADES. Push CANNOT work without a push service — the phone
 * holds one connection to its vendor and everything arrives over it, which is
 * the entire reason it costs no battery. So this is the one Xenon feature where
 * something leaves the user's machine for a third party by design. Two things
 * make it honest rather than a hole: it is off until switched on, per device;
 * and what leaves is a ciphertext the service cannot open, addressed to a URL
 * that says nothing about who or where the user is.
 *
 * WHAT IT DOES NOT DO. No marketing, no digests, no "come back" nudges — the
 * only things that push are events the user themselves set up. There is no
 * server of ours in the middle: the PC talks to the push service directly.
 */

const crypto = require('node:crypto');
const https = require('node:https');
const path = require('node:path');
const fs = require('node:fs');
const { writeFileAtomic } = require('./atomic-write.js');
const { guardedLookup } = require('./sdk-proxy.js');

const STORE_FILENAME = 'web-push.json';
const STORE_VERSION = 1;

// A subscription is a URL the push service handed the browser. It is a bearer
// address: anyone holding it can ask the service to wake that install, which is
// what VAPID exists to make useless to them.
const MAX_SUBSCRIPTIONS = 32;
const MAX_ENDPOINT_LEN = 1024;
const PAYLOAD_MAX_BYTES = 3000;      // under every service's 4KB record limit
const RECORD_SIZE = 4096;
const DEFAULT_TTL = 600;             // 10 minutes: a stale "timer finished" is noise
const JWT_TTL_SEC = 12 * 3600;       // RFC 8292 caps this at 24h; half is plenty
const SEND_TIMEOUT_MS = 10_000;
// A subscription that keeps failing without ever saying "gone" (a service that
// is down, a phone that is off) must not be retried forever, and must not be
// deleted either — the user did not unsubscribe. Park it after this many.
const MAX_FAILURES = 10;

// ── Encoding ─────────────────────────────────────────────────────────────────

const b64u = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function fromB64u(s) {
  const t = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(t + '='.repeat((4 - (t.length % 4)) % 4), 'base64');
}

// ── Keys ─────────────────────────────────────────────────────────────────────

/**
 * A fresh VAPID key pair, stored as a JWK because that is the one shape node
 * can turn back into both a signing key and the raw 65-byte public point the
 * browser wants — going through PEM would mean parsing DER by hand to get the
 * point back out.
 */
function generateVapidKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  return {
    jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d },
    publicKey: b64u(rawPublicFromJwk(jwk)),
    _publicKeyObject: publicKey,
  };
}

/** The uncompressed SEC1 point (0x04 ‖ X ‖ Y) — what applicationServerKey is. */
function rawPublicFromJwk(jwk) {
  const x = fromB64u(jwk.x);
  const y = fromB64u(jwk.y);
  if (x.length !== 32 || y.length !== 32) throw new Error('bad_jwk');
  return Buffer.concat([Buffer.from([0x04]), x, y]);
}

// ── RFC 8292: the VAPID token ────────────────────────────────────────────────

/**
 * The audience is the ORIGIN of the endpoint, never the whole URL. A token
 * carrying the full path would leak the subscription address into a header the
 * service logs, and would be rejected besides.
 */
function vapidAudience(endpoint) {
  const u = new URL(String(endpoint));
  if (u.protocol !== 'https:') throw new Error('insecure_endpoint');
  return u.origin;
}

/**
 * ES256 over {header}.{claims}. The signature MUST be the raw r‖s pair, not the
 * DER structure node signs with by default — `dsaEncoding: 'ieee-p1363'` is the
 * whole difference between a token every push service accepts and one every
 * push service answers 401 to.
 */
function buildJwt({ audience, subject, jwk, now = Date.now() }) {
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({
    aud: String(audience),
    exp: Math.floor(now / 1000) + JWT_TTL_SEC,
    sub: String(subject),
  }));
  const input = header + '.' + claims;
  const key = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
  return input + '.' + b64u(sig);
}

// ── RFC 8291: the encrypted payload ──────────────────────────────────────────

/**
 * Encrypt `payload` to a subscription's keys, producing the exact body an
 * `aes128gcm` push request carries.
 *
 * The ladder, in the order the RFC builds it:
 *   ecdh   = ECDH(ephemeral private, browser public)
 *   IKM    = HKDF(salt = auth_secret, ikm = ecdh, info = "WebPush: info" ‖ 0 ‖ ua ‖ as)
 *   CEK    = HKDF(salt = random 16, ikm = IKM, info = "Content-Encoding: aes128gcm" ‖ 0)
 *   nonce  = HKDF(same salt and IKM,  info = "Content-Encoding: nonce" ‖ 0)
 *
 * The two HKDF stages are NOT interchangeable: the first mixes in the shared
 * secret and both public keys, the second turns that into this message's key.
 *
 * `salt` and `ephemeral` are injectable so the test suite can pin a known
 * vector — production never passes them.
 */
function encryptPayload({ payload, p256dh, auth, salt, ephemeral }) {
  const plaintext = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  if (plaintext.length > PAYLOAD_MAX_BYTES) throw new Error('payload_too_large');

  const uaPublic = fromB64u(p256dh);
  const authSecret = fromB64u(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error('bad_p256dh');
  if (authSecret.length !== 16) throw new Error('bad_auth');

  const ecdh = ephemeral || crypto.createECDH('prime256v1');
  if (!ephemeral) ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  // Throws on a point that is not on the curve, which is the check that keeps a
  // forged p256dh from becoming an invalid-curve attack on our ephemeral key.
  const shared = ecdh.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic]);
  const ikm = crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32);

  const useSalt = salt || crypto.randomBytes(16);
  if (useSalt.length !== 16) throw new Error('bad_salt');
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, useSalt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, useSalt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12));

  // 0x02 is the padding delimiter for the LAST record. We always send exactly
  // one record, so it is always 0x02 — 0x01 here would be a message the browser
  // waits forever for the rest of.
  const record = Buffer.concat([plaintext, Buffer.from([0x02])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(21);
  useSalt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

// ── Subscriptions ────────────────────────────────────────────────────────────

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

// ── The transport ────────────────────────────────────────────────────────────

/**
 * POST one encrypted body to one endpoint. Split out from the store so the test
 * suite can drive it against a local server, and so the retry/expiry policy
 * lives in exactly one place above it.
 *
 * `request` is injectable for the same reason; production uses https.request.
 */
function postToService({ endpoint, body, jwt, vapidPublicKey, ttl = DEFAULT_TTL, urgency = 'normal', request = https.request, timeoutMs = SEND_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(endpoint); } catch { return resolve({ ok: false, status: 0, error: 'bad_endpoint' }); }
    if (u.protocol !== 'https:') return resolve({ ok: false, status: 0, error: 'insecure_endpoint' });
    const req = request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || 443,
      path: u.pathname + u.search, method: 'POST',
      // The same guard the SDK proxy uses. A subscription endpoint is a URL a
      // client chose, so without this it is an SSRF primitive aimed at the
      // user's own machine.
      lookup: guardedLookup,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        'Content-Length': body.length,
        TTL: String(Math.max(0, Math.min(86400, ttl | 0))),
        Urgency: urgency === 'high' ? 'high' : 'normal',
        Authorization: 'vapid t=' + jwt + ', k=' + vapidPublicKey,
      },
    }, (res) => {
      // The answer is a status code; nothing in the body is useful to us and a
      // service can return a long one, so it is drained rather than collected.
      res.resume();
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode }));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ ok: false, status: 0, error: (e && e.code) || 'network' }));
    req.end(body);
  });
}

/** 404 and 410 are the service saying the subscription no longer exists. */
const isGone = (status) => status === 404 || status === 410;

// ── The store ────────────────────────────────────────────────────────────────

/**
 * Owns DATA_DIR/web-push.json: the VAPID key pair (created once, on first use)
 * and the subscriptions. Loaded once and kept in memory; written through
 * writeFileAtomic like every other durable store here.
 */
function createWebPush({ dir, subject = 'mailto:support@xenon-app.com', now = () => Date.now(), log = () => {} } = {}) {
  const file = path.join(String(dir || '.'), STORE_FILENAME);
  let store = { version: STORE_VERSION, keys: null, subs: [] };
  let loaded = false;

  async function load() {
    if (loaded) return store;
    try {
      store = normalizeStore(JSON.parse(await fs.promises.readFile(file, 'utf8')));
    } catch (e) {
      if (e && e.code !== 'ENOENT') log('[web-push] store unreadable, starting empty: ' + e.message);
      store = { version: STORE_VERSION, keys: null, subs: [] };
    }
    loaded = true;
    return store;
  }

  const persist = () => writeFileAtomic(file, JSON.stringify(store, null, 2));

  /**
   * The key pair is minted lazily, on the first request for it. Generating it
   * at boot would put a keypair on the disk of every install that never turns
   * notifications on — and rotating it silently invalidates every subscription
   * ever made, so it is created once and then left alone.
   */
  async function publicKey() {
    await load();
    if (!store.keys) {
      const k = generateVapidKeys();
      store.keys = k.jwk;
      await persist();
      log('[web-push] VAPID key pair created');
    }
    return b64u(rawPublicFromJwk(store.keys));
  }

  async function subscribe(input, { deviceId } = {}) {
    await load();
    const sub = normalizeSubscription(input, { deviceId });
    if (!sub) return { ok: false, error: 'bad_subscription' };
    const existing = store.subs.findIndex((s) => s.endpoint === sub.endpoint);
    if (existing >= 0) {
      // Re-subscribing is normal: a browser rotates an endpoint whenever it
      // feels like it, and the page re-registers on every load. Update in place
      // and clear the failure count rather than stacking duplicates.
      store.subs[existing] = { ...sub, createdAt: store.subs[existing].createdAt || now(), failures: 0 };
    } else {
      if (store.subs.length >= MAX_SUBSCRIPTIONS) return { ok: false, error: 'too_many' };
      store.subs.push({ ...sub, createdAt: now() });
    }
    await persist();
    return { ok: true, count: store.subs.length };
  }

  async function unsubscribe(endpoint) {
    await load();
    const before = store.subs.length;
    store.subs = store.subs.filter((s) => s.endpoint !== String(endpoint || ''));
    if (store.subs.length !== before) await persist();
    return { ok: true, removed: before - store.subs.length };
  }

  /**
   * Drop every subscription belonging to a device. Called when a device is
   * revoked: a phone that has been thrown off the dashboard must stop being
   * woken by it, and it cannot unsubscribe itself once its token is dead.
   */
  async function dropDevice(deviceId) {
    await load();
    const id = String(deviceId || '');
    if (!id) return { ok: true, removed: 0 };
    const before = store.subs.length;
    store.subs = store.subs.filter((s) => s.deviceId !== id);
    if (store.subs.length !== before) await persist();
    return { ok: true, removed: before - store.subs.length };
  }

  async function list() {
    await load();
    // Never the endpoint or the keys: this answers a browser, and the endpoint
    // is the one piece of a subscription that is worth stealing.
    return store.subs.map((s) => ({
      host: (() => { try { return new URL(s.endpoint).host; } catch { return '?'; } })(),
      deviceId: s.deviceId, createdAt: s.createdAt, lastOkAt: s.lastOkAt, failures: s.failures,
    }));
  }

  async function hasSubscription(endpoint) {
    await load();
    return store.subs.some((s) => s.endpoint === String(endpoint || ''));
  }

  /**
   * Send one notification to every live subscription.
   *
   * `message` is what the service worker renders: { title, body, tag, url }.
   * It is JSON, it is encrypted, and it should stay short — the point is a
   * line on a lock screen, not the content itself.
   */
  async function send(message, { ttl = DEFAULT_TTL, urgency = 'normal', deviceId = null, request } = {}) {
    await load();
    if (!store.keys) return { ok: false, error: 'no_keys', sent: 0 };
    const targets = store.subs.filter((s) => s.failures < MAX_FAILURES
      && (deviceId == null || s.deviceId === deviceId));
    if (!targets.length) return { ok: true, sent: 0, targets: 0 };

    const payload = Buffer.from(JSON.stringify({
      title: String((message && message.title) || 'Xenon').slice(0, 120),
      body: String((message && message.body) || '').slice(0, 400),
      tag: String((message && message.tag) || 'xenon').slice(0, 64),
      url: String((message && message.url) || '/').slice(0, 300),
    }), 'utf8');

    const vapidPublicKey = b64u(rawPublicFromJwk(store.keys));
    let sent = 0, gone = 0, failed = 0, dirty = false;
    for (const sub of targets) {
      let body, jwt;
      try {
        body = encryptPayload({ payload, p256dh: sub.p256dh, auth: sub.auth });
        jwt = buildJwt({ audience: vapidAudience(sub.endpoint), subject, jwk: store.keys, now: now() });
      } catch (e) {
        // A subscription we cannot even encrypt to is broken beyond retrying.
        sub.failures = MAX_FAILURES; dirty = true; failed++;
        log('[web-push] cannot encrypt for a subscription: ' + e.message);
        continue;
      }
      const res = await postToService({ endpoint: sub.endpoint, body, jwt, vapidPublicKey, ttl, urgency, request });
      if (res.ok) {
        sent++; sub.lastOkAt = now();
        if (sub.failures) { sub.failures = 0; }
        dirty = true;
      } else if (isGone(res.status)) {
        // The user uninstalled the app or cleared the site. Deleting is right:
        // this is the service telling us the address does not exist any more.
        gone++; sub._gone = true; dirty = true;
      } else {
        failed++; sub.failures++; dirty = true;
        log('[web-push] send failed (' + (res.status || res.error) + ')');
      }
    }
    if (gone) store.subs = store.subs.filter((s) => !s._gone);
    if (dirty) await persist().catch((e) => log('[web-push] could not persist: ' + e.message));
    return { ok: true, sent, gone, failed, targets: targets.length };
  }

  return {
    load, publicKey, subscribe, unsubscribe, dropDevice, list, hasSubscription, send,
    count: () => store.subs.length,
    hasKeys: () => !!store.keys,
  };
}

module.exports = {
  STORE_FILENAME, STORE_VERSION, MAX_SUBSCRIPTIONS, PAYLOAD_MAX_BYTES, DEFAULT_TTL, MAX_FAILURES,
  b64u, fromB64u, generateVapidKeys, rawPublicFromJwk,
  vapidAudience, buildJwt, encryptPayload,
  normalizeSubscription, normalizeStore, postToService, isGone,
  createWebPush,
};
