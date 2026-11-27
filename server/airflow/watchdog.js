'use strict';
// Airflow's watchdog: a small separate process that puts the fans back if the engine
// dies. Used where the engine writes the hardware itself (Linux pwm files); on Windows
// the sensor service holds the fans and hands them back on its own when the command
// names stop.
//
// The engine tells it, one JSON line at a time on its stdin, the original values of
// each channel it takes ('hold') and gives back ('free'). When that pipe closes (the
// engine exited, crashed or was killed) or the watchdog is told to stop by a signal,
// it writes every original still held back and exits. A clean exit hands everything
// back first, so the watchdog then has nothing left to do. An engine that is alive but
// hangs is caught too: it sends a line at every write of the fans ('beat'), and after
// LEASE_MS without one the originals go back, kept in case the engine wakes.
//
// It writes only pwm files under the hwmon root it was started with, only whole
// numbers 0-255, whatever a line says.
const fs = require('fs');
const childProcess = require('child_process');
const { isPwmFile, ROOT } = require('./driver-hwmon.js');

const MAX_HELD = 64;
const MAX_LINE = 4096;
const MAX_PAIRS = 4;
// A watchdog that keeps dying is not restarted more often than this.
const RESPAWN_MS = 5000;
const LEASE_MS = 15000;

/** The child's state: what to write back, and the rule for what it accepts. */
function createKeeper(root, write) {
  const held = new Map();

  function handle(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return false; }
    const id = msg?.id;
    if (typeof id !== 'string' || !id || id.length > 120) return false;
    if (msg.op === 'free') return held.delete(id);
    if (msg.op !== 'hold' || !Array.isArray(msg.restore) || !msg.restore.length || msg.restore.length > MAX_PAIRS) return false;
    const pairs = msg.restore.filter((p) => Array.isArray(p) && isPwmFile(root, p[0]) && Number.isInteger(p[1]) && p[1] >= 0 && p[1] <= 255);
    if (pairs.length !== msg.restore.length) return false;
    if (!held.has(id) && held.size >= MAX_HELD) return false;
    held.set(id, pairs);
    return true;
  }

  function restoreAll(keep = false) {
    for (const pairs of held.values()) {
      for (const [file, value] of pairs) {
        try { write(file, String(value)); } catch { /* the next one may still go back */ }
      }
    }
    if (!keep) held.clear();
  }

  return { handle, restoreAll, size: () => held.size };
}

// The child process. Synchronous writes on purpose: it is a separate process with
// nothing else to serve, and it is about to exit.
function runChild(root) {
  const keeper = createKeeper(root, (file, value) => fs.writeFileSync(file, value));
  let buf = '';
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    keeper.restoreAll();
    process.exit(0);
  };
  process.stdin.setEncoding('utf8');
  let last = Date.now();
  let lapsed = false;
  setInterval(() => {
    if (lapsed || !keeper.size() || Date.now() - last < LEASE_MS) return;
    lapsed = true;
    keeper.restoreAll(true);
  }, 1000);
  process.stdin.on('data', (chunk) => {
    last = Date.now();
    lapsed = false;
    buf += chunk;
    let i = buf.indexOf('\n');
    while (i >= 0) {
      keeper.handle(buf.slice(0, i));
      buf = buf.slice(i + 1);
      i = buf.indexOf('\n');
    }
    if (buf.length > MAX_LINE) buf = '';
  });
  process.stdin.on('end', finish);
  process.stdin.on('close', finish);
  process.stdin.on('error', finish);
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, finish);
}

/**
 * The engine's side: starts the watchdog and keeps it up. If it dies, a new one is
 * started and told again what is held.
 * @param {{ root?: string, spawn?: typeof childProcess.spawn, node?: string, now?: () => number }} [opts]
 */
function startWatchdog({ root = ROOT, spawn = childProcess.spawn, node = process.execPath, now = Date.now } = {}) {
  const held = new Map();
  let child = null;
  let startedAt = 0;
  let stopped = false;

  const send = (msg) => {
    if (child?.stdin?.writable) child.stdin.write(`${JSON.stringify(msg)}\n`);
  };

  function start() {
    if (stopped || now() - startedAt < RESPAWN_MS) return;
    startedAt = now();
    const c = spawn(node, [__filename, '--child', root], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    child = c;
    c.on('error', () => { if (child === c) child = null; });
    c.stdin.on('error', () => {});
    c.on('exit', () => { if (child === c) child = null; });
    for (const [id, restore] of held) send({ op: 'hold', id, restore });
  }

  return {
    hold(id, restore) {
      held.set(id, restore);
      // A new watchdog is told everything held as it starts, this one included.
      if (child) send({ op: 'hold', id, restore });
      else start();
    },
    free(id) {
      held.delete(id);
      send({ op: 'free', id });
    },
    /** The engine wrote the fans just now: the watchdog's lease starts again. */
    beat() { send({ op: 'beat' }); },
    /** Whether a watchdog is up (the loop starts one again when it is not). */
    alive() {
      if (!child && held.size) start();
      return !!child;
    },
    /** Engine shutting down: whatever is still held goes back as the pipe closes. */
    stop() {
      stopped = true;
      child?.stdin?.end();
      child = null;
    },
  };
}

if (require.main === module && process.argv[2] === '--child' && process.argv[3]) runChild(process.argv[3]);

module.exports = { startWatchdog, createKeeper, MAX_HELD, LEASE_MS };
