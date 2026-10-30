import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../power/parse.js');

test('windowsStatus: desktop without a battery', () => {
  assert.deepEqual(P.windowsStatus({ ac: 1, flag: 128, pct: 255, sys: 0, life: 0xFFFFFFFF }), { battery: null, saver: false });
  assert.deepEqual(P.windowsStatus({ ac: 255, flag: 255, pct: 255, sys: 0 }), { battery: null, saver: false });
  assert.deepEqual(P.windowsStatus(null), { battery: null, saver: false });
});

test('windowsStatus: laptop on battery and charging', () => {
  assert.deepEqual(P.windowsStatus({ ac: 0, flag: 1, pct: 82, sys: 1, life: 3 * 3600 + 30 * 60 }),
    { battery: { percent: 82, plugged: false, charging: false, minutesLeft: 210 }, saver: true });
  assert.deepEqual(P.windowsStatus({ ac: 1, flag: 8 | 1, pct: 40, sys: 0, life: 0xFFFFFFFF }),
    { battery: { percent: 40, plugged: true, charging: true, minutesLeft: null }, saver: false });
  // Unknown time left on battery.
  assert.equal(P.windowsStatus({ ac: 0, flag: 2, pct: 30, sys: 0, life: 0xFFFFFFFF }).battery.minutesLeft, null);
});

test('windowsMode: only the Balanced plan has a mode', () => {
  const bal = P.WIN_BALANCED_PLAN;
  assert.deepEqual(P.windowsMode(bal, '961CC777-2547-4F9D-8174-7D86181B8A7A'), { mode: 'saver' });
  assert.deepEqual(P.windowsMode(bal, '00000000-0000-0000-0000-000000000000'), { mode: 'balanced' });
  assert.deepEqual(P.windowsMode(bal, '3af9b8d9-7c97-431d-ad78-34a8bfea439f'), { mode: 'balanced' });
  assert.deepEqual(P.windowsMode(bal, 'ded574b5-45a0-4f42-8737-46345c09c238'), { mode: 'performance' });
  assert.deepEqual(P.windowsMode(bal, '11111111-2222-3333-4444-555555555555'), { mode: null, why: 'custom' });
  assert.deepEqual(P.windowsMode('8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c', '00000000-0000-0000-0000-000000000000'), { mode: null, why: 'plan' });
  assert.deepEqual(P.windowsMode(null, null), { mode: null, why: 'plan' });
});

test('pmsetBattery: MacBook on battery, charging, desktop Mac', () => {
  const onBatt = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=4653155)\t82%; discharging; 4:12 remaining present: true\n";
  assert.deepEqual(P.pmsetBattery(onBatt), { percent: 82, plugged: false, charging: false, minutesLeft: 252 });
  const charging = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=4653155)\t55%; charging; 1:02 remaining present: true\n";
  assert.deepEqual(P.pmsetBattery(charging), { percent: 55, plugged: true, charging: true, minutesLeft: null });
  const calc = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t90%; discharging; (no estimate) present: true\n";
  assert.equal(P.pmsetBattery(calc).minutesLeft, null);
  assert.equal(P.pmsetBattery("Now drawing from 'AC Power'\n"), null);
  assert.equal(P.pmsetBattery(''), null);
});

test('pmsetMode: powermode wins over lowpowermode', () => {
  assert.equal(P.pmsetMode(' lowpowermode         1\n'), 'saver');
  assert.equal(P.pmsetMode(' lowpowermode         0\n'), 'balanced');
  assert.equal(P.pmsetMode(' powermode            2\n lowpowermode 0\n'), 'performance');
  assert.equal(P.pmsetMode(' powermode            0\n'), 'balanced');
  assert.equal(P.pmsetMode(' powermode            1\n'), 'saver');
  assert.equal(P.pmsetMode('Active Profiles:\n'), null);
});

test('sysfsBattery: laptop packs, mains, device batteries ignored', () => {
  assert.equal(P.sysfsBattery([]), null);
  assert.equal(P.sysfsBattery([{ type: 'Battery', scope: 'Device', capacity: '50', status: 'Discharging' }]), null);
  assert.deepEqual(P.sysfsBattery([
    { type: 'Mains', online: '0' },
    { type: 'Battery', capacity: '64', status: 'Discharging', power_now: '10000000', energy_now: '30000000' },
  ]), { percent: 64, plugged: false, charging: false, minutesLeft: 180 });
  assert.deepEqual(P.sysfsBattery([
    { type: 'Mains', online: '1\n' },
    { type: 'Battery', capacity: '99', status: 'Charging\n' },
  ]), { percent: 99, plugged: true, charging: true, minutesLeft: null });
  // Two packs averaged, charge counters when there is no power_now.
  assert.deepEqual(P.sysfsBattery([
    { type: 'Battery', capacity: '40', status: 'Discharging', current_now: '1000', charge_now: '500' },
    { type: 'Battery', capacity: '60', status: 'Discharging', current_now: '1000', charge_now: '1500' },
  ]), { percent: 50, plugged: false, charging: false, minutesLeft: 60 });
  // Full with no mains supply listed still reads as plugged.
  assert.equal(P.sysfsBattery([{ type: 'Battery', capacity: '100', status: 'Full' }]).plugged, true);
});

test('ppdList: active profile and the ones the machine offers', () => {
  const out = '  performance:\n    CpuDriver:\tamd_pstate\n\n* balanced:\n    CpuDriver:\tamd_pstate\n\n  power-saver:\n    CpuDriver:\tamd_pstate\n';
  assert.deepEqual(P.ppdList(out), { mode: 'balanced', modes: ['saver', 'balanced', 'performance'] });
  const noPerf = '* power-saver:\n    Driver: placeholder\n\n  balanced:\n    Driver: placeholder\n';
  assert.deepEqual(P.ppdList(noPerf), { mode: 'saver', modes: ['saver', 'balanced'] });
  assert.deepEqual(P.ppdList(''), { mode: null, modes: [] });
  assert.equal(P.MODE_TO_PPD.saver, 'power-saver');
});
