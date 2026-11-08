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
    fpsmon.pauseFpsMonitor();   // not stop: the tests below need the monitor
    Object.defineProperty(process, 'platform', realPlatform);
  }
});

// The whole path: a game under a widget. The main session sends a few composed
// rows with huge gaps, the second session sends every frame, and the reading has
// to be the second one's, on the present side, with nothing counted twice.
test('a composed game is read from the session that sees all its frames', () => {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    fpsmon.setTrackedGame(() => ({ pid: 7777, name: 'biggame' }));
    fpsmon.resumeFpsMonitor();
    const main = presentMons()[presentMons().length - 1];
    const before = presentMons().length;
    main.stdout.emit('data', Buffer.from('Application,ProcessID,PresentMode,msBetweenPresents,msBetweenDisplayChange\n'));
    main.stdout.emit('data', Buffer.from('biggame.exe,7777,Composed: Flip,120.0,120.0\n'.repeat(3)));
    assert.equal(fpsmon.getCurrentFps(), 8, 'the sparse reading, before the second session answers');

    assert.equal(presentMons().length, before + 1, 'one second session');
    const game = presentMons()[before];
    const at = game.args.indexOf('-process_id');
    assert.deepEqual(game.args.slice(at, at + 2), ['-process_id', '7777']);
    assert.ok(game.args.includes('-no_track_display'), 'the display tracking is what loses the rows');
    assert.ok(game.args.includes('-terminate_on_proc_exit'));
    assert.equal(game.args[game.args.indexOf('-session_name') + 1], 'XenonFpsGame', 'never the main session');

    game.stdout.emit('data', Buffer.from('Application,ProcessID,msBetweenPresents\n'));
    game.stdout.emit('data', Buffer.from('biggame.exe,7777,4.0\n'.repeat(500)));
    assert.equal(fpsmon.getCurrentFps(), 250);
    const stats = fpsmon.getFrameStats();
    assert.equal(stats.side, 'present');
    assert.ok(stats.low1Fps > 200, `the sparse rows must not read as stutter, got ${stats.low1Fps}`);

    // Rows the main session still sends are not counted on top.
    const { mark } = fpsmon.getFramesSince(null, 'biggame');
    main.stdout.emit('data', Buffer.from('biggame.exe,7777,Composed: Flip,120.0,120.0\n'));
    assert.equal(fpsmon.getFramesSince(mark, 'biggame').frames.length, 0);
    game.stdout.emit('data', Buffer.from('biggame.exe,7777,4.0\n'.repeat(10)));
    assert.equal(fpsmon.getFramesSince(mark, 'biggame').frames.length, 10);

    fpsmon.pauseFpsMonitor();
    assert.equal(game.killed, true, 'it goes with the main session');
    assert.ok(spawned.some((p) => /logman/i.test(p.exe) && p.args.includes('XenonFpsGame')), 'its trace is stopped too');
  } finally {
    fpsmon.setTrackedGame(null);
    fpsmon.pauseFpsMonitor();
    Object.defineProperty(process, 'platform', realPlatform);
  }
});

test('a game on a flip mode needs no second session', () => {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    fpsmon.setTrackedGame(() => ({ pid: 8888, name: 'flipgame' }));
    fpsmon.resumeFpsMonitor();
    const main = presentMons()[presentMons().length - 1];
    const before = presentMons().length;
    main.stdout.emit('data', Buffer.from('Application,ProcessID,PresentMode,msBetweenPresents,msBetweenDisplayChange\n'));
    main.stdout.emit('data', Buffer.from('flipgame.exe,8888,Hardware Composed: Independent Flip,4.0,4.0\n'.repeat(5)));
    main.stdout.emit('data', Buffer.from('notepad.exe,9999,Composed: Flip,16.0,16.0\n'.repeat(5)));
    assert.equal(presentMons().length, before, 'neither the game nor a desktop app');
  } finally {
    fpsmon.setTrackedGame(null);
    fpsmon.pauseFpsMonitor();
    Object.defineProperty(process, 'platform', realPlatform);
  }
});

test('the main PresentMon ending writes why to server.log', () => {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  const warned = [];
  const realWarn = console.warn;
  console.warn = (line) => { warned.push(String(line)); };
  try {
    fpsmon.resumeFpsMonitor();
    const p = presentMons()[presentMons().length - 1];
    // Rows came, so this end is news: the log stays quiet through retries.
    p.stdout.emit('data', Buffer.from('Application,ProcessID,msBetweenPresents\nsomegame.exe,4343,4.0\n'));
    p.stderr.emit('data', Buffer.from('error: failed to start trace session (error=1450).\n'));
    p.emit('close', 6, null);
    const line = 'fps: PresentMon ended after 0 s (code 6, error: failed to start trace session (error=1450).), starting it again';
    assert.ok(warned.includes(line), warned.join('\n'));
  } finally {
    console.warn = realWarn;
    fpsmon.pauseFpsMonitor();
    Object.defineProperty(process, 'platform', realPlatform);
  }
});
