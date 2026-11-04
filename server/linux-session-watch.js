'use strict';
// Tells the server when Linux is about to shut down or go to sleep, and holds it
// there until the lights are dark: session-watch.js says why that matters. SIGTERM
// is no substitute. Sleep sends nothing at all, and a shutdown sends it to a server
// that would hand the headers back to the board, lit on standby power.
//
// logind announces both on the system bus and waits for whoever holds a "delay"
// inhibitor, at most InhibitDelayMaxSec (5 s by default), so nothing here can hold
// the PC up for longer. That inhibitor is a file descriptor Node cannot receive:
// systemd-inhibit keeps it around `cat`, which ends when its stdin closes, so a
// server that dies lets go of the PC with it.

const { spawn } = require('child_process');

const RESPAWN_MS = 15000;          // a tool that died is started again, never in a tight loop
const LOGIND = 'org.freedesktop.login1';
const MANAGER = LOGIND + '.Manager';
const LOCK_ARGS = ['--what=sleep:shutdown', '--who=Xenon', '--why=Turning the lights off', '--mode=delay', 'cat'];

const GDBUS_SIGNAL = /org\.freedesktop\.login1\.Manager\.(PrepareForSleep|PrepareForShutdown) \((true|false)/;
const DBUS_MONITOR_SIGNAL = /interface=org\.freedesktop\.login1\.Manager; member=(PrepareForSleep|PrepareForShutdown)\s*$/;
const DBUS_MONITOR_VALUE = /^\s*boolean (true|false)/;

// false is logind's "it did not happen after all" or "awake again".
function eventOf(member, starting) {
  if (!starting) return 'resume';
  return member === 'PrepareForSleep' ? 'suspend' : 'ending';
}

// One line of `gdbus monitor` -> the event it names, or null.
function gdbusParser() {
  return (line) => {
    const m = GDBUS_SIGNAL.exec(line);
    return m ? eventOf(m[1], m[2] === 'true') : null;
  };
}

// dbus-monitor prints a signal on one line and its boolean on the next.
function dbusMonitorParser() {
  let member = null;
  return (line) => {
    const head = DBUS_MONITOR_SIGNAL.exec(line);
    if (head) { member = head[1]; return null; }
    const value = member && DBUS_MONITOR_VALUE.exec(line);
    if (!value) return null;
    const ev = eventOf(member, value[1] === 'true');
    member = null;
    return ev;
  };
}

const signalRule = (member) => `type='signal',sender='${LOGIND}',interface='${MANAGER}',member='${member}'`;

// Neither ships on every distribution, and between them they cover the ones with
// systemd. busctl cannot do this: its monitor is root's on the system bus.
const MONITORS = [
  { cmd: 'gdbus', args: ['monitor', '--system', '--dest', LOGIND, '--object-path', '/org/freedesktop/login1'], parser: gdbusParser },
  { cmd: 'dbus-monitor', args: ['--system', signalRule('PrepareForSleep'), signalRule('PrepareForShutdown')], parser: dbusMonitorParser },
];

function createLinuxSessionWatch({ onEvent, spawnFn = spawn, log = console } = {}) {
  let wanted = false;
  let down = false;        // going off or to sleep: the delay stays released until "resume"
  let monitor = null;
  let lock = null;
  let tool = 0;            // the entry of MONITORS in use
  let monitorTimer = null;
  let lockTimer = null;
  const warned = new Set();

  function warnOnce(key, message) {
    if (warned.has(key)) return;
    warned.add(key);
    log.error('[session-watch] ' + message);
  }

  function takeLock() {
    if (!wanted || down || lock) return;
    let child;
    try {
      child = spawnFn('systemd-inhibit', LOCK_ARGS, { stdio: ['pipe', 'ignore', 'ignore'] });
    } catch (e) {
      lockLost(e);
      return;
    }
    lock = child;
    child.stdin.on('error', () => { /* broken pipe once it exits */ });
    child.on('error', (e) => { if (lock === child) { lock = null; lockLost(e); } });
    child.on('exit', () => { if (lock === child) { lock = null; lockLost(); } });
  }

  function lockLost(e) {
    warnOnce('lock', 'the PC will not wait for the lights to go off: systemd-inhibit ' + (e ? e.message : 'ended'));
    if (!wanted || lockTimer) return;
    lockTimer = setTimeout(() => { lockTimer = null; takeLock(); }, RESPAWN_MS);
    if (lockTimer.unref) lockTimer.unref();
  }

  function dropLock() {
    const child = lock;
    lock = null;
    if (!child) return;
    try { child.stdin.end(); } catch { /* already closed */ }
    try { child.kill(); } catch { /* already gone */ }
  }

  function handle(ev) {
    down = ev !== 'resume';
    if (!down) takeLock();
    Promise.resolve()
      .then(() => onEvent(ev))
      .catch((e) => log.error('[session-watch] ' + ev + ' failed: ' + e.message))
      .then(() => { if (down) dropLock(); });
  }

  function launchMonitor() {
    const { cmd, args, parser } = MONITORS[tool];
    let child;
    try {
      child = spawnFn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) {
      monitorLost(e);
      return;
    }
    monitor = child;
    const parse = parser();
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const ev = parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (ev && monitor === child) handle(ev);
      }
    });
    child.on('error', (e) => { if (monitor === child) { monitor = null; monitorLost(e); } });
    child.on('exit', () => { if (monitor === child) { monitor = null; monitorLost(); } });
  }

  // A tool that is not installed gives way to the next one at once; anything else,
  // or none left, waits.
  function monitorLost(e) {
    if (!wanted) return;
    if (e && e.code === 'ENOENT') {
      tool = (tool + 1) % MONITORS.length;
      if (tool !== 0) { launchMonitor(); return; }
      warnOnce('monitor', 'cannot see the PC going off: neither gdbus nor dbus-monitor is installed');
    }
    if (monitorTimer) return;
    monitorTimer = setTimeout(() => { monitorTimer = null; if (wanted && !monitor) launchMonitor(); }, RESPAWN_MS);
    if (monitorTimer.unref) monitorTimer.unref();
  }

  function start() {
    wanted = true;
    takeLock();
    if (!monitor && !monitorTimer) launchMonitor();
  }

  function stop() {
    wanted = false;
    down = false;
    clearTimeout(monitorTimer);
    clearTimeout(lockTimer);
    monitorTimer = null;
    lockTimer = null;
    dropLock();
    const child = monitor;
    monitor = null;
    if (child) { try { child.kill(); } catch { /* already gone */ } }
  }

  return { start, stop, running: () => !!monitor };
}

module.exports = { createLinuxSessionWatch, gdbusParser, dbusMonitorParser, LOCK_ARGS, MONITORS };
