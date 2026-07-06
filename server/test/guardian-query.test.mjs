import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { createGuardian } = require('../guardian.js');

// Guardian.queryHistory: targeted per-metric history for the AI (today vs
// yesterday, last24h, 7/30-day averages, 30-day peak, 7-day series). We seed a
// guardian.json with daily/hourly metric buckets and assert the aggregation.

async function withStore({ days = [], hours = [] }, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-q-'));
  try {
    fs.writeFileSync(path.join(dir, 'guardian.json'), JSON.stringify({ hours, days, apps: [] }), 'utf8');
    const g = createGuardian({ dataDir: dir, getSystemInfo: async () => ({}), isEnabled: () => true, onAlert: () => {} });
    return await run(g);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Build a daily bucket with a single metric's {sum,n,max}.
function day(d, metric, avg, max, n = 2) {
  return { d, m: { [metric]: { min: avg, max, sum: avg * n, n } } };
}

test('queryHistory compares today vs yesterday for a temperature metric', async () => {
  const days = [
    day('2026-07-03', 'gpuTemp', 70, 78),
    day('2026-07-04', 'gpuTemp', 90, 92),  // yesterday — hotter
    day('2026-07-05', 'gpuTemp', 80, 85),  // today
  ];
  await withStore({ days }, async (g) => {
    const r = await g.queryHistory('gpuTemp');
    assert.equal(r.metric, 'gpuTemp');
    assert.equal(r.isTemperature, true);
    assert.equal(r.today.avg, 80);
    assert.equal(r.today.max, 85);
    assert.equal(r.yesterday.avg, 90);
    assert.equal(r.yesterday.max, 92);
    // yesterday was hotter than today
    assert.ok(r.yesterday.max > r.today.max);
    assert.equal(r.peakDay30d.date, '2026-07-04');
    assert.equal(r.peakDay30d.max, 92);
    assert.equal(r.dailySeries7d.length, 3);
  });
});

test('queryHistory accepts friendly metric aliases', async () => {
  const days = [day('2026-07-05', 'gpuTemp', 60, 70)];
  await withStore({ days }, async (g) => {
    const r = await g.queryHistory('gpu temp');
    assert.equal(r.metric, 'gpuTemp');
    const r2 = await g.queryHistory('RAM');
    assert.equal(r2.metric, 'mem');
  });
});

test('queryHistory rejects an unknown metric with the valid list', async () => {
  await withStore({ days: [] }, async (g) => {
    const r = await g.queryHistory('voltage');
    assert.equal(r.error, 'unknown_metric');
    assert.deepEqual(r.validMetrics, ['cpu', 'cpuTemp', 'gpu', 'gpuTemp', 'mem']);
  });
});

test('queryHistory returns nulls gracefully when there is no history', async () => {
  await withStore({ days: [] }, async (g) => {
    const r = await g.queryHistory('cpu');
    assert.equal(r.today, null);
    assert.equal(r.yesterday, null);
    assert.equal(r.last7dAvg, null);
    assert.equal(r.peakDay30d, null);
    assert.deepEqual(r.dailySeries7d, []);
  });
});

test('queryHistory averages the last 24 hourly buckets', async () => {
  const hours = [];
  for (let i = 0; i < 30; i++) hours.push({ h: `2026-07-05T${String(i % 24).padStart(2, '0')}`, m: { cpu: { min: 50, max: 60, sum: 100, n: 2 } } });
  await withStore({ hours }, async (g) => {
    const r = await g.queryHistory('cpu');
    assert.equal(r.last24h.avg, 50); // sum/n = 100/2
    assert.equal(r.last24h.max, 60);
  });
});
