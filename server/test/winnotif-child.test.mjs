// winnotif.js: the reader's own process. It runs only while it is wanted, it is started again
// after it ends (slowly after three quick ends in a row, and without the helper once the
// helper is what keeps ending), and a reader that was replaced can no longer feed or restart
// anything. The process, the clock and the timers are the test's own.
import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const cp = require('child_process');
const fs = require('fs');
const linuxNotif = require('../linux-notif.js');
const spawned = [];
let refuse = false;
const realSpawn = cp.spawn;
cp.spawn = (exe, args) => {
  if (refuse) throw new Error('refused');
  const p = new EventEmitter();
  Object.assign(p, { exe, args, pid: 0, stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: new EventEmitter(), killed: false, ended: false, written: [] });
  p.stdin.end = () => { p.ended = true; };
  p.stdin.write = (text) => { p.written.push(text); };
  p.kill = () => { p.killed = true; };
  spawned.push(p);
  return p;
};
const winnotif = require('../winnotif.js');
cp.spawn = realSpawn;

// The waits of winnotif.js: after an end, and after three quick ends in a row.
const SHORT = 5000;
const LONG = 60000;
const START = Date.UTC(2026, 0, 15, 10, 0, 0);
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const realExists = fs.existsSync;
const realFind = linuxNotif.findDbusMonitor;
const lineOf = (message) => `${JSON.stringify(message)}\n`;
const last = () => spawned.at(-1);
let helperThere;
let feeds;

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  fs.existsSync = (file) => (/xenon-helper\.exe$/.test(String(file)) ? helperThere : realExists(file));
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: START });
  helperThere = true;
  refuse = false;
  feeds = 0;
  spawned.length = 0;
  winnotif.init({ onFeed: () => { feeds += 1; } });
});

afterEach(() => {
  winnotif.sync(false);
  mock.timers.reset();
  fs.existsSync = realExists;
  linuxNotif.findDbusMonitor = realFind;
  Object.defineProperty(process, 'platform', realPlatform);
});

test('the reader runs only while it is wanted, and leaves nothing behind when it is not', () => {
  winnotif.sync(true);
  winnotif.sync(true);
  assert.equal(spawned.length, 1, 'asked twice, started once');
  const reader = last();
  assert.match(reader.exe, /xenon-helper\.exe$/);
  assert.deepEqual(reader.args, ['notifications-serve', '2000']);
  assert.equal(winnotif.getState(), 'starting');
  // A line may arrive in two pieces: it counts when its end arrives.
  reader.stdout.emit('data', Buffer.from('{"event":"status","sta'));
  assert.equal(winnotif.getState(), 'starting');
  reader.stdout.emit('data', Buffer.from(`tus":"allowed"}\n${lineOf({ event: 'seed', items: [{ id: 1, app: 'Mail', title: 'Hello', body: 'First line' }] })}`));
  assert.equal(winnotif.getState(), 'allowed');
  assert.equal(winnotif.getFeed().length, 1);
  assert.equal(feeds, 2);
  winnotif.sync(false);
  assert.equal(reader.ended, true);
  assert.equal(reader.killed, true);
  assert.equal(winnotif.getState(), 'off');
  assert.deepEqual(winnotif.getFeed(), [], 'notification text is not kept while nobody watches');
  assert.equal(feeds, 3);
  reader.emit('close');
  mock.timers.tick(LONG);
  assert.equal(spawned.length, 1, 'a reader that was stopped on purpose is not started again');
});

test('a reader that ends is started again after a short wait, and the old one is ignored from then on', () => {
  winnotif.sync(true);
  const first = last();
  mock.timers.tick(3000);
  first.emit('close');
  mock.timers.tick(SHORT - 1);
  assert.equal(spawned.length, 1);
  mock.timers.tick(1);
  assert.equal(spawned.length, 2);
  first.stdout.emit('data', Buffer.from(lineOf({ event: 'seed', items: [{ id: 1, app: 'Mail', title: 'Late', body: '' }] })));
  assert.deepEqual(winnotif.getFeed(), [], 'the replaced reader feeds nothing');
  first.emit('close');
  first.emit('error', new Error('late'));
  mock.timers.tick(LONG);
  assert.equal(spawned.length, 2, 'and its end starts no third reader');
});

test('a slower pace is told to the running helper once per change', () => {
  winnotif.sync(true);
  const reader = last();
  winnotif.setPace(true);
  winnotif.setPace(true);
  assert.deepEqual(reader.written, ['5000\n']);
  winnotif.setPace(false);
  assert.deepEqual(reader.written, ['5000\n', '2000\n']);
});

test('a reader that cannot be started is tried again after the wait', () => {
  refuse = true;
  winnotif.sync(true);
  assert.equal(spawned.length, 0);
  refuse = false;
  mock.timers.tick(SHORT);
  assert.equal(spawned.length, 1);
});

test('three quick ends of the helper pin the PowerShell reader, and three more slow the restarts', () => {
  winnotif.sync(true);
  last().stdout.emit('data', Buffer.from(lineOf({ event: 'status', status: 'allowed' })));   // data: the count of quick ends starts at zero
  for (let ends = 1; ends <= 3; ends += 1) {
    assert.match(last().exe, /xenon-helper\.exe$/, `start ${ends} still uses the helper`);
    last().emit('close');
    mock.timers.tick(SHORT);
    assert.equal(spawned.length, ends + 1);
  }
  const fallback = last();
  assert.equal(fallback.exe, 'powershell.exe');
  assert.match(fallback.args[fallback.args.indexOf('-File') + 1], /notifications\.ps1$/);
  fallback.emit('close');
  mock.timers.tick(SHORT);
  last().emit('close');
  mock.timers.tick(SHORT);
  assert.equal(spawned.length, 6);
  last().emit('close');
  mock.timers.tick(SHORT);
  assert.equal(spawned.length, 6, 'the third quick end in a row waits the long time');
  mock.timers.tick(LONG - SHORT);
  assert.equal(spawned.length, 7);
  assert.equal(last().exe, 'powershell.exe', 'the helper stays pinned out');
});

test('on Linux the reader is dbus-monitor, and without it nothing is started or retried', () => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  linuxNotif.findDbusMonitor = () => null;
  winnotif.sync(true);
  assert.equal(spawned.length, 0);
  assert.equal(winnotif.getState(), 'unavailable');
  mock.timers.tick(LONG);
  assert.equal(spawned.length, 0, 'a missing program does not appear on a timer');
  linuxNotif.findDbusMonitor = () => '/usr/bin/dbus-monitor';
  winnotif.sync(true);
  assert.equal(spawned.length, 1);
  assert.equal(last().exe, '/usr/bin/dbus-monitor');
  assert.deepEqual(last().args, linuxNotif.MONITOR_ARGS);
  assert.equal(winnotif.getState(), 'allowed', 'the session bus needs no permission');
  mock.timers.tick(3000);
  last().emit('close');
  mock.timers.tick(SHORT);
  assert.equal(spawned.length, 2);
});

// Last: stop is final for this process.
test('after stop the reader is gone and is never started again', () => {
  winnotif.sync(true);
  const reader = last();
  winnotif.stop();
  assert.equal(reader.killed, true);
  assert.equal(winnotif.getState(), 'off');
  reader.emit('close');
  winnotif.sync(true);
  mock.timers.tick(LONG);
  assert.equal(spawned.length, 1);
});
