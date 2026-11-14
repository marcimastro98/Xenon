'use strict';
// The secrets of a paired device: its token and how it is hashed and compared, the pairing code
// a person types, and the cookie that carries the token.

const crypto = require('node:crypto');

const COOKIE_NAME = 'xenon_device';

const TOKEN_BYTES = 32;
const CODE_LENGTH = 8;

// Unambiguous alphabet: no 0/O, no 1/I/L. The code is scanned from a QR in the
// normal case but has to survive being read aloud or typed in the bad one.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function newToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

// Hex, not base64url: this one travels as a PATH SEGMENT, and hex is the only
// alphabet that needs no escaping and cannot collide with a separator.
function newAssetKey() {
  return crypto.randomBytes(16).toString('hex');
}

function newCode() {
  let out = '';
  // rejection-free: 31 symbols read from a 256-value byte would bias, so draw
  // one byte per symbol and redraw the tail above the largest exact multiple.
  const limit = Math.floor(256 / CODE_ALPHABET.length) * CODE_ALPHABET.length;
  while (out.length < CODE_LENGTH) {
    for (const b of crypto.randomBytes(CODE_LENGTH)) {
      if (b >= limit) continue;
      out += CODE_ALPHABET[b % CODE_ALPHABET.length];
      if (out.length === CODE_LENGTH) break;
    }
  }
  return out;
}

/** Strip formatting and fold case so "abcd-efgh" redeems the code ABCDEFGH. */
function canonicalCode(input) {
  return String(input || '').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, CODE_LENGTH);
}

/** Display form: XXXX-XXXX, readable aloud. */
function formatCode(code) {
  const c = canonicalCode(code);
  return c.length === CODE_LENGTH ? c.slice(0, 4) + '-' + c.slice(4) : c;
}

/** Constant-time string compare that does not leak length through timing. */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length) {
    // Still burn a comparison so a wrong LENGTH costs the same as a wrong value.
    try { crypto.timingSafeEqual(ba, ba); } catch { /* ignore */ }
    return false;
  }
  try { return crypto.timingSafeEqual(ba, bb); } catch { return false; }
}

/** Read our cookie out of a Cookie header without a parser dependency. */
function readCookie(header, name) {
  const raw = String(header || '');
  if (!raw) return '';
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return '';
}

/**
 * Set-Cookie for a device token.
 *
 * `Secure` follows the LISTENER the pairing happened on, and it has to: on T1
 * (plain HTTP on the LAN) a Secure cookie is never stored by the browser at all,
 * which reads to the user as "pairing silently did nothing". On T2 (the HTTPS
 * door) it is correct and free. Note the two doors have different hosts — an IP
 * literal vs the MagicDNS name — and cookies are scoped per host, so a device
 * paired on one is not paired on the other. That is why the pairing QR points at
 * the HTTPS address whenever it exists: that one address works both at home and
 * away, so nobody has to pair the same phone twice.
 */
function cookieHeader(token, { maxAgeSec = 365 * 24 * 3600, secure = false } = {}) {
  const value = token ? String(token) : '';
  const age = token ? maxAgeSec : 0;
  return COOKIE_NAME + '=' + value + '; Path=/; Max-Age=' + age
    + '; HttpOnly; SameSite=Strict' + (secure ? '; Secure' : '');
}

module.exports = {
  COOKIE_NAME, TOKEN_BYTES, CODE_LENGTH, CODE_ALPHABET, hashToken, newToken, newAssetKey, newCode,
  canonicalCode, formatCode, safeEqual, readCookie, cookieHeader,
};
