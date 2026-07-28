import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const wp = require('../web-push.js');

// ── An independent receiver ──────────────────────────────────────────────────
//
// This is the browser's half of RFC 8291, written from the spec's own receiver
// formulation rather than by inverting the sender above. It exists so the round
// trip below proves something: without it, "we can read what we wrote" would
// only say the code agrees with itself.
//
// It is also the readable statement of what the body has to be. If a change to
// web-push.js breaks the header layout, the record delimiter, or either HKDF
// stage, this fails to parse or fails to authenticate rather than producing
// something subtly wrong that a phone would silently drop.
function receiverDecrypt(body, uaPrivateEcdh, authSecret) {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);

  const shared = uaPrivateEcdh.computeSecret(asPublic);
  const uaPublic = uaPrivateEcdh.getPublicKey();
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic]);
  const ikm = crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12));

  const tag = ciphertext.subarray(ciphertext.length - 16);
  const data = ciphertext.subarray(0, ciphertext.length - 16);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(tag);
  const record = Buffer.concat([d.update(data), d.final()]);

  // Strip the padding delimiter. 0x02 means "last record"; anything else here
  // means the sender promised more and the browser would wait for it.
  let end = record.length - 1;
  while (end >= 0 && record[end] === 0x00) end--;
  assert.equal(record[end], 0x02, 'the record must end with the LAST-record delimiter');
  return { plaintext: record.subarray(0, end).toString('utf8'), rs, idlen, salt, asPublic };
}

function fakeBrowserSubscription() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    ecdh, auth,
    subscription: {
      endpoint: 'https://push.example.com/sub/' + crypto.randomBytes(8).toString('hex'),
      keys: { p256dh: wp.b64u(ecdh.getPublicKey()), auth: wp.b64u(auth) },
    },
  };
}

// ── The payload ──────────────────────────────────────────────────────────────

test('an encrypted payload is readable by the browser it was addressed to', () => {
  const ua = fakeBrowserSubscription();
  const text = 'Il timer "pasta" è finito.';
  const body = wp.encryptPayload({
    payload: text, p256dh: ua.subscription.keys.p256dh, auth: ua.subscription.keys.auth,
  });
  const got = receiverDecrypt(body, ua.ecdh, ua.auth);
  assert.equal(got.plaintext, text);
  // The header layout is part of the contract, not an implementation detail:
  // a browser parses these five fields before it can try any key at all.
  assert.equal(got.rs, 4096);
  assert.equal(got.idlen, 65);
  assert.equal(got.salt.length, 16);
  assert.equal(got.asPublic[0], 0x04, 'the ephemeral key must be an uncompressed point');
});

test('every message uses a new salt and a new ephemeral key', () => {
  // Reusing either would reuse the key AND the nonce across messages, which is
  // the one mistake AES-GCM does not survive.
  const ua = fakeBrowserSubscription();
  const a = wp.encryptPayload({ payload: 'x', p256dh: ua.subscription.keys.p256dh, auth: ua.subscription.keys.auth });
  const b = wp.encryptPayload({ payload: 'x', p256dh: ua.subscription.keys.p256dh, auth: ua.subscription.keys.auth });
  assert.notEqual(a.subarray(0, 16).toString('hex'), b.subarray(0, 16).toString('hex'), 'salt reused');
  assert.notEqual(a.subarray(21, 86).toString('hex'), b.subarray(21, 86).toString('hex'), 'ephemeral key reused');
});

test('a payload encrypted for one browser is unreadable by another', () => {
  const mine = fakeBrowserSubscription();
  const other = fakeBrowserSubscription();
  const body = wp.encryptPayload({ payload: 'secret', p256dh: mine.subscription.keys.p256dh, auth: mine.subscription.keys.auth });
  assert.throws(() => receiverDecrypt(body, other.ecdh, other.auth));
});

test('malformed subscription keys are refused, not coerced', () => {
  const ua = fakeBrowserSubscription();
  const good = ua.subscription.keys;
  assert.throws(() => wp.encryptPayload({ payload: 'x', p256dh: wp.b64u(Buffer.alloc(64)), auth: good.auth }), /bad_p256dh/);
  // A 65-byte blob that is not on the curve: computeSecret must reject it
  // rather than derive a key from a point an attacker chose.
  const offCurve = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 0x11)]);
  assert.throws(() => wp.encryptPayload({ payload: 'x', p256dh: wp.b64u(offCurve), auth: good.auth }));
  assert.throws(() => wp.encryptPayload({ payload: 'x', p256dh: good.p256dh, auth: wp.b64u(Buffer.alloc(8)) }), /bad_auth/);
  assert.throws(() => wp.encryptPayload({ payload: Buffer.alloc(wp.PAYLOAD_MAX_BYTES + 1), p256dh: good.p256dh, auth: good.auth }), /payload_too_large/);
});

// ── VAPID ────────────────────────────────────────────────────────────────────

