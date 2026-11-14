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

const path = require('node:path');
const fs = require('node:fs');
const { writeFileAtomic } = require('./atomic-write.js');
// A subscription endpoint is a URL a client chose. It must name the public
// internet: a paired phone could otherwise subscribe https://127.0.0.1:<port>/
// or a LAN address and turn every notification into a blind POST there.
require('./net-guard.js');

const STORE_FILENAME = 'web-push.json';

const {
  PAYLOAD_MAX_BYTES, b64u, fromB64u, generateVapidKeys, rawPublicFromJwk, vapidAudience, buildJwt,
  encryptPayload,
} = require('./paired/push-crypto.js');
const {
  STORE_VERSION, MAX_SUBSCRIPTIONS, normalizeSubscription, normalizeStore,
} = require('./paired/push-subscriptions.js');

const { DEFAULT_TTL, postToService, isGone } = require('./paired/push-send.js');
// A subscription that keeps failing without ever saying "gone" (a service that
// is down, a phone that is off) must not be retried forever, and must not be
// deleted either — the user did not unsubscribe. Park it after this many.
const MAX_FAILURES = 10;

// ── Encoding ─────────────────────────────────────────────────────────────────

// ── Keys ─────────────────────────────────────────────────────────────────────

// ── RFC 8292: the VAPID token ────────────────────────────────────────────────

// ── RFC 8291: the encrypted payload ──────────────────────────────────────────

// ── Subscriptions ────────────────────────────────────────────────────────────

// ── The transport ────────────────────────────────────────────────────────────

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
