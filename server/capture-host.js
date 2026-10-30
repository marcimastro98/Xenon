'use strict';
// The capture engine (apps/capture, `xenon-capture serve`), started on the
// first request and spoken to in JSON lines over stdio. It exits by itself after
// a minute without requests (and when its stdin closes), so a screenshot now and
// then costs one short-lived process, not a resident one; the next request
// starts it again.
//
// Requests are answered in order, matched by id. A request that gets no answer
// in time kills the engine (it is stuck, and nothing else would unstick it); an
// engine that dies three times in a minute is left alone for a minute instead
// of being respawned in a loop. Argv only, never a shell.
//
// Lines without an id are events the engine sends by itself (a recording that
// ended on its own: `{ event: 'record_ended', reason, ... }`); `onEvent`
// listeners get them, and a synthetic `{ event: 'engine_exited' }` whenever
// the engine goes away, so a recording never waits on an engine that is gone.
//
// Not every engine can do everything: the macOS one records through
// ScreenCaptureKit (sound, timelapse, tuning, Instant Replay and the webcam
// bubble on a current macOS), records steps without a pill, and has no drawing. `has(feature)` says
// what this one can do: the list for this OS until the engine answers a ping
// with its own (an engine older than the list answers without one). The Linux
// engine drives the session's own tools (grim, maim, ffmpeg, tesseract...), so
// what it can do depends on what is installed: it starts with nothing and is
// asked again each time it starts, so a tool installed later shows up.

const fs = require('fs');
const { spawn: defaultSpawn } = require('child_process');

const REQUEST_TIMEOUT_MS = 15000;
const CRASH_WINDOW_MS = 60000;
const CRASH_LIMIT = 3;
const MAX_LINE = 1024 * 1024;

const WINDOWS_FEATURES = Object.freeze([
  'screenshot', 'region', 'window', 'record', 'mic', 'sound', 'webcam', 'lapse', 'replay',
  'ocr', 'thumb', 'trim', 'copy_files', 'pick_folder', 'speech', 'export', 'cover', 'inspect',
  'measure', 'draw', 'steps', 'tuning', 'badge',
]);
const MAC_FEATURES = Object.freeze([
  'screenshot', 'region', 'window', 'record', 'mic', 'sound', 'lapse', 'ocr',
  'thumb', 'trim', 'copy_files', 'pick_folder', 'speech', 'tuning', 'export',
  'cover', 'inspect', 'measure', 'replay', 'webcam', 'steps',
]);
const FEATURES_BY_PLATFORM = Object.freeze({ win32: WINDOWS_FEATURES, darwin: MAC_FEATURES, linux: [] });
// Where the engine's own answer is the only truth (see the top of the file).
const PING_ON_START = new Set(['linux']);
const FEATURE_NAME = /^[a-z_]{1,32}$/;

function createCaptureHost({
  exe, platform = process.platform, spawn = defaultSpawn, existsSync = fs.existsSync,
  now = Date.now, timers = { setTimeout, clearTimeout }, log = () => {},
} = {}) {
  let proc = null;
  let buf = '';
  let nextId = 1;
  const pending = new Map(); // id → { resolve, timer }
  const pings = new Set();   // ids of pings, whose answer lists the features
  let crashes = [];
  let stopped = false;
  const listeners = new Set();
  let features = new Set(FEATURES_BY_PLATFORM[platform] || []);

  function emit(event) {
    for (const fn of listeners) {
      try { fn(event); } catch (e) { log(`[capture] event listener: ${e.message}`); }
    }
  }

  function available() {
    if (!FEATURES_BY_PLATFORM[platform]) return false;
    try { return !!exe && existsSync(exe); } catch { return false; }
  }

  function settle(id, reply) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    pings.delete(id);
    timers.clearTimeout(p.timer);
    p.resolve(reply);
  }

  function failAll(error) {
    for (const id of [...pending.keys()]) settle(id, { ok: false, error });
  }

  function onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (!Number.isInteger(msg.id)) {
      if (typeof msg.event === 'string') emit(msg);
      return;
    }
    if (msg.ok === false && msg.detail) log(`[capture] ${msg.error}: ${msg.detail}`);
    if (pings.delete(msg.id) && msg.ok !== false && Array.isArray(msg.features)) {
      features = new Set(msg.features.filter(f => typeof f === 'string' && FEATURE_NAME.test(f)));
    }
    settle(msg.id, msg);
  }

  function onData(chunk) {
    buf += chunk;
    if (buf.length > MAX_LINE) { buf = ''; return; }
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onLine(line);
    }
  }

  function onExit(child, code) {
    if (proc !== child) return;
    proc = null;
    buf = '';
    // An exit with requests still waiting is a crash; an idle exit is the plan.
    if (pending.size) {
      crashes = crashes.filter(t => now() - t < CRASH_WINDOW_MS).concat(now());
      log(`[capture] engine exited (${code}) with ${pending.size} request(s) waiting`);
    }
    failAll('engine_exited');
    emit({ event: 'engine_exited', code });
  }

  function start() {
    let child;
    try {
      child = spawn(exe, ['serve'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (e) {
      log(`[capture] spawn failed: ${e.message}`);
      return null;
    }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', onData);
    child.on('error', (e) => { log(`[capture] ${e.message}`); onExit(child, -1); });
    child.on('exit', (code) => onExit(child, code));
    // A closed pipe surfaces as an exit; this only keeps EPIPE from throwing.
    child.stdin.on('error', () => {});
    return child;
  }

  function failing() {
    crashes = crashes.filter(t => now() - t < CRASH_WINDOW_MS);
    return crashes.length >= CRASH_LIMIT;
  }

  // Resolves with the engine's reply object, never rejects: { ok, ...} or
  // { ok: false, error } with error one of the engine's codes or
  // unavailable / engine_failing / engine_exited / timeout / stopped.
  function request(cmd, body = {}, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    if (stopped) return Promise.resolve({ ok: false, error: 'stopped' });
    if (!available()) return Promise.resolve({ ok: false, error: 'unavailable' });
    if (failing()) return Promise.resolve({ ok: false, error: 'engine_failing' });
    if (!proc) {
      proc = start();
      if (proc && cmd !== 'ping' && PING_ON_START.has(platform)) request('ping');
    }
    if (!proc) return Promise.resolve({ ok: false, error: 'engine_exited' });
    const id = nextId++;
    if (cmd === 'ping') pings.add(id);
    return new Promise((resolve) => {
      const child = proc;
      const timer = timers.setTimeout(() => {
        settle(id, { ok: false, error: 'timeout' });
        log(`[capture] ${cmd} timed out; restarting the engine`);
        try { child.kill(); } catch {}
      }, timeoutMs);
      pending.set(id, { resolve, timer });
      try {
        child.stdin.write(JSON.stringify({ ...body, id, cmd }) + '\n');
      } catch {
        settle(id, { ok: false, error: 'engine_exited' });
      }
    });
  }

  function stop() {
    stopped = true;
    failAll('stopped');
    const child = proc;
    proc = null;
    if (child) { try { child.stdin.end(); } catch {} try { child.kill(); } catch {} }
  }

  // Returns the function that removes the listener.
  function onEvent(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  // Whether this engine can do `feature` (a FEATURES name), and is here at all.
  function has(feature) {
    return available() && features.has(feature);
  }

  return { available, has, request, stop, onEvent, running: () => !!proc };
}

module.exports = {
  createCaptureHost, REQUEST_TIMEOUT_MS, CRASH_LIMIT, CRASH_WINDOW_MS, WINDOWS_FEATURES, MAC_FEATURES,
};
