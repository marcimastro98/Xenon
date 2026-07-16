'use strict';
// battery.js mergeSources — the pure merge behind the Battery widget:
// Corsair wins a name collision, invalid readings are dropped, and devices
// not re-seen for STALE_MS fade out instead of freezing at a stale percent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeSources, STALE_MS, createBatteryMonitor } = require('../battery.js');

test('mergeSources: corsair wins a name collision, sources tag their entries', () => {
  const now = 1_000_000;
  const map = mergeSources(
    [{ name: 'Dark Core RGB Pro', percent: 82 }],
    [{ name: 'dark core rgb pro', percent: 79 }, { name: 'MX Keys', percent: 51 }],
    new Map(), now,
  );
  assert.equal(map.size, 2);
  const mouse = map.get('dark core rgb pro');
  assert.equal(mouse.percent, 82);
  assert.equal(mouse.source, 'corsair');
  assert.equal(mouse.charging, null);        // no source exposes charging today
  assert.equal(map.get('mx keys').source, 'bluetooth');
});

test('mergeSources: invalid names/percents are dropped at the boundary', () => {
  const map = mergeSources(
    [{ name: '', percent: 50 }, { name: 'Ok', percent: 101 }, null],
    [{ name: 'Neg', percent: -3 }, { name: 'NaN', percent: 'x' }, { name: 'Good', percent: 33.6 }],
    new Map(), 0,
  );
  assert.deepEqual([...map.keys()], ['good']);
  assert.equal(map.get('good').percent, 34);  // rounded
});

test('mergeSources: unseen devices survive until STALE_MS, then evict', () => {
  const t0 = 1_000_000;
  let map = mergeSources([], [{ name: 'Headset', percent: 70 }], new Map(), t0);
  // Sources go quiet (device asleep): entry survives inside the window…
  map = mergeSources([], [], map, t0 + STALE_MS - 1);
  assert.equal(map.size, 1);
  // …and is evicted once stale.
  map = mergeSources([], [], map, t0 + STALE_MS + 1);
  assert.equal(map.size, 0);
});

test('mergeSources: a re-seen device refreshes its timestamp and value', () => {
  const t0 = 1_000_000;
  let map = mergeSources([], [{ name: 'Mouse', percent: 60 }], new Map(), t0);
  map = mergeSources([], [{ name: 'Mouse', percent: 55 }], map, t0 + STALE_MS - 1000);
  map = mergeSources([], [], map, t0 + STALE_MS + 1000); // old t0 would be stale; refresh isn't
  assert.equal(map.size, 1);
  assert.equal(map.get('mouse').percent, 55);
});

test('createBatteryMonitor: degrades to empty when both sources fail, flags availability', async () => {
  const monitor = createBatteryMonitor({
    runScript: async () => { throw new Error('no worker'); },
    lighting: { getBatteryLevels: async () => ({ ok: false, reason: 'icue_off', devices: [] }) },
  });
  const out = await monitor.getDevices();
  assert.deepEqual(out.devices, []);
  assert.equal(out.sources.corsair, false);
  assert.equal(out.sources.bluetooth, false);
});

test('createBatteryMonitor: merges live sources and sorts by name', async () => {
  const monitor = createBatteryMonitor({
    runScript: async () => ({ devices: [{ name: 'Zeta Mouse', percent: 40 }, { name: 'Alpha Keys', percent: 90 }] }),
    lighting: { getBatteryLevels: async () => ({ ok: true, devices: [{ name: 'Virtuoso XT', percent: 66 }] }) },
  });
  const out = await monitor.getDevices();
  assert.deepEqual(out.devices.map(d => d.name), ['Alpha Keys', 'Virtuoso XT', 'Zeta Mouse']);
  assert.equal(out.sources.corsair, true);
  assert.equal(out.sources.bluetooth, true);
});
