// Lights left on with the PC off, the Linux side of the report in
// session-watch.test.mjs: sleep sends node nothing, and SIGTERM at a shutdown comes
// too late. logind's signals and its delay inhibitor are what the server gets
// instead; tools/linux-rgb-vm runs this against a real logind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLinuxSessionWatch, gdbusParser, dbusMonitorParser, LOCK_ARGS, MONITORS } = require('../linux-session-watch.js');
const { createSessionWatch } = require('../session-watch.js');

const RESPAWN_MS = 15000;
const GDBUS = (member, value) => `/org/freedesktop/login1: org.freedesktop.login1.Manager.${member} (${value},)\n`;

function fakeSpawn({ missing = [], throws = [] } = {}) {
  const spawned = [];
  const fn = (cmd, args, opts) => {
    if (throws.includes(cmd)) throw new Error('cannot spawn ' + cmd);
    const child = new EventEmitter();
    Object.assign(child, { cmd, args, opts, killed: false, ended: false });
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stdin = new EventEmitter();
    child.stdin.end = () => { child.ended = true; };
    child.kill = () => { child.killed = true; };
    spawned.push(child);
    if (missing.includes(cmd)) queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
    return child;
  };
  return {
    fn, spawned,
    of: (cmd) => spawned.filter(c => c.cmd === cmd),
    last: (cmd) => spawned.filter(c => c.cmd === cmd).at(-1),
  };
}

const settle = () => new Promise(r => setImmediate(r));
const quietLog = () => { const errors = []; return { errors, error: (m) => errors.push(m) }; };

function watch(opts = {}) {
  const sp = fakeSpawn(opts);
  const events = [];
  const log = quietLog();
  const w = createLinuxSessionWatch({ onEvent: opts.onEvent || ((ev) => { events.push(ev); }), spawnFn: sp.fn, log });
  return { sp, events, log, w };
}

test('gdbus lines name the four things logind says', () => {
  const parse = gdbusParser();
  assert.equal(parse(GDBUS('PrepareForSleep', 'true')), 'suspend');
  assert.equal(parse(GDBUS('PrepareForSleep', 'false')), 'resume');
  assert.equal(parse(GDBUS('PrepareForShutdown', 'true')), 'ending');
  assert.equal(parse(GDBUS('PrepareForShutdown', 'false')), 'resume');
});

test('every other gdbus line is nothing, the shutdown with metadata included', () => {
  const parse = gdbusParser();
  for (const line of [
    'The name org.freedesktop.login1 is owned by :1.4',
    "/org/freedesktop/login1: org.freedesktop.login1.Manager.SessionNew ('3', objectpath '/org/freedesktop/login1/session/_33')",
    "/org/freedesktop/login1: org.freedesktop.login1.Manager.PrepareForShutdownWithMetadata (true, {'type': <'poweroff'>})",
    '', 'true',
  ]) assert.equal(parse(line), null);
});

test('dbus-monitor gives the signal on one line and its value on the next', () => {
  const head = (member) => `signal time=1.2 sender=:1.4 -> destination=(null destination) serial=9 path=/org/freedesktop/login1; interface=org.freedesktop.login1.Manager; member=${member}`;
  const parse = dbusMonitorParser();
  assert.equal(parse(head('PrepareForSleep')), null);
  assert.equal(parse('   boolean true'), 'suspend');
  assert.equal(parse(head('PrepareForSleep')), null);
  assert.equal(parse('   boolean false'), 'resume');
  assert.equal(parse(head('PrepareForShutdown')), null);
  assert.equal(parse('   boolean true'), 'ending');
  assert.equal(parse(head('PrepareForShutdownWithMetadata')), null);
  assert.equal(parse('   boolean true'), null);
  assert.equal(parse('   boolean true'), null);
});

test('the PC is held in delay mode only, for sleep and shutdown, by a child that ends with the server', () => {
  assert.ok(LOCK_ARGS.includes('--mode=delay'));
  assert.ok(LOCK_ARGS.includes('--what=sleep:shutdown'));
  assert.equal(LOCK_ARGS.at(-1), 'cat');
});