test('the VAPID token verifies, and carries a raw r||s signature', () => {
  const keys = wp.generateVapidKeys();
  const jwt = wp.buildJwt({ audience: 'https://push.example.com', subject: 'mailto:a@b.c', jwk: keys.jwk, now: 1_700_000_000_000 });
  const [h, c, s] = jwt.split('.');
  assert.equal(JSON.parse(wp.fromB64u(h)).alg, 'ES256');
  const claims = JSON.parse(wp.fromB64u(c));
  assert.equal(claims.aud, 'https://push.example.com');
  assert.equal(claims.sub, 'mailto:a@b.c');
  assert.equal(claims.exp, 1_700_000_000 + 12 * 3600);

  // 64 bytes, not a DER structure. Node signs DER unless told otherwise, and a
  // DER signature here is the difference between working and a 401 from every
  // push service — a mistake no unit test catches unless it looks at the length.
  const sig = wp.fromB64u(s);
  assert.equal(sig.length, 64, 'ES256 must be raw r||s, not DER');

  const pub = crypto.createPublicKey({ key: { ...keys.jwk, d: undefined }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(h + '.' + c), { key: pub, dsaEncoding: 'ieee-p1363' }, sig));
});

test('the audience is the endpoint origin and nothing more', () => {
  assert.equal(wp.vapidAudience('https://fcm.googleapis.com/fcm/send/abc?x=1'), 'https://fcm.googleapis.com');
  assert.equal(wp.vapidAudience('https://web.push.apple.com/QRSTU/vwx'), 'https://web.push.apple.com');
  // The path is a bearer address. Putting it in a header a push service logs
  // would hand it to anyone reading those logs.
  assert.ok(!wp.vapidAudience('https://push.example.com/sub/secret').includes('secret'));
  assert.throws(() => wp.vapidAudience('http://push.example.com/x'), /insecure_endpoint/);
});

// ── Subscriptions ────────────────────────────────────────────────────────────

test('a subscription is validated the way a host is, not the way a setting is', () => {
  const ua = fakeBrowserSubscription();
  assert.ok(wp.normalizeSubscription(ua.subscription));
  const bad = (patch) => wp.normalizeSubscription({ ...ua.subscription, ...patch });
  assert.equal(bad({ endpoint: 'http://push.example.com/x' }), null, 'plain HTTP endpoint');
  assert.equal(bad({ endpoint: 'https://user:pw@push.example.com/x' }), null, 'credentials in the URL');
  assert.equal(bad({ endpoint: 'not a url' }), null);
  assert.equal(bad({ endpoint: 'https://p.example.com/' + 'a'.repeat(2000) }), null, 'unbounded endpoint');
  assert.equal(wp.normalizeSubscription({ ...ua.subscription, keys: { p256dh: 'zzz', auth: ua.subscription.keys.auth } }), null);
  assert.equal(wp.normalizeSubscription(null), null);
  assert.equal(wp.normalizeSubscription('https://push.example.com/x'), null);
});

test('the store survives a damaged file and refuses to grow without bound', () => {
  assert.deepEqual(wp.normalizeStore(null), { version: wp.STORE_VERSION, keys: null, subs: [] });
  assert.deepEqual(wp.normalizeStore({ subs: 'nope', keys: 5 }).subs, []);
  // A key blob that is not a P-256 private JWK is dropped rather than handed to
  // createPrivateKey later, where it would throw on a send instead of on load.
  assert.equal(wp.normalizeStore({ keys: { kty: 'RSA', crv: 'P-256', x: 'a', y: 'b', d: 'c' } }).keys, null);
  const one = fakeBrowserSubscription().subscription;
  const many = Array.from({ length: wp.MAX_SUBSCRIPTIONS + 20 }, (_, i) => ({
    ...one, endpoint: one.endpoint + i, deviceId: 'd' + i,
  }));
  assert.equal(wp.normalizeStore({ subs: many }).subs.length, wp.MAX_SUBSCRIPTIONS);
  // The same endpoint twice is one subscription, not two.
  assert.equal(wp.normalizeStore({ subs: [one, { ...one }] }).subs.length, 1);
});

