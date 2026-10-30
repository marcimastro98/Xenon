// fpsmon.js: a PresentMon that was replaced (pause then resume) still closes
// later. Its close must not clear the new process nor start a third one, or two
// PresentMons fight over the one ETW session and the FPS reading drops out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const cp = require('child_process');
const spawned = [];
const realSpawn = cp.spawn;
cp.spawn = (exe, args) => {
  const p = new EventEmitter();
  p.exe = exe;
  p.args = args;
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.killed = false;
  p.kill = () => { p.killed = true; };
  p.unref = () => p;
  spawned.push(p);
  return p;
};
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
Object.defineProperty(process, 'platform', { value: 'win32' });
const fpsmon = require('../fpsmon.js');
cp.spawn = realSpawn;

const presentMons = () => spawned.filter((p) => !/logman/i.test(p.exe));

test('the old PresentMon closing after a pause and resume leaves the new one in charge', () => {
  try {
    fpsmon.resumeFpsMonitor();
    assert.equal(presentMons().length, 1);
    const a = presentMons()[0];
    fpsmon.pauseFpsMonitor();
    assert.equal(a.killed, true);
    fpsmon.resumeFpsMonitor();
    assert.equal(presentMons().length, 2);
    const b = presentMons()[1];
    a.emit('close');
    a.emit('error', new Error('late'));
    // The new process is still the one: asking again starts nothing.
    fpsmon.startFpsMonitor();
    fpsmon.reload();
    assert.equal(presentMons().length, 2);
    assert.equal(b.killed, false);
    // And when the new one closes, the monitor does restart (on its timer).
    b.emit('close');
    fpsmon.reload();
    assert.equal(presentMons().length, 3);
  } finally {
    fpsmon.pauseFpsMonitor();   // not stop: that one is terminal and the next test needs the monitor
    Object.defineProperty(process, 'platform', realPlatform);
  }
});

// A game session reads the ring on the 3 s status tick. At 1000 FPS that is
// 3000 frames between two looks: every one must still be there, while the
// live lows keep their 2000-frame window.
test('a 3 s gap at 1000 FPS loses no frame; the live stats window stays 2000 frames', () => {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    fpsmon.resumeFpsMonitor();
    const p = presentMons()[presentMons().length - 1];
    const rows = (n) => p.stdout.emit('data', Buffer.from('fastgame.exe,4242,1.0\n'.repeat(n)));
    p.stdout.emit('data', Buffer.from('Application,ProcessID,MsBetweenPresents\n'));
    rows(1);
    const first = fpsmon.getFramesSince(null, 'fastgame');
    assert.ok(first.mark, 'the game is seen');
    rows(3000);
    const next = fpsmon.getFramesSince(first.mark, 'fastgame');
    assert.equal(next.frames.length, 3000);
    assert.equal(fpsmon.getFrameStats().count, 2000);
  } finally {
    fpsmon.stopFpsMonitor();
    Object.defineProperty(process, 'platform', realPlatform);
  }
});