test('both tools run from an argv array, never a shell, and only the lock has a stdin', () => {
  const { sp, w } = watch();
  w.start();
  const lock = sp.last('systemd-inhibit');
  const monitor = sp.last('gdbus');
  assert.deepEqual(lock.args, LOCK_ARGS);
  assert.equal(lock.opts.stdio[0], 'pipe');
  assert.deepEqual(monitor.args, MONITORS[0].args);
  assert.equal(monitor.opts.stdio[0], 'ignore');
  assert.equal(lock.opts.shell, undefined);
  assert.equal(monitor.opts.shell, undefined);
  assert.equal(w.running(), true);
  w.stop();
});

test('going to sleep: the lock stays until the lights are dark, and comes back on waking', async () => {
  let finish;
  const events = [];
  const { sp, w } = watch({ onEvent: (ev) => { events.push(ev); return ev === 'suspend' ? new Promise(r => { finish = r; }) : undefined; } });
  w.start();
  const lock = sp.last('systemd-inhibit');
  sp.last('gdbus').stdout.emit('data', GDBUS('PrepareForSleep', 'true'));
  await settle();
  assert.deepEqual(events, ['suspend']);
  assert.equal(lock.ended, false);
  finish();
  await settle();
  assert.equal(lock.ended, true);
  assert.equal(lock.killed, true);
  lock.emit('exit');
  await settle();
  assert.equal(sp.of('systemd-inhibit').length, 1);

  sp.last('gdbus').stdout.emit('data', GDBUS('PrepareForSleep', 'false'));
  await settle();
  assert.deepEqual(events, ['suspend', 'resume']);
  assert.equal(sp.of('systemd-inhibit').length, 2);
  assert.equal(sp.last('systemd-inhibit').killed, false);
  w.stop();
});

test('a shutdown holds the same way, and a cancelled one takes the lock back', async () => {
  const { sp, events, w } = watch();
  w.start();
  sp.last('gdbus').stdout.emit('data', GDBUS('PrepareForShutdown', 'true'));
  await settle();
  assert.deepEqual(events, ['ending']);
  assert.equal(sp.last('systemd-inhibit').killed, true);
  sp.last('gdbus').stdout.emit('data', GDBUS('PrepareForShutdown', 'false'));
  await settle();
  assert.deepEqual(events, ['ending', 'resume']);
  assert.equal(sp.of('systemd-inhibit').length, 2);
  w.stop();
});

test('a line split across two reads still counts, once', async () => {
  const { sp, events, w } = watch();
  w.start();
  const line = GDBUS('PrepareForSleep', 'true');
  sp.last('gdbus').stdout.emit('data', line.slice(0, 20));
  await settle();
  assert.deepEqual(events, []);
  sp.last('gdbus').stdout.emit('data', line.slice(20));
  await settle();
  assert.deepEqual(events, ['suspend']);
  w.stop();
});

test('a failed blackout still lets go of the PC, and says so', async () => {
  const { sp, log, w } = watch({ onEvent: () => { throw new Error('usb gone'); } });
  w.start();
  sp.last('gdbus').stdout.emit('data', GDBUS('PrepareForSleep', 'true'));
  await settle();
  assert.equal(sp.last('systemd-inhibit').killed, true);
  assert.match(log.errors.join(), /suspend failed: usb gone/);
  w.stop();
});

test('waking while the blackout still runs keeps the lock', async () => {
  let finish;
  const { sp, w } = watch({ onEvent: (ev) => (ev === 'suspend' ? new Promise(r => { finish = r; }) : undefined) });
  w.start();
  const lock = sp.last('systemd-inhibit');
  sp.last('gdbus').stdout.emit('data', GDBUS('PrepareForSleep', 'true') + GDBUS('PrepareForSleep', 'false'));
  await settle();
  finish();
  await settle();
  assert.equal(lock.killed, false);
  assert.equal(sp.of('systemd-inhibit').length, 1);
  w.stop();
});