test('subscribing twice from the same browser updates in place', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-push-'));
  try {
    const store = wp.createWebPush({ dir });
    const ua = fakeBrowserSubscription();
    assert.deepEqual(await store.subscribe(ua.subscription, { deviceId: 'dev1' }), { ok: true, count: 1 });
    assert.deepEqual(await store.subscribe(ua.subscription, { deviceId: 'dev1' }), { ok: true, count: 1 });
    assert.equal(store.count(), 1);
    assert.equal((await store.list())[0].host, 'push.example.com');
    // The list is what a browser is allowed to see: never the endpoint itself.
    assert.ok(!JSON.stringify(await store.list()).includes('/sub/'));
    assert.ok(!JSON.stringify(await store.list()).includes(ua.subscription.keys.auth));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('revoking a device takes its notifications with it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-push-'));
  try {
    const store = wp.createWebPush({ dir });
    await store.subscribe(fakeBrowserSubscription().subscription, { deviceId: 'phone' });
    await store.subscribe(fakeBrowserSubscription().subscription, { deviceId: 'tablet' });
    // A revoked phone cannot unsubscribe itself — its token is already dead —
    // so the revoke has to do it, or a device thrown off the dashboard keeps
    // being woken by it.
    assert.deepEqual(await store.dropDevice('phone'), { ok: true, removed: 1 });
    assert.equal(store.count(), 1);
    assert.deepEqual(await store.dropDevice(''), { ok: true, removed: 0 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the VAPID key pair is created once and never rotated behind the user', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-push-'));
  try {
    const a = wp.createWebPush({ dir });
    assert.equal(a.hasKeys(), false, 'no key on a plain install');
    const k1 = await a.publicKey();
    assert.equal(wp.fromB64u(k1).length, 65);
    assert.equal(await a.publicKey(), k1);
    // A second instance reading the same file must get the same key: rotating
    // it silently invalidates every subscription ever made.
    assert.equal(await wp.createWebPush({ dir }).publicKey(), k1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── Sending ──────────────────────────────────────────────────────────────────

/** A stub of https.request that records the call and answers with `status`. */
function fakeRequest(status, seen) {
  return (opts, cb) => {
    const chunks = [];
    return {
      setTimeout() {}, on() {},
      end(body) {
        if (body) chunks.push(body);
        seen.push({ opts, body: Buffer.concat(chunks) });
        const res = { statusCode: status, resume() {}, on(ev, fn) { if (ev === 'end') setImmediate(fn); } };
        setImmediate(() => cb(res));
      },
    };
  };
}

test('a send carries the headers a push service requires', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-push-'));
  try {
    const store = wp.createWebPush({ dir });
    const ua = fakeBrowserSubscription();
    await store.publicKey();
    await store.subscribe(ua.subscription, { deviceId: 'phone' });
    const seen = [];
    const res = await store.send({ title: 'Timer', body: 'finito', url: '/' }, { request: fakeRequest(201, seen) });
    assert.deepEqual({ ok: res.ok, sent: res.sent, failed: res.failed }, { ok: true, sent: 1, failed: 0 });
    assert.equal(seen.length, 1);
    const h = seen[0].opts.headers;
    assert.equal(h['Content-Encoding'], 'aes128gcm');
    assert.equal(h['Content-Type'], 'application/octet-stream');
    assert.match(h.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    assert.equal(seen[0].opts.method, 'POST');
    // The SSRF guard is not optional here: the endpoint is a URL a client chose.
    assert.equal(typeof seen[0].opts.lookup, 'function');
    // And the message really is inside, encrypted.
    const got = receiverDecrypt(seen[0].body, ua.ecdh, ua.auth);
    assert.deepEqual(JSON.parse(got.plaintext), { title: 'Timer', body: 'finito', tag: 'xenon', url: '/' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('410 deletes the subscription, a network error only counts against it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-push-'));
  try {
    const store = wp.createWebPush({ dir });
    await store.publicKey();
    await store.subscribe(fakeBrowserSubscription().subscription, { deviceId: 'phone' });
    // 410 Gone is the service saying this install does not exist any more.
    // Deleting is right; anything else keeps waking a phone that was wiped.
    const res = await store.send({ title: 'x' }, { request: fakeRequest(410, []) });
    assert.deepEqual({ gone: res.gone, sent: res.sent }, { gone: 1, sent: 0 });
    assert.equal(store.count(), 0);

    // A 500 is the service having a bad day, or a phone that is off. The
    // subscription stays: the user did not unsubscribe.
    await store.subscribe(fakeBrowserSubscription().subscription, { deviceId: 'phone' });
    for (let i = 0; i < wp.MAX_FAILURES; i++) await store.send({ title: 'x' }, { request: fakeRequest(500, []) });
    assert.equal(store.count(), 1, 'a failing subscription is parked, never deleted');
    const after = await store.send({ title: 'x' }, { request: fakeRequest(201, []) });
    assert.equal(after.targets, 0, 'and it stops being retried once parked');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('sending with no keys and no subscriptions is a no-op, not a throw', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-push-'));
  try {
    const store = wp.createWebPush({ dir });
    assert.deepEqual(await store.send({ title: 'x' }), { ok: false, error: 'no_keys', sent: 0 });
    await store.publicKey();
    assert.deepEqual(await store.send({ title: 'x' }), { ok: true, sent: 0, targets: 0 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a plain-HTTP endpoint never reaches the network', async () => {
  let called = false;
  const res = await wp.postToService({
    endpoint: 'http://push.example.com/x', body: Buffer.alloc(1), jwt: 'a.b.c', vapidPublicKey: 'k',
    request: () => { called = true; return { setTimeout() {}, on() {}, end() {} }; },
  });
  assert.deepEqual(res, { ok: false, status: 0, error: 'insecure_endpoint' });
  assert.equal(called, false);
});

test('404 and 410 mean gone; nothing else does', () => {
  assert.equal(wp.isGone(404), true);
  assert.equal(wp.isGone(410), true);
  for (const s of [200, 201, 400, 401, 403, 429, 500, 503, 0]) assert.equal(wp.isGone(s), false);
});
