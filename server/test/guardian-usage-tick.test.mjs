// Guardian's "PC Screen Time" write path: the ticker credits each 15 seconds to the app that was
// in front during them, counts nothing for the lock screen, for a gap (the PC slept) or while the
// feature is off, and the next sample writes what was counted. The clock is the test's own.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { createGuardian } = require('../guardian.js');

const TICK = 15000;
// Waits for something real (a file write) while the mocked clock stands still.
const settled = async (check) => { while (!check()) await new Promise((resolve) => setImmediate(resolve)); };

test('a sample asked for while one is running does nothing, and the next one after it runs again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'guardian-busy-'));
  const asked = [];
  const guardian = createGuardian({ dataDir: dir, isEnabled: () => true, onAlert: () => {},
    getSystemInfo: () => new Promise((resolve) => { asked.push(() => resolve({ cpu: 10 })); }) });
  try {
    const [first, second] = [guardian.sample(), guardian.sample()];
    await second;
    assert.equal(asked.length, 1, 'the second call found the first one at work');
    asked[0]();
    await first;
    const third = guardian.sample();
    assert.equal(asked.length, 2);
    asked[1]();
    await third;
    assert.equal((await guardian.getHistory()).recent.length, 2, 'both readings that were taken are kept');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the usage ticker credits the app in front, skips the lock screen, a gap and the time it is off, and a sample writes it', async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.UTC(2026, 10, 7, 12, 30) });
  const dir = mkdtempSync(join(tmpdir(), 'guardian-tick-'));
  const file = join(dir, 'guardian.json');
  const now = { front: 'Chrome.exe', game: false, enabled: true, samples: 0 };
  const guardian = createGuardian({
    dataDir: dir, isEnabled: () => now.enabled, onAlert: () => {}, getEveryMin: () => 15,
    getSystemInfo: async () => { now.samples += 1; return {}; },
    getForegroundApp: () => now.front, isForegroundGame: () => now.game,
  });
  const usage = async () => (await guardian.getHistory()).usage.ranges['7d'];
  try {
    await guardian.exportStore(); // the store is read before the ticker starts, so nothing is counted into a store that is replaced
    guardian.start();
    mock.timers.tick(TICK); // the first tick only remembers who is in front
    assert.equal((await usage()).total, 0);
    mock.timers.tick(TICK);
    mock.timers.tick(TICK);
    assert.deepEqual((await usage()).apps, [{ name: 'chrome', seconds: 30, game: false }], 'the name is lower case, without .exe');

    // The lock screen is nobody: the interval before it still counts, the ones during it do not.
    now.front = 'LockApp.exe';
    mock.timers.tick(TICK); // one minute in: the sampler runs too, and writes what the ticker counted
    await settled(() => existsSync(file));
    assert.equal(now.samples, 1);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).apps.map((day) => day.a), [{ chrome: { s: 45, g: 0 } }]);
    now.front = 'Game.exe';
    now.game = true;
    mock.timers.tick(TICK);
    assert.equal((await usage()).total, 45, 'nothing for the time the lock screen was up');
    mock.timers.tick(TICK);
    assert.deepEqual((await usage()).apps[1], { name: 'game', seconds: 15, game: true });

    // Two minutes pass without a tick (the PC slept): they are nobody's.
    mock.timers.setTime(Date.now() + 120000);
    mock.timers.tick(TICK);
    assert.equal((await usage()).total, 60);
    mock.timers.tick(TICK);
    assert.equal((await usage()).gameTotal, 30);

    // Switched off, the ticker forgets who was in front; switched on again it starts from the next tick.
    now.enabled = false;
    mock.timers.tick(TICK);
    now.enabled = true;
    mock.timers.tick(TICK);
    assert.equal((await usage()).gameTotal, 30);
    mock.timers.tick(TICK);
    mock.timers.tick(TICK);
    assert.deepEqual(await usage(), { total: 105, gameTotal: 60, apps: [{ name: 'game', seconds: 60, game: true }, { name: 'chrome', seconds: 45, game: false }] });

    guardian.stop();
    mock.timers.tick(4 * TICK);
    assert.equal((await usage()).total, 105, 'stopped, it counts no more');
    assert.equal(now.samples, 1, 'and the sampler, set to every 15 minutes, ran once');
  } finally {
    guardian.stop();
    mock.timers.reset();
    rmSync(dir, { recursive: true, force: true });
  }
});
