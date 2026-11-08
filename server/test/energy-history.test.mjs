// Energy from the sensor history (v5.0.0): watt-hours per hour and per day, so
// a widget or Bit can say kWh per day and per month. Asked for by a supporter
// who wanted a "power meter" with the cost. Pinned here: a reading stands for
// the gap since the previous one and never for the hours the PC was off, the
// stored buckets are read back field by field, the whole-PC figure is told
// apart from CPU + GPU, the SDK route answers only with the grant, and Bit gets
// a voice-only tool.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Energy = require('../sensor-history/energy.js');
const { createGuardian } = require('../guardian.js');
const { readEnergy } = require('../sensor-history/routes.js');
const { createCapabilities, aiFunctions } = require('../capabilities/index.js');
const featureRoutes = require('../feature-routes.js');
const sdk = require('../sdk-widgets.js');
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const MIN = 60 * 1000;

test('a reading stands for the gap since the last one, at most one interval', () => {
  assert.equal(Energy.creditMs(0, 10 * MIN, 5 * MIN), 5 * MIN, 'the first reading stands for one interval');
  assert.equal(Energy.creditMs(8 * MIN, 10 * MIN, 5 * MIN), 2 * MIN, 'a shorter gap after a change of interval');
  assert.equal(Energy.creditMs(0.5 * MIN, 5.5 * MIN + 2000, 5 * MIN), 5 * MIN + 2000, 'a late tick keeps its seconds');
  assert.equal(Energy.creditMs(MIN, 4 * 60 * MIN, 5 * MIN), 5 * MIN + 5000, 'after a sleep: one interval, not the hours off');
  assert.equal(Energy.creditMs(MIN, 2 * MIN, 0), 0);
});

test('watts x time in Wh per source, with the seconds covered', () => {
  const b = {};
  assert.equal(Energy.credit(b, { cpu: 60, gpu: 120, psu: 300 }, 5 * MIN), true);
  Energy.credit(b, { cpu: 60, gpu: null, psu: 300 }, 5 * MIN);
  assert.deepEqual(Energy.energyOf(b), { cpu: 10, gpu: 10, psu: 50, covered: 600 });
  assert.equal(Energy.credit(b, { cpu: null, gpu: -4, psu: 99999 }, 5 * MIN), false, 'nothing real read: nothing credited');
  assert.equal(Energy.energyOf(b).covered, 600);
});

test('stored buckets are read back field by field', () => {
  assert.deepEqual(Energy.energyOf({ e: { cpu: 'x', gpu: -1, psu: 12.345, s: 'y', extra: 1 } }), { cpu: null, gpu: null, psu: 12.35, covered: 0 });
  assert.deepEqual(Energy.energyOf(null), { cpu: null, gpu: null, psu: null, covered: 0 });
  const list = [{ d: '2026-11-07', e: { cpu: 1 } }, { d: '../x' }, { d: 7 }, { h: '2026-11-08T03' }];
  assert.deepEqual(Energy.series(list, 'd').map((p) => p.t), ['2026-11-07']);
  assert.deepEqual(Energy.series(list, 'h').map((p) => p.t), ['2026-11-08T03']);
});

test('the whole PC when the power supply reports, otherwise CPU + GPU, and said', () => {
  assert.deepEqual(Energy.totalOf({ cpu: 100, gpu: 200, psu: 500 }), { wh: 500, whole: true });
  assert.deepEqual(Energy.totalOf({ cpu: 100, gpu: 200, psu: null }), { wh: 300, whole: false });
  assert.deepEqual(Energy.totalOf({ cpu: null, gpu: null, psu: null }), { wh: null, whole: false });
});

test('the summary Bit reads: today, yesterday, this month, 30 days, the last 7', () => {
  const day = (d, wh, s = 36000) => ({ d, e: { cpu: wh / 2, gpu: wh / 2, s } });
  const days = [day('2026-10-30', 1000), day('2026-10-31', 2000), day('2026-11-01', 500), day('2026-11-07', 1500), day('2026-11-08', 250, 7200)];
  const s = Energy.summary(days, '2026-11-08');
  assert.deepEqual(s.today, { kwh: 0.25, wholePc: false, hoursCovered: 2 });
  assert.equal(s.yesterday.kwh, 1.5);
  assert.deepEqual(s.thisMonth, { kwh: 2.25, wholePc: false });
  assert.equal(s.last30Days.kwh, 5.25);
  assert.equal(s.last7Days.length, 5);
  assert.equal(s.daysRecorded, 5);
  assert.equal(Energy.summary([], '2026-11-08').today, null);
  assert.equal(Energy.summary([{ d: '2026-11-08', e: { psu: 800, s: 3600 } }], '2026-11-08').today.wholePc, true);
  assert.equal(Energy.summary(days, '2026-11-01').yesterday.kwh, 2, 'yesterday crosses the month');
});