test('without gdbus the same events come from dbus-monitor', async () => {
  const { sp, events, w } = watch({ missing: ['gdbus'] });
  w.start();
  await settle();
  const monitor = sp.last('dbus-monitor');
  assert.deepEqual(monitor.args, MONITORS[1].args);
  monitor.stdout.emit('data', 'signal time=1.2 sender=:1.4 -> destination=(null destination) serial=9 path=/org/freedesktop/login1; interface=org.freedesktop.login1.Manager; member=PrepareForSleep\n   boolean true\n');
  await settle();
  assert.deepEqual(events, ['suspend']);
  w.stop();
});

test('with neither tool it says so once and never spins', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { sp, log, w } = watch({ missing: ['gdbus', 'dbus-monitor'] });
  w.start();
  await settle();
  assert.equal(sp.of('gdbus').length, 1);
  assert.equal(sp.of('dbus-monitor').length, 1);
  assert.equal(w.running(), false);
  t.mock.timers.tick(RESPAWN_MS);
  await settle();
  assert.equal(sp.of('gdbus').length, 2);
  assert.equal(log.errors.filter(m => /neither gdbus nor dbus-monitor/.test(m)).length, 1);
  w.stop();
});

test('a monitor that dies comes back after a pause, not in a loop', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { sp, w } = watch();
  w.start();
  sp.last('gdbus').emit('exit');
  assert.equal(sp.of('gdbus').length, 1);
  assert.equal(w.running(), false);
  t.mock.timers.tick(RESPAWN_MS);
  assert.equal(sp.of('gdbus').length, 2);
  assert.equal(w.running(), true);
  w.stop();
});

test('a lock refused by logind is retried after a pause and reported once', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { sp, log, w } = watch();
  w.start();
  sp.last('systemd-inhibit').emit('exit');
  assert.equal(sp.of('systemd-inhibit').length, 1);
  t.mock.timers.tick(RESPAWN_MS);
  assert.equal(sp.of('systemd-inhibit').length, 2);
  sp.last('systemd-inhibit').emit('exit');
  t.mock.timers.tick(RESPAWN_MS);
  assert.equal(sp.of('systemd-inhibit').length, 3);
  assert.equal(log.errors.filter(m => /will not wait for the lights/.test(m)).length, 1);
  w.stop();
});

test('a spawn that throws is handled like a tool that died', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { sp, log, w } = watch({ throws: ['systemd-inhibit', 'gdbus'] });
  assert.doesNotThrow(() => w.start());
  assert.equal(sp.spawned.length, 0);
  assert.match(log.errors.join(), /cannot spawn systemd-inhibit/);
  w.stop();
});

test('stop ends both children, and nothing comes back', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { sp, w } = watch();
  w.start();
  const lock = sp.last('systemd-inhibit');
  const monitor = sp.last('gdbus');
  w.stop();
  assert.equal(lock.ended, true);
  assert.equal(lock.killed, true);
  assert.equal(monitor.killed, true);
  assert.equal(w.running(), false);
  lock.emit('exit');
  monitor.emit('exit');
  t.mock.timers.tick(RESPAWN_MS * 2);
  assert.equal(sp.spawned.length, 2);
});

test('starting twice does not start anything twice', () => {
  const { sp, w } = watch();
  w.start();
  w.start();
  assert.equal(sp.of('systemd-inhibit').length, 1);
  assert.equal(sp.of('gdbus').length, 1);
  w.stop();
});

test('stopped mid-blackout, a late answer touches nothing', async () => {
  let finish;
  const { sp, w } = watch({ onEvent: () => new Promise(r => { finish = r; }) });
  w.start();
  sp.last('gdbus').stdout.emit('data', GDBUS('PrepareForSleep', 'true'));
  await settle();
  w.stop();
  finish();
  await settle();
  assert.equal(sp.of('systemd-inhibit').length, 1);
});

test('session-watch hands Linux to this watcher', () => {
  const sp = fakeSpawn();
  const w = createSessionWatch({ onEvent: () => {}, platform: 'linux', spawnFn: sp.fn, log: quietLog() });
  w.start();
  assert.deepEqual(sp.spawned.map(c => c.cmd).sort(), ['gdbus', 'systemd-inhibit']);
  w.stop();
});
