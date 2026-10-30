'use strict';
// Tells the server when Windows is about to shut down, restart, sign out or go
// to sleep. Node gets no signal for any of these on Windows (libuv maps only
// Ctrl+C, Ctrl+Break and closing the console), so _gracefulShutdown never runs
// at a real shutdown, and what it undoes stays as it was on standby power.
// Today that is the lights Xenon drives itself: a GIGABYTE controller left in
// Xenon's direct mode kept its last frame, lit and flickering, with the PC off.
//
// session-watch.ps1 owns the hidden window Windows asks first; it reports one
// word per event and holds Windows (bounded) until we answer "done". Windows
// only: on macOS and Linux a shutdown sends SIGTERM, which is already handled.

const { spawn } = require('child_process');
const path = require('path');

const SCRIPT = path.join(__dirname, 'session-watch.ps1');
const RESPAWN_MS = 15000;          // a host that died is started again, never in a tight loop
const EVENTS = new Set(['ending', 'suspend', 'resume']);
const NEEDS_ACK = new Set(['ending', 'suspend']);

// One stdout line -> the event it names, or null for anything else.
function parseEvent(line) {
  const word = String(line == null ? '' : line).trim();
  return EVENTS.has(word) ? word : null;
}

// onEvent(word) may return a promise; "done" is sent once it settles (the host
// stops waiting by itself if it never does).
function createSessionWatch({ onEvent, platform = process.platform, spawnFn = spawn, log = console } = {}) {
  let proc = null;
  let wanted = false;
  let respawnTimer = null;

  function handleLine(child, line) {
    const ev = parseEvent(line);
    if (!ev) return;
    Promise.resolve()
      .then(() => onEvent(ev))
      .catch((e) => log.error('[session-watch] ' + ev + ' failed: ' + e.message))
      .then(() => {
        if (NEEDS_ACK.has(ev) && proc === child) {
          try { child.stdin.write('done\n'); } catch { /* the host is already gone */ }
        }
      });
  }

  function launch() {
    let child;
    try {
      child = spawnFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch (e) {
      log.error('[session-watch] could not start: ' + e.message);
      scheduleRespawn();
      return;
    }
    proc = child;
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        handleLine(child, buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    child.stdin.on('error', () => { /* broken pipe once the host exits */ });
    child.on('error', (e) => log.error('[session-watch] ' + e.message));
    child.on('exit', () => {
      if (proc !== child) return;
      proc = null;
      scheduleRespawn();
    });
  }

  function scheduleRespawn() {
    if (!wanted || respawnTimer) return;
    respawnTimer = setTimeout(() => { respawnTimer = null; if (wanted && !proc) launch(); }, RESPAWN_MS);
    if (respawnTimer.unref) respawnTimer.unref();
  }

  function start() {
    if (platform !== 'win32') return;
    wanted = true;
    if (!proc && !respawnTimer) launch();
  }

  function stop() {
    wanted = false;
    clearTimeout(respawnTimer);
    respawnTimer = null;
    const child = proc;
    proc = null;
    if (!child) return;
    // Closing stdin ends the host on its own; kill() covers one that is stuck.
    try { child.stdin.end(); } catch { /* already closed */ }
    try { child.kill(); } catch { /* already gone */ }
  }

  return { start, stop, running: () => !!proc };
}

module.exports = { createSessionWatch, parseEvent, SCRIPT };
