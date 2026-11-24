// The SimplySign login on a hosted runner computes its own one-time codes
// (tools/simplysign/otp.mjs). A wrong code costs a time window and, three in a
// row, the release: these pin the RFC 6238 maths and the QR parsing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { base32Decode, MIN_LEFT, nextWindow, parseOtpauthUri, totp } from '../../tools/simplysign/otp.mjs';

const CLI = fileURLToPath(new URL('../../tools/simplysign/otp.mjs', import.meta.url));
// RFC 6238 appendix B seeds, Base32 of the ASCII strings.
const SEED_SHA1 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

test('base32 decodes the RFC 6238 seed, ignoring case, spaces and padding', () => {
  assert.equal(base32Decode(SEED_SHA1).toString('ascii'), '12345678901234567890');
  assert.equal(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq====').toString('ascii'), '12345678901234567890');
  assert.throws(() => base32Decode('GEZ1'), /not valid Base32/);
  assert.throws(() => base32Decode(''), /empty/);
});

test('totp matches the RFC 6238 test vectors', () => {
  const sha1 = Buffer.from('12345678901234567890', 'ascii');
  const sha256 = Buffer.from('12345678901234567890123456789012', 'ascii');
  const sha512 = Buffer.from('1234567890123456789012345678901234567890123456789012345678901234', 'ascii');
  const vectors = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1234567890, '89005924', '91819424', '93441116'],
    [20000000000, '65353130', '77737706', '47863826'],
  ];
  for (const [time, s1, s256, s512] of vectors) {
    const counter = Math.floor(time / 30);
    assert.equal(totp({ key: sha1, counter, algorithm: 'SHA1', digits: 8 }), s1, `SHA1 @${time}`);
    assert.equal(totp({ key: sha256, counter, algorithm: 'SHA256', digits: 8 }), s256, `SHA256 @${time}`);
    assert.equal(totp({ key: sha512, counter, algorithm: 'SHA512', digits: 8 }), s512, `SHA512 @${time}`);
  }
  assert.equal(totp({ key: sha1, counter: 1 }), '287082', 'six digits keep the low digits');
});

test('the activation URI gives the login and SimplySign defaults', () => {
  const otp = parseOtpauthUri(`otpauth://totp/Certum:dev%40example.com?secret=${SEED_SHA1}&issuer=Certum`);
  assert.deepEqual(otp, { login: 'dev@example.com', secret: SEED_SHA1, algorithm: 'SHA1', digits: 6, period: 30 });
  const custom = parseOtpauthUri(`otpauth://totp/dev@example.com?secret=${SEED_SHA1}&algorithm=SHA-256&digits=8&period=60`);
  assert.equal(custom.login, 'dev@example.com');
  assert.equal(custom.algorithm, 'SHA256');
  assert.equal(custom.digits, 8);
  assert.equal(custom.period, 60);
});

test('a damaged URI is refused before any login, without echoing it', () => {
  const secretish = 'ABCDEFGH1';
  for (const bad of ['', 'not a uri', `https://totp/x?secret=${SEED_SHA1}`, 'otpauth://hotp/x?secret=GEZD',
    'otpauth://totp/x', `otpauth://totp/x?secret=${secretish}`, `otpauth://totp/x?secret=${SEED_SHA1}&algorithm=MD5`,
    `otpauth://totp/x?secret=${SEED_SHA1}&digits=4`]) {
    assert.throws(() => parseOtpauthUri(bad), (err) => !err.message.includes(secretish) && !err.message.includes(SEED_SHA1), bad);
  }
});

test('nextWindow never reuses a tried window and keeps enough time to log in', () => {
  assert.deepEqual(nextWindow(600, 30), { counter: 20, waitSeconds: 0 }, 'fresh window, 30 s left');
  assert.deepEqual(nextWindow(600 + 30 - MIN_LEFT, 30), { counter: 20, waitSeconds: 0 }, 'exactly the minimum left');
  assert.deepEqual(nextWindow(600 + 30 - MIN_LEFT + 1, 30), { counter: 21, waitSeconds: MIN_LEFT - 1 }, 'too little left: wait');
  assert.deepEqual(nextWindow(605, 30, 20), { counter: 21, waitSeconds: 25 }, 'already tried: next one');
  assert.deepEqual(nextWindow(605, 30, 22), { counter: 23, waitSeconds: 85 }, 'never behind the last try');
});

test('the CLI prints one JSON line and keeps the secret out of errors', () => {
  const env = { ...process.env, CERTUM_OTPAUTH_URI: `otpauth://totp/Certum:dev%40example.com?secret=${SEED_SHA1}`, CERTUM_USERNAME: '' };
  // No --after: the current window is used unless it has under MIN_LEFT seconds
  // left, so the run waits at most that long.
  const ok = spawnSync(process.execPath, [CLI, 'next'], { env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(ok.status, 0, ok.stderr);
  const out = JSON.parse(ok.stdout);
  assert.equal(out.login, 'dev@example.com');
  assert.match(out.code, /^\d{6}$/);
  assert.equal(out.code, totp({ key: base32Decode(SEED_SHA1), counter: out.counter }));

  const override = spawnSync(process.execPath, [CLI, 'next'], { env: { ...env, CERTUM_USERNAME: 'other@example.com' }, encoding: 'utf8', timeout: 30_000 });
  assert.equal(JSON.parse(override.stdout).login, 'other@example.com');

  const bad = spawnSync(process.execPath, [CLI, 'next'], { env: { ...env, CERTUM_OTPAUTH_URI: 'otpauth://totp/x?secret=ZZZZ1' }, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, '');
  assert.ok(!bad.stderr.includes('ZZZZ1'), 'the secret never reaches stderr');
});
