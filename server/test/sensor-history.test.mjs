// Sensor history: how often it samples is the user's choice (1 to 15 minutes),
// and the last 6 hours are kept at that resolution for the "6h" chart. A user
// asked for a finer history than one sample every 5 minutes. Pinned here: the
// setting's shape on both sides, the bounded recent ring, the sampler following
// the setting without a restart, the disk written at most every 5 minutes, and
// the Deck / Bit / SDK switch.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const SensorHistory = require('../js/sensor-history.js');
const Recent = require('../sensor-history/recent.js');
const { createGuardian } = require('../guardian.js');
const gameMode = require('../capabilities/game-mode.js');
const { createCapabilities, aiFunctions } = require('../capabilities/index.js');
const { validateAction } = require('../js/deck-actions.js');
const sdk = require('../sdk-widgets.js');

const METRICS = ['cpu', 'cpuTemp', 'gpu', 'gpuTemp', 'mem', 'cpuWatts', 'gpuWatts'];
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

test('the setting: off and every 5 minutes unless said otherwise, only the offered intervals', () => {
  assert.deepEqual(SensorHistory.normalizeSensorHistory(undefined), { enabled: false, everyMin: 5 });
  assert.deepEqual(SensorHistory.normalizeSensorHistory({ enabled: true, everyMin: 1 }), { enabled: true, everyMin: 1 });
  assert.deepEqual(SensorHistory.normalizeSensorHistory({ enabled: 'yes', everyMin: '15' }), { enabled: false, everyMin: 15 });
  for (const bad of [0, 3, 60, -1, 'x', null, 2.5]) assert.equal(SensorHistory.normalizeEveryMin(bad), 5, String(bad));
});

test('client and server normalize it with the same module', () => {
  assert.match(engineSource(), /sensorHistory: SensorHistory\.normalizeSensorHistory\(source\.sensorHistory\)/);
  assert.match(read('../js/settings.js'), /sensorHistory: window\.SensorHistory \? window\.SensorHistory\.normalizeSensorHistory\(value\.sensorHistory\)/);
  // Turning history on or off keeps the chosen interval.
  assert.match(read('../js/settings.js'), /sensorHistory: \{ \.\.\.hubSettings\.sensorHistory, enabled: !!enabled \}/);
  assert.match(engineSource(), /getEveryMin: \(\) => \(_serverHubSettings && _serverHubSettings\.sensorHistory \|\| \{\}\)\.everyMin/);
});

test('the recent ring keeps 6 hours, in order, and nothing else', () => {
  const now = Date.UTC(2026, 10, 7, 12, 0);
  let list = [];
  for (let i = 0; i < 8 * 60; i++) list = Recent.pushRecent(list, { cpu: i, junk: 1 }, METRICS, now - (8 * 60 - i) * 60000);
  assert.ok(list.length <= Recent.RECENT_MAX);
  assert.ok(list[0].at >= now - 6 * 3600000 - 60000, 'older than 6 hours is gone');
  assert.equal(list[list.length - 1].v.cpu, 8 * 60 - 1);
  assert.equal('junk' in list[0].v, false);
  // A second sample at the same moment is not a second point.
  assert.equal(Recent.pushRecent(list, { cpu: 1 }, METRICS, list[list.length - 1].at).length, list.length);
});

test('a recent ring read from disk is rebuilt from the known shape', () => {
  const now = Date.UTC(2026, 10, 7, 12, 0);
  const raw = [
    { at: now - 120000, v: { cpu: 10, cpuTemp: 'hot' } },
    { at: now - 180000, v: { cpu: 99 } },           // out of order
    { at: now + 600000, v: { cpu: 1 } },            // from the future
    { at: 'x' }, null, 7,
    { at: now - 60000, v: { cpu: 12.345 } },
  ];
  const list = Recent.normalizeRecent(raw, METRICS, now);
  assert.deepEqual(list.map((e) => e.v.cpu), [10, 12.3]);
  assert.equal(list[0].v.cpuTemp, null);
  assert.deepEqual(Recent.normalizeRecent('nope', METRICS, now), []);
  const [point] = Recent.recentSeries(list.slice(0, 1), METRICS);
  assert.match(point.t, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  assert.deepEqual(point.cpu, { avg: 10, max: 10 });
  assert.equal(point.gpu, null);
});

async function withGuardian(opts, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'senshist-test-'));
  try {
    const g = createGuardian({ dataDir: dir, isEnabled: () => true, onAlert: () => {}, ...opts });
    return await run(g, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('each sample lands in the recent ring and getHistory hands it out with the interval', async () => {
  let cpu = 10;
  await withGuardian({ getSystemInfo: async () => ({ cpu: cpu++, cpuTemp: 50 }), getEveryMin: () => 2 }, async (g) => {
    await g.sample();
    const h = await g.getHistory();
    assert.equal(h.sampleMinutes, 2);
    assert.equal(h.recent.length, 1);
    assert.deepEqual(h.recent[0].cpu, { avg: 10, max: 10 });
    assert.equal(h.hours.length, 1, 'the hourly average still gets it');
  });
});

test('a bad interval from settings falls back to 5 minutes', async () => {
  await withGuardian({ getSystemInfo: async () => ({}), getEveryMin: () => { throw new Error('no settings'); } }, async (g) => {
    assert.equal((await g.getHistory()).sampleMinutes, 5);
  });
});

test('the disk is written at most every 5 minutes, whatever the interval', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 7, 10, 0) });
  await withGuardian({ getSystemInfo: async () => ({ cpu: 5 }), getEveryMin: () => 1 }, async (g, dir) => {
    const file = path.join(dir, 'guardian.json');
    await g.sample();
    assert.ok(fs.existsSync(file), 'the first sample is written');
    fs.rmSync(file);
    t.mock.timers.tick(60000);
    await g.sample();
    assert.equal(fs.existsSync(file), false, 'one minute later: still only in memory');
    t.mock.timers.tick(4 * 60000);
    await g.sample();
    assert.ok(fs.existsSync(file), 'five minutes after the last write: written');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).recent.length, 3, 'with every sample since');
  });
});

