// fpsmon.js: what the monitor remembers between calls. A PresentMon that ends at once is
// started again, slowly after three quick ends in a row; frames keep the PC "gaming" for a
// short while after the last one; a stopped monitor never starts again. The process, the
// clock and the timers are the test's own, so nothing here waits for real time.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const cp = require('child_process');
const spawned = [];
let refuse = false;
const realSpawn = cp.spawn;
cp.spawn = (exe, args) => {
  if (refuse) throw new Error('refused');
  const p = new EventEmitter();
  Object.assign(p, { exe, args, stdout: new EventEmitter(), stderr: new EventEmitter(), killed: false });
  p.kill = () => { p.killed = true; };
  p.unref = () => p;
  spawned.push(p);
  return p;
};
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
Object.defineProperty(process, 'platform', { value: 'win32' });
const fpsmon = require('../fpsmon.js');
cp.spawn = realSpawn;
after(() => Object.defineProperty(process, 'platform', realPlatform));

// The waits of fpsmon.js: after an end, after three quick ends, and how long frames count.
const SHORT = 5000;
const LONG = 60000;
const GRACE = 10000;
const START = Date.UTC(2026, 0, 15, 10, 0, 0);
const presentMons = () => spawned.filter((p) => !/logman/i.test(p.exe));
const traceStops = () => spawned.filter((p) => /logman/i.test(p.exe));
const last = () => presentMons().at(-1);

// Each test has the clock to itself and leaves the monitor paused, as it found it.
function withClock(run) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: START });
  try { run(); } finally { refuse = false; fpsmon.pauseFpsMonitor(); mock.timers.reset(); }
}

test('a PresentMon that ends at once is started again, slowly after three times in a row', () => withClock(() => {
  fpsmon.resumeFpsMonitor();
  assert.equal(presentMons().length, 1);
  last().emit('close', 1, null);
  mock.timers.tick(SHORT - 1);
  assert.equal(presentMons().length, 1, 'not before the short wait is over');
  mock.timers.tick(1);
  assert.equal(presentMons().length, 2);
  last().emit('close', 1, null);
  mock.timers.tick(SHORT);
  assert.equal(presentMons().length, 3);
  last().emit('close', 1, null);
  mock.timers.tick(SHORT);
  assert.equal(presentMons().length, 3, 'the third quick end in a row waits the long time');
  mock.timers.tick(LONG - SHORT);
  assert.equal(presentMons().length, 4);
  // One that lived a while did not end at once: the count starts again.
  mock.timers.tick(3000);
  last().emit('close', 0, null);
  mock.timers.tick(SHORT);
  assert.equal(presentMons().length, 5);
}));

test('reload starts at once instead of waiting out the long time', () => withClock(() => {
  fpsmon.resumeFpsMonitor();
  last().emit('close', 1, null);
  mock.timers.tick(SHORT);
  last().emit('close', 1, null);
  mock.timers.tick(SHORT);
  last().emit('close', 1, null);
  const count = presentMons().length;
  fpsmon.reload();
  assert.equal(presentMons().length, count + 1);
  mock.timers.tick(LONG);
  assert.equal(presentMons().length, count + 1, 'the wait that reload replaced starts nothing more');
}));

test('a PresentMon that cannot be started is tried again after the wait', () => withClock(() => {
  const count = presentMons().length;
  refuse = true;
  fpsmon.resumeFpsMonitor();
  assert.equal(presentMons().length, count);
  refuse = false;
  mock.timers.tick(SHORT);
  assert.equal(presentMons().length, count + 1);
}));

test('start does nothing while the monitor is paused or a PresentMon runs', () => withClock(() => {
  const count = presentMons().length;
  fpsmon.startFpsMonitor();
  assert.equal(presentMons().length, count, 'paused: nobody is looking');
  fpsmon.resumeFpsMonitor();
  fpsmon.startFpsMonitor();
  assert.equal(presentMons().length, count + 1, 'one PresentMon, not two');
  last().emit('close', 1, null);
  fpsmon.startFpsMonitor();
  assert.equal(presentMons().length, count + 2, 'none is running: it starts without waiting for the timer');
}));

test('the PC counts as gaming for a short while after the last frame', () => withClock(() => {
  assert.equal(fpsmon.isGaming(), false, 'no frame was ever seen');
  fpsmon.resumeFpsMonitor();
  last().stdout.emit('data', Buffer.from(`Application,ProcessID,MsBetweenPresents\n${'game.exe,4242,10.0\n'.repeat(30)}`));
  assert.equal(fpsmon.getCurrentFps(), 100);
  assert.equal(fpsmon.getFpsDetail().presentFps, 100);
  assert.equal(fpsmon.getGamingProcess().fps, 100);
  assert.equal(fpsmon.isGaming(), true);
  fpsmon.pauseFpsMonitor();   // the frames go with the reader
  assert.equal(fpsmon.getCurrentFps(), null);
  assert.equal(fpsmon.getGamingProcess(), null);
  mock.timers.tick(GRACE - 1);
  assert.equal(fpsmon.isGaming(), true, 'a moment without frames is not the end of the game');
  mock.timers.tick(1);
  assert.equal(fpsmon.isGaming(), false);
}));

// Last: stop is final for this process.
test('a stopped monitor kills its PresentMon, ends the trace and never starts again', () => withClock(() => {
  fpsmon.resumeFpsMonitor();
  const first = last();
  first.emit('close', 1, null);            // a restart is now waiting
  fpsmon.reload();
  const running = last();
  assert.notEqual(running, first);
  running.emit('error', Object.assign(new Error('gone'), { code: 'ENOENT' }));   // and another one waits
  fpsmon.reload();
  const count = presentMons().length;
  const stops = traceStops().length;
  fpsmon.stopFpsMonitor();
  assert.equal(last().killed, true);
  assert.ok(traceStops().length > stops, 'the trace a killed PresentMon leaves behind is stopped');
  assert.deepEqual(traceStops().at(-1).args.slice(0, 2), ['stop', 'XenonFps']);
  last().emit('close', 0, null);
  fpsmon.resumeFpsMonitor();
  fpsmon.startFpsMonitor();
  fpsmon.reload();
  mock.timers.tick(LONG * 2);
  assert.equal(presentMons().length, count);
}));
