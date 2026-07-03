import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { createGuardian } = require('../guardian.js');

// Guardian's "PC Screen Time" read path: a pre-seeded guardian.json is
// normalized on load and aggregated by getHistory() into 24h / 7d / 30d
// top-app rollups. We test the aggregation (not the timer) so it stays fast.

async function withStore(apps, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'guardian.json'), JSON.stringify({ hours: [], days: [], apps }), 'utf8');
    const g = createGuardian({
      dataDir: dir,
      getSystemInfo: async () => ({}),
      isEnabled: () => true,
      onAlert: () => {},
    });
    return await run(g); // await before the finally removes the dir (load() is async)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('appsInRange sums per app, sorts desc, and reports the game share', async () => {
  const apps = [
    { d: '2026-07-01', a: { chrome: { s: 3600, g: 0 }, cyberpunk2077: { s: 7200, g: 1 } } },
    { d: '2026-07-02', a: { chrome: { s: 1800, g: 0 }, code: { s: 900, g: 0 } } },
  ];
  await withStore(apps, async (g) => {
    const { usage } = await g.getHistory();
    const wk = usage.ranges['7d'];
    assert.equal(wk.total, 3600 + 7200 + 1800 + 900);
    assert.equal(wk.gameTotal, 7200);
    // Sorted by seconds desc: cyberpunk (7200) > chrome (3600+1800=5400) > code (900).
    assert.deepEqual(wk.apps.map(a => a.name), ['cyberpunk2077', 'chrome', 'code']);
    assert.equal(wk.apps[0].game, true);
    assert.equal(wk.apps[1].seconds, 5400);
    assert.equal(wk.apps[1].game, false);
  });
});

test('the 24h range covers only the most recent day bucket', async () => {
  const apps = [
    { d: '2026-06-01', a: { chrome: { s: 9999, g: 0 } } },   // old, excluded from 24h
    { d: '2026-06-02', a: { code: { s: 1200, g: 0 } } },     // most recent
  ];
  await withStore(apps, async (g) => {
    const { usage } = await g.getHistory();
    assert.equal(usage.ranges['24h'].total, 1200);
    assert.deepEqual(usage.ranges['24h'].apps.map(a => a.name), ['code']);
    assert.equal(usage.ranges['30d'].total, 9999 + 1200);
  });
});

test('normalizeApps drops malformed buckets and non-positive entries', async () => {
  const apps = [
    null,                                              // junk
    { d: 123, a: { x: { s: 5 } } },                    // bad day key
    { d: '2026-07-01', a: 'nope' },                    // bad app map
    { d: '2026-07-01', a: { good: { s: 60, g: 1 }, zero: { s: 0 }, bad: { s: -5 } } },
  ];
  await withStore(apps, async (g) => {
    const { usage } = await g.getHistory();
    const day = usage.ranges['24h'];
    assert.equal(day.total, 60);
    assert.deepEqual(day.apps.map(a => a.name), ['good']);
    assert.equal(day.apps[0].game, true);
  });
});

test('empty / absent usage yields zeroed ranges, not a crash', async () => {
  await withStore([], async (g) => {
    const { usage } = await g.getHistory();
    for (const key of ['24h', '7d', '30d']) {
      assert.equal(usage.ranges[key].total, 0);
      assert.equal(usage.ranges[key].gameTotal, 0);
      assert.deepEqual(usage.ranges[key].apps, []);
    }
  });
});
