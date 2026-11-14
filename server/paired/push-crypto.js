'use strict';
// The cryptography of Web Push: the VAPID keys and the signed token (RFC 8292), and the
// encrypted payload (RFC 8291).

const crypto = require('node:crypto');

const PAYLOAD_MAX_BYTES = 3000;      // under every service's 4KB record limit
const RECORD_SIZE = 4096;

const JWT_TTL_SEC = 12 * 3600;       // RFC 8292 caps this at 24h; half is plenty

const b64u = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function fromB64u(s) {
  const t = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(t + '='.repeat((4 - (t.length % 4)) % 4), 'base64');
}

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

module.exports = {
  PAYLOAD_MAX_BYTES, RECORD_SIZE, JWT_TTL_SEC, b64u, fromB64u, generateVapidKeys, rawPublicFromJwk,
  vapidAudience, buildJwt, encryptPayload,
};
