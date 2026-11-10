// AirPods and Beats. The adverts are real ones, heard from a pair on 4 Nov 2026: in the case
// (both buds 100, case 70) and in use (one bud reporting, case not known).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decodeAdvert, devicesFrom } = require('../device-battery/apple-adverts.js');
const { readApple } = require('../device-battery/apple-windows.js');
const { parseProfiler } = require('../device-battery/darwin.js');
const { createGuard } = require('../device-battery/guard.js');

const IN_CASE = '071901242073aa973100041d9299b071a97c0ba703f2df820b9e4d';
const IN_USE = '071901242002fa8f110004fe18841589843a786570417f4ef5221f';

test('in the case: both buds, the case, and which ones charge', () => {
  assert.deepEqual(decodeAdvert(IN_CASE), { buds: [100, 100], case: 70, budsCharging: true, caseCharging: false });
});

test('in use: only what is known, and 15 is not a level', () => {
  assert.deepEqual(decodeAdvert(IN_USE), { buds: [100], case: null, budsCharging: false, caseCharging: false });
});

test('another Apple message, or too short, is no reading', () => {
  assert.equal(decodeAdvert('1005'), null);
  assert.equal(decodeAdvert('1219012420aa97310004'), null);
  assert.equal(decodeAdvert(''), null);
});

test('the connected pair takes the name, the lower bud and a row for the case', () => {
  const low = '0719012420738a973100';
  assert.deepEqual(devicesFrom({ connected: ['AirPods Pro'], adverts: [{ rssi: -50, hex: low }] }), [
    { name: 'AirPods Pro', percent: 80, charging: true, source: 'bluetooth' },
    { name: 'AirPods Pro case', percent: 70, charging: false, source: 'bluetooth' },
  ]);
});

test('nothing connected here means nothing is shown, whatever is in the air', () => {
  assert.deepEqual(devicesFrom({ connected: [], adverts: [{ rssi: -40, hex: IN_CASE }] }), []);
});

test('the strongest signal wins, and a far one is nobody here', () => {
  const adverts = [{ rssi: -70, hex: IN_USE }, { rssi: -45, hex: IN_CASE }];
  assert.equal(devicesFrom({ connected: ['AirPods Pro'], adverts }).length, 2);
  assert.deepEqual(devicesFrom({ connected: ['AirPods Pro'], adverts: [{ rssi: -90, hex: IN_CASE }] }), []);
});

test('no helper, an old helper or bad output is no reading, and the guard is left', async () => {
  const guard = createGuard();
  assert.deepEqual(await readApple(guard, async () => { throw new Error('unknown mode'); }), []);
  assert.deepEqual(await readApple(guard, async () => 'not json'), []);
  const ok = JSON.stringify({ connected: ['AirPods Pro'], adverts: [{ rssi: -50, hex: IN_USE }] });
  assert.equal((await readApple(guard, async () => ok))[0].percent, 100);
});

test('macOS: one-piece headphones under Main, and a 0 or a stray value is no level', () => {
  const text = JSON.stringify({ SPBluetoothDataType: [{ device_connected: [
    { 'AirPods Max': { device_batteryLevelMain: '85%' } },
    { 'MX Master 3S': { device_batteryLevelMain: '0%' } },
    { Buds: { device_batteryLevelLeft: ' 40 % ', device_batteryLevelRight: 'n/a', device_batteryLevelCase: 72 } },
    { Odd: { device_batteryLevelMain: '140%' } },
  ] }] });
  assert.deepEqual(parseProfiler(text), [
    { name: 'AirPods Max', percent: 85, charging: null, source: 'bluetooth' },
    { name: 'Buds', percent: 40, charging: null, source: 'bluetooth' },
    { name: 'Buds case', percent: 72, charging: null, source: 'bluetooth' },
  ]);
});

test('macOS: each bud and the case from system_profiler, connected devices only', () => {
  const text = JSON.stringify({ SPBluetoothDataType: [{
    device_connected: [{ 'AirPods Pro': { device_batteryLevelLeft: '90%', device_batteryLevelRight: '100%', device_batteryLevelCase: '70%' } }, { 'Magic Mouse': { device_address: 'x' } }],
    device_not_connected: [{ 'Old AirPods': { device_batteryLevelLeft: '10%' } }],
  }] });
  assert.deepEqual(parseProfiler(text), [
    { name: 'AirPods Pro', percent: 90, charging: null, source: 'bluetooth' },
    { name: 'AirPods Pro case', percent: 70, charging: null, source: 'bluetooth' },
  ]);
});