test('guardian: a sample adds energy to its hour and its day, and it survives a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-energy-'));
  try {
    const opts = {
      dataDir: dir, isEnabled: () => true, onAlert: () => {}, getEveryMin: () => 5,
      getSystemInfo: async () => ({ cpu: 20, memory: { percent: 40 }, power: { cpu: 60, gpu: 120, psu: 300 } }),
    };
    const g = createGuardian(opts);
    await g.sample();
    const e = await g.getEnergy();
    assert.equal(e.enabled, true);
    assert.equal(e.sampleMinutes, 5);
    assert.deepEqual({ ...e.now, at: typeof e.now.at }, { cpu: 60, gpu: 120, psu: 300, at: 'string' });
    assert.deepEqual(e.days.map(({ cpu, gpu, psu, covered }) => ({ cpu, gpu, psu, covered })), [{ cpu: 5, gpu: 10, psu: 25, covered: 300 }]);
    assert.equal(e.hours.length, 1);
    const s = await g.getEnergySummary();
    assert.deepEqual(s.today, { kwh: 0.025, wholePc: true, hoursCovered: 0.1 });
    const again = createGuardian(opts);
    assert.equal((await again.getEnergy()).days[0].psu, 25, 'written with the rest of the history');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the SDK route: only with the grant, numbers only, a fixed word on failure', async () => {
  const call = async (granted, history) => {
    const sent = [];
    await readEnergy(null, null, { json: (v) => sent.push(v), sdkStreamGranted: (s) => s === 'energy' && granted, history });
    return sent[0];
  };
  let reads = 0;
  const history = { getEnergy: async () => { reads++; return { enabled: true, days: [] }; } };
  assert.deepEqual(await call(false, history), { ok: false, error: 'not_granted' });
  assert.equal(reads, 0);
  assert.deepEqual(await call(true, history), { ok: true, enabled: true, days: [] });
  assert.deepEqual(await call(true, null), { ok: false, error: 'unavailable' });
  assert.deepEqual(await call(true, { getEnergy: async () => { throw new Error('C:\\data\\guardian.json'); } }), { ok: false, error: 'failed' });
  assert.equal(featureRoutes.has('GET', '/api/energy'), true);
  assert.match(read('../server.js'), /sdkStreamGranted: _sdkStreamGranted, history: guardian \}/);
});

test('the stream in the four places, rebuilt field by field in the bridge', () => {
  assert.ok(sdk.SDK_STREAMS.includes('energy'));
  assert.match(read('../js/settings.js'), /const SDK_WIDGET_STREAMS = Object\.freeze\(\[[^\]]*'energy'/);
  const cw = read('../js/custom-widget.js');
  assert.match(cw, /energy: \['cw_stream_energy', /);
  const at = cw.indexOf('    energy: Object.freeze({ ttl: 60000');
  assert.ok(at > 0);
  const loader = cw.slice(at, cw.indexOf('} }),', at));
  assert.match(loader, /api\('\/api\/energy'\)/);
  assert.match(loader, /\{ t: p\.t, cpu: num\(p\.cpu\), gpu: num\(p\.gpu\), psu: num\(p\.psu\), covered: num\(p\.covered\) \|\| 0 \}/);
  assert.match(read('../../docs/WIDGET_SDK.md'), /### 3b-sexies\. Energy, hour by hour and day by day: `energy` \(v5\.0\.0\)/);
});

test('Bit: get_energy_use, voice only, and history_off when there is nothing', async () => {
  const caps = createCapabilities({ energy: { summary: async () => ({ enabled: true, today: { kwh: 1.2 }, daysRecorded: 1 }) } });
  assert.equal(caps.probes().energyUsage, true);
  assert.equal(createCapabilities({}).probes().energyUsage, false);
  assert.deepEqual(await caps.run({ type: 'energyUsage' }), { ok: true, enabled: true, today: { kwh: 1.2 }, daysRecorded: 1 });
  const off = createCapabilities({ energy: { summary: async () => ({ enabled: false, daysRecorded: 0 }) } });
  assert.deepEqual(await off.run({ type: 'energyUsage' }), { ok: false, error: 'history_off' });
  assert.ok(aiFunctions({ energyUsage: true }).some((f) => f.name === 'get_energy_use'));
  assert.match(read('../ai-tool-groups.js'), /'set_sensor_history', 'get_energy_use'\]/);
});
