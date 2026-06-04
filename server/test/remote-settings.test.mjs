import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { normalizeRemoteControl } = require('../remote-control/settings.js');

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
