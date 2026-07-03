import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { preserveStreamCreds, redactStreamCreds } = require('../stream-creds.js');

// ── preserveStreamCreds: a client save must never wipe the server-only creds ──
test('preserveStreamCreds carries both passwords over when the client omits them', () => {
  const prev = { obsPassword: 'OBS_SECRET', streamerbotPassword: 'SB_SECRET' };
  const incoming = { accent: '#fff' }; // typical client save: no passwords at all
  preserveStreamCreds(incoming, prev);
  assert.equal(incoming.obsPassword, 'OBS_SECRET');
  assert.equal(incoming.streamerbotPassword, 'SB_SECRET');
});

test('preserveStreamCreds refills empty passwords, keeping other fields', () => {
  const prev = { obsPassword: 'OBS_SECRET', streamerbotPassword: 'SB_SECRET' };
  const incoming = { obsHost: '127.0.0.1', obsPassword: '', streamerbotPassword: '' };
  preserveStreamCreds(incoming, prev);
  assert.equal(incoming.obsPassword, 'OBS_SECRET');
  assert.equal(incoming.streamerbotPassword, 'SB_SECRET');
  assert.equal(incoming.obsHost, '127.0.0.1');
});

test('preserveStreamCreds does not override a password the client explicitly provides', () => {
  const prev = { obsPassword: 'OLD', streamerbotPassword: 'OLD_SB' };
  const incoming = { obsPassword: 'NEW', streamerbotPassword: 'NEW_SB' };
  preserveStreamCreds(incoming, prev);
  assert.equal(incoming.obsPassword, 'NEW');
  assert.equal(incoming.streamerbotPassword, 'NEW_SB');
});

test('preserveStreamCreds fills each field independently', () => {
  const prev = { obsPassword: 'OBS_SECRET', streamerbotPassword: 'SB_SECRET' };
  const incoming = { obsPassword: 'NEW', streamerbotPassword: '' };
  preserveStreamCreds(incoming, prev);
  assert.equal(incoming.obsPassword, 'NEW', 'a provided password is kept');
  assert.equal(incoming.streamerbotPassword, 'SB_SECRET', 'an empty one is refilled');
});

test('preserveStreamCreds is a no-op with no persisted creds or a null prev', () => {
  const incoming = { obsHost: '127.0.0.1' };
  preserveStreamCreds(incoming, { obsPassword: '', streamerbotPassword: '' });
  assert.equal(incoming.obsPassword, undefined);
  preserveStreamCreds(incoming, null);
  assert.equal(incoming.obsHost, '127.0.0.1');
});

// ── redactStreamCreds: secrets never go to the browser, but a "set" flag does ──
test('redactStreamCreds blanks the passwords and surfaces the *Set flags', () => {
  const settings = { accent: '#fff', obsPassword: 'OBS_SECRET', streamerbotPassword: 'SB_SECRET' };
  const out = redactStreamCreds(settings);
  assert.equal(out.obsPassword, '');
  assert.equal(out.streamerbotPassword, '');
  assert.equal(out.obsPasswordSet, true);
  assert.equal(out.streamerbotPasswordSet, true);
  assert.equal(out.accent, '#fff', 'non-secret fields survive');
});

test('redactStreamCreds reports false when a password is unset', () => {
  const out = redactStreamCreds({ obsPassword: '', streamerbotPassword: '' });
  assert.equal(out.obsPasswordSet, false);
  assert.equal(out.streamerbotPasswordSet, false);
});

test('redactStreamCreds does not mutate the source', () => {
  const settings = { obsPassword: 'OBS_SECRET', streamerbotPassword: 'SB_SECRET' };
  redactStreamCreds(settings);
  assert.equal(settings.obsPassword, 'OBS_SECRET', 'source keeps the real value');
  assert.equal(settings.streamerbotPassword, 'SB_SECRET');
});

test('redactStreamCreds tolerates null/non-object input', () => {
  assert.equal(redactStreamCreds(null), null);
  assert.equal(redactStreamCreds(undefined), undefined);
});

// ── the two halves together: redact-on-wire then preserve-on-save round-trips ──
test('redact then preserve keeps the real password across a client save', () => {
  const stored = { obsPassword: 'OBS_SECRET', streamerbotPassword: 'SB_SECRET' };
  // what the browser receives (secrets blanked)
  const onWire = redactStreamCreds(stored);
  assert.equal(onWire.obsPassword, '');
  // the browser saves those blanked values back unchanged
  const incoming = { obsPassword: onWire.obsPassword, streamerbotPassword: onWire.streamerbotPassword };
  preserveStreamCreds(incoming, stored);
  assert.equal(incoming.obsPassword, 'OBS_SECRET', 'the blank save did not wipe the secret');
  assert.equal(incoming.streamerbotPassword, 'SB_SECRET');
});
