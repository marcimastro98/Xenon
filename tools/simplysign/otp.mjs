// SimplySign one-time codes for signing on a hosted runner.
//
// The Windows release is signed with a Certum cloud certificate. The key never
// leaves Certum's HSM; SimplySign Desktop opens a session to it after a login
// with the account and a 6-digit code. On the maintainer's PC that code comes
// from the phone app; on a GitHub-hosted runner it is computed here from the
// otpauth:// URI of the SimplySign activation QR, stored as the environment
// secret CERTUM_OTPAUTH_URI. tools/simplysign/session.ps1 calls this file.
//
// CLI (for session.ps1): node tools/simplysign/otp.mjs next [--after <counter>]
// Reads CERTUM_OTPAUTH_URI (and the optional CERTUM_USERNAME override), waits
// until a time window newer than <counter> has at least MIN_LEFT seconds left,
// and prints one JSON line {login, code, counter}. Nothing else is printed:
// the caller masks every value before the log can show it.

import { createHmac } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const ALGORITHMS = new Map([['SHA1', 'sha1'], ['SHA256', 'sha256'], ['SHA512', 'sha512']]);
// Certum refuses a code from a window whose code was already tried, and a login
// takes a few seconds: start only with this much of the window left.
export const MIN_LEFT = 15;

/** @param {string} text Base32, case and padding ignored. */
export function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[\s=]/g, '');
  if (!clean) throw new Error('the TOTP secret is empty');
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = BASE32.indexOf(char);
    if (value < 0) throw new Error('the TOTP secret is not valid Base32');
    buffer = ((buffer << 5) | value) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

/**
 * The SimplySign activation QR holds otpauth://totp/Certum:<login>?secret=...
 * Defaults follow RFC 6238 and SimplySign Desktop's own reader: SHA1, 6 digits,
 * 30 seconds, unless the query says otherwise.
 * @param {string} text
 * @returns {{login: string, secret: string, algorithm: string, digits: number, period: number}}
 */
export function parseOtpauthUri(text) {
  let uri;
  try {
    uri = new URL(String(text).trim());
  } catch {
    throw new Error('CERTUM_OTPAUTH_URI is not a URI: paste the otpauth://totp/... text of the SimplySign QR');
  }
  if (uri.protocol !== 'otpauth:' || uri.hostname !== 'totp') {
    throw new Error('CERTUM_OTPAUTH_URI must start with otpauth://totp/');
  }
  const secret = uri.searchParams.get('secret') || '';
  base32Decode(secret); // throws on a damaged secret, before any login attempt
  const label = decodeURIComponent(uri.pathname.replace(/^\//, ''));
  const login = label.includes(':') ? label.slice(label.indexOf(':') + 1).trim() : label.trim();
  const algorithm = (uri.searchParams.get('algorithm') || 'SHA1').toUpperCase().replace('-', '');
  if (!ALGORITHMS.has(algorithm)) throw new Error(`unsupported TOTP algorithm ${algorithm}`);
  const digits = Number(uri.searchParams.get('digits') || 6);
  const period = Number(uri.searchParams.get('period') || 30);
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) throw new Error('TOTP digits must be 6 to 8');
  if (!Number.isInteger(period) || period < 15 || period > 120) throw new Error('TOTP period must be 15 to 120 seconds');
  return { login, secret, algorithm, digits, period };
}

/**
 * RFC 6238 code for one time window.
 * @param {{key: Buffer, counter: number, algorithm?: string, digits?: number}} opts
 */
export function totp({ key, counter, algorithm = 'SHA1', digits = 6 }) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hash = createHmac(ALGORITHMS.get(algorithm) || 'sha1', key).update(message).digest();
  const offset = hash[hash.length - 1] & 0x0f;
  const binary = ((hash[offset] & 0x7f) << 24) | (hash[offset + 1] << 16) | (hash[offset + 2] << 8) | hash[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * The first window after `after` with at least MIN_LEFT seconds to go, and how
 * long to wait for it.
 * @param {number} nowSeconds
 * @param {number} period
 * @param {number} after the last counter already tried, -1 for none
 */
export function nextWindow(nowSeconds, period, after = -1) {
  let start = Math.floor(nowSeconds / period) * period;
  while (start / period <= after || start + period - Math.max(nowSeconds, start) < MIN_LEFT) start += period;
  return { counter: start / period, waitSeconds: Math.max(0, start - nowSeconds) };
}

async function main(argv) {
  if (argv[0] !== 'next') throw new Error('usage: otp.mjs next [--after <counter>]');
  const afterAt = argv.indexOf('--after');
  const after = afterAt >= 0 ? Number(argv[afterAt + 1]) : -1;
  if (!Number.isInteger(after)) throw new Error('--after needs a counter');
  const otp = parseOtpauthUri(process.env.CERTUM_OTPAUTH_URI || '');
  const login = (process.env.CERTUM_USERNAME || '').trim() || otp.login;
  if (!login) throw new Error('no SimplySign login: the URI has no Certum:<login> label and CERTUM_USERNAME is empty');
  const { counter, waitSeconds } = nextWindow(Date.now() / 1000, otp.period, after);
  if (waitSeconds > 0) await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
  const code = totp({ key: base32Decode(otp.secret), counter, algorithm: otp.algorithm, digits: otp.digits });
  process.stdout.write(`${JSON.stringify({ login, code, counter })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    // The message never carries the secret: every throw above names the problem only.
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  });
}