test('the sampler follows the setting without a restart', async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.UTC(2026, 10, 7, 10, 0) });
  let every = 5;
  let samples = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'senshist-timer-'));
  const g = createGuardian({
    dataDir: dir, isEnabled: () => true, onAlert: () => {},
    getSystemInfo: async () => { samples++; return {}; },
    getEveryMin: () => every,
  });
  // One minute passes, and the sample it started (real file reads) settles.
  const minute = async () => { mock.timers.tick(60000); await new Promise((r) => setTimeout(r, 25)); };
  try {
    g.start();
    for (let i = 0; i < 11; i++) await minute();
    assert.equal(samples, 3, 'every 5 minutes: at 1, 6 and 11');
    every = 1;
    for (let i = 0; i < 3; i++) await minute();
    assert.equal(samples, 6, 'then every minute');
  } finally {
    g.stop();
    mock.timers.reset();
    await new Promise((r) => setTimeout(r, 20));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function fakeKeys(start) {
  const store = { sensorHistory: { enabled: false, everyMin: 5 }, ...start };
  return { store, get: (k) => store[k], update: async (k, change) => (store[k] = change(store[k])) };
}

test('the switch: on, off, toggle and the interval alone', async () => {
  const keys = fakeKeys();
  const d = { settingKeys: keys };
  assert.deepEqual(await gameMode.setSensorHistory(d, { mode: 'on', every: '1' }), { ok: true, enabled: true, everyMin: 1 });
  assert.deepEqual(await gameMode.setSensorHistory(d, { mode: 'interval', every: 10 }), { ok: true, enabled: true, everyMin: 10 });
  assert.deepEqual(await gameMode.setSensorHistory(d, { mode: 'toggle' }), { ok: true, enabled: false, everyMin: 10 });
  assert.equal((await gameMode.setSensorHistory(d, { mode: 'interval' })).error, 'bad_every');
  assert.equal((await gameMode.setSensorHistory(d, { mode: 'on', every: 3 })).error, 'bad_every');
  assert.equal((await gameMode.setSensorHistory(d, { mode: 'later' })).error, 'bad_mode');
  assert.deepEqual(keys.store.sensorHistory, { enabled: false, everyMin: 10 });
});

test('Deck, Bit and widgets reach it through the registry', async () => {
  const keys = fakeKeys();
  const caps = createCapabilities({ settingKeys: keys });
  assert.equal(caps.probes().sensorHistory, true);
  assert.equal(validateAction({ type: 'sensorHistory', mode: 'on', every: '3' }), null, 'an unknown interval is refused, never read as 1');
  assert.deepEqual(await caps.run(validateAction({ type: 'sensorHistory', mode: 'on', every: '2' })), { ok: true, enabled: true, everyMin: 2 });
  assert.ok(aiFunctions({ sensorHistory: true }).some((f) => f.name === 'set_sensor_history'));
  assert.ok(sdk.SDK_ACTION_CATEGORIES.performance.includes('sensorHistory'));
  assert.match(read('../js/custom-widget.js'), /sensorHistory: \{ enabled: 'boolean', everyMin: 'number' \}/);
});

test('Settings shows the interval only while history is collected, with no inline handlers', () => {
  const index = read('../index.html');
  assert.match(index, /<div class="settings-row full" id="settings-senshist-every" hidden><\/div>/);
  assert.match(index, /<script src="js\/sensor-history\.js"><\/script>/);
  assert.match(index, /<script src="js\/sensor-history-settings\.js"><\/script>/);
  const page = read('../js/sensor-history-settings.js');
  assert.match(page, /host\.hidden = !historyOn\(\)/);
  assert.match(page, /window\.SensorHistory\.EVERY_MIN_CHOICES/);
  assert.match(read('../js/settings.js'), /if \(window\.SensorHistoryEvery\) window\.SensorHistoryEvery\.sync\(\);/);
});
