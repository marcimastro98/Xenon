import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { normalizeRemoteControl, preserveRemoteCreds, redactRemoteCreds } = require('../remote-control/settings.js');

test('defaults to disabled with complete shape', () => {
  const r = normalizeRemoteControl(undefined);
  assert.equal(r.enabled, false);
  assert.equal(r.sunshineInstalled, false);
  assert.equal(r.tailscaleInstalled, false);
  assert.deepEqual(r.selectedMonitors, []);
  assert.equal(r.sunshineUser, '');
});

test('preserves valid values and strips unknown keys', () => {
  const r = normalizeRemoteControl({ enabled: true, sunshineUser: 'admin', junk: 1 });
  assert.equal(r.enabled, true);
  assert.equal(r.sunshineUser, 'admin');
  assert.equal('junk' in r, false);
  assert.deepEqual(normalizeRemoteControl({ selectedMonitors: [0, 2] }).selectedMonitors, [0, 2]);
});

test('coerces wrong types to safe defaults', () => {
  const r = normalizeRemoteControl({ enabled: 'yes', selectedMonitors: 'x' });
  assert.equal(r.enabled, false);
  assert.deepEqual(r.selectedMonitors, []);
});

test('preserves sunshinePass as secret string', () => {
  assert.equal(normalizeRemoteControl({ sunshinePass: 'abc' }).sunshinePass, 'abc');
  assert.equal(normalizeRemoteControl(undefined).sunshinePass, '');
});

test('drops out-of-range and non-integer monitor indices', () => {
  assert.deepEqual(normalizeRemoteControl({ selectedMonitors: [-1, 2.5, 3, 99] }).selectedMonitors, [3]);
});

test('clamps sunshineUser to 120 characters', () => {
  assert.equal(normalizeRemoteControl({ sunshineUser: 'a'.repeat(200) }).sunshineUser.length, 120);
});

test('normalizza selectedScreen come stringa (default vuota)', () => {
  assert.equal(normalizeRemoteControl(undefined).selectedScreen, '');
  assert.equal(normalizeRemoteControl({ selectedScreen: 'DISPLAY1' }).selectedScreen, 'DISPLAY1');
  assert.equal(normalizeRemoteControl({ selectedScreen: 123 }).selectedScreen, '');
});

// ── preserveRemoteCreds: a client save must never wipe the server-only creds ──
test('preserveRemoteCreds carries creds over when the client payload omits remoteControl', () => {
  const prev = { remoteControl: { sunshineUser: 'xenonedge', sunshinePass: 'SECRET' } };
  const incoming = { accent: '#fff' }; // no remoteControl at all (typical client save)
  preserveRemoteCreds(incoming, prev);
  assert.equal(incoming.remoteControl.sunshineUser, 'xenonedge');
  assert.equal(incoming.remoteControl.sunshinePass, 'SECRET');
});

test('preserveRemoteCreds fills only empty creds, keeping other remoteControl fields', () => {
  const prev = { remoteControl: { sunshineUser: 'xenonedge', sunshinePass: 'SECRET' } };
  const incoming = { remoteControl: { enabled: true, sunshineUser: '', sunshinePass: '', selectedScreen: 'DISPLAY2' } };
  preserveRemoteCreds(incoming, prev);
  assert.equal(incoming.remoteControl.sunshineUser, 'xenonedge');
  assert.equal(incoming.remoteControl.sunshinePass, 'SECRET');
  assert.equal(incoming.remoteControl.enabled, true);
  assert.equal(incoming.remoteControl.selectedScreen, 'DISPLAY2');
});

test('preserveRemoteCreds does not override creds the client explicitly provides', () => {
  const prev = { remoteControl: { sunshineUser: 'old', sunshinePass: 'OLD' } };
  const incoming = { remoteControl: { sunshineUser: 'new', sunshinePass: 'NEW' } };
  preserveRemoteCreds(incoming, prev);
  assert.equal(incoming.remoteControl.sunshineUser, 'new');
  assert.equal(incoming.remoteControl.sunshinePass, 'NEW');
});

test('preserveRemoteCreds is a no-op when there are no persisted creds', () => {
  const incoming = { remoteControl: { enabled: true } };
  preserveRemoteCreds(incoming, { remoteControl: {} });
  assert.equal(incoming.remoteControl.sunshineUser, undefined);
  preserveRemoteCreds(incoming, null);
  assert.equal(incoming.remoteControl.enabled, true);
});

// ── redactRemoteCreds: secrets never go to the browser ──
test('redactRemoteCreds blanks the creds without mutating the source', () => {
  const settings = { accent: '#fff', remoteControl: { enabled: true, sunshineUser: 'xenonedge', sunshinePass: 'SECRET', selectedScreen: 'D1' } };
  const out = redactRemoteCreds(settings);
  assert.equal(out.remoteControl.sunshineUser, '');
  assert.equal(out.remoteControl.sunshinePass, '');
  assert.equal(out.remoteControl.enabled, true, 'non-secret fields survive');
  assert.equal(out.remoteControl.selectedScreen, 'D1');
  assert.equal(settings.remoteControl.sunshinePass, 'SECRET', 'source is not mutated');
});

test('redactRemoteCreds tolerates null/missing remoteControl', () => {
  assert.equal(redactRemoteCreds(null), null);
  assert.deepEqual(redactRemoteCreds({ accent: '#fff' }), { accent: '#fff' });
});
