'use strict';

// Second-screen capture host manager. Spawns the Xenon Helper in `screen-serve`
// mode (GDI capture of the virtual monitor) and relays its JPEG frames to the
// dashboard tile over the loopback WS in server.js.
//
// One capture process serves one tile at a time — the second-screen feature is a
// single virtual display. start() (re)configures the capture; frames arrive on
// the sink set with setFrameSink(). This is helper-only: GDI capture has no
// PowerShell serve fallback (the feature is optional and the helper is installed
// one-click), so available() reflects the exe's presence and the tile shows a
// friendly "needs the helper" state otherwise — never a dead end.
//
// Helper stdio protocol (see helper/ScreenHost.cs):
//   stdin  : {"id":N,"action":"start"|"stop"|"list", ...}
//   stdout : control/ack -> "XSCTL " + base64(json {id,ok,out,err})
//            video frame  -> "XSFRM <w> <h> <seq> " + base64(jpeg)

const fs = require('fs');
const { spawn: defaultSpawn } = require('child_process');

const HOST_RETRY_MS = 4000;   // back off briefly after a host *dies* before respawning
const IDLE_RETIRE_MS = 45000; // free the resident capture process after this long idle

// Parse one stdout line from the helper. Returns one of:
//   { type:'frame', w, h, seq, data }   (data = base64 jpeg)
//   { type:'control', env }             (env = {id,ok,out,err})
//   null                                (stray/unparseable line)
function parseLine(line) {
  if (!line) return null;
  if (line.startsWith('XSFRM ')) {
    // "XSFRM w h seq <base64>" — base64 carries no spaces, so a 4-way split is safe.
    const parts = line.slice(6).split(' ');
    if (parts.length < 4) return null;
    const w = Number(parts[0]);
    const h = Number(parts[1]);
    const seq = Number(parts[2]);
    const data = parts[3];
    if (!Number.isFinite(w) || !Number.isFinite(h) || !data) return null;
    return { type: 'frame', w, h, seq, data };
  }
  if (line.startsWith('XSCTL ')) {
    let env;
    try { env = JSON.parse(Buffer.from(line.slice(6), 'base64').toString('utf8')); }
    catch (e) { return null; }
    return { type: 'control', env };
  }
  return null;
}

// opts: { helperExe, spawn, existsSync } — all injectable for tests.
function createScreenCapture(opts) {
  const o = opts || {};
  const helperExe = o.helperExe;
  const spawn = o.spawn || defaultSpawn;
  const existsSync = o.existsSync || fs.existsSync;

  let proc = null;
  let buf = '';
  let nextId = 1;
  let diedAt = 0;
  let idleTimer = null;
  const pending = new Map();   // id -> { resolve, reject, timer }
  let frameSink = null;        // (base64jpeg, { w, h, seq }) => void

  function available() {
    try { return !!helperExe && existsSync(helperExe); } catch (e) { return false; }
  }

  function setFrameSink(fn) { frameSink = typeof fn === 'function' ? fn : null; }

  function _clearIdle() { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } }

  // Free the resident capture process after a stretch of no streaming. Unlike a
  // crash (_retire), this is a clean stop: don't arm the respawn backoff, so the
  // next time the user views the screen it starts instantly.
  function _scheduleIdleRetire() {
    _clearIdle();
    if (!proc) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      const p = proc;
      proc = null;
      buf = '';
      diedAt = 0; // clean retire — no backoff on the next start
      pending.forEach((req) => { clearTimeout(req.timer); req.reject(new Error('screen host idle')); });
      pending.clear();
      if (p) { try { p.kill(); } catch (e) { /* ignore */ } }
    }, IDLE_RETIRE_MS);
    if (idleTimer.unref) idleTimer.unref();
  }

  function _retire(reason) {
    const p = proc;
    proc = null;
    diedAt = Date.now();
    buf = '';
    _clearIdle();
    pending.forEach((req) => { clearTimeout(req.timer); req.reject(new Error(reason || 'screen host gone')); });
    pending.clear();
    if (p) { try { p.kill(); } catch (e) { /* ignore */ } }
  }

  function _ensureHost() {
    if (proc) return proc;
    if (Date.now() - diedAt < HOST_RETRY_MS) return null;
    if (!available()) return null;
    let p;
    try { p = spawn(helperExe, ['screen-serve'], { windowsHide: true }); }
    catch (e) { diedAt = Date.now(); return null; }
    proc = p;
    buf = '';
    if (p.stdout) {
      p.stdout.setEncoding('utf8');
      p.stdout.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          _onLine(line);
        }
      });
    }
    if (p.stderr) p.stderr.on('data', () => {}); // host traps its own errors
    p.on('error', () => { if (proc === p) _retire('screen host spawn error'); });
    p.on('exit', () => { if (proc === p) _retire('screen host exited'); });
    if (p.unref) p.unref(); // never keep the event loop alive on the host's account
    return p;
  }

  function _onLine(line) {
    const msg = parseLine(line);
    if (!msg) return;
    if (msg.type === 'frame') {
      if (frameSink) frameSink(msg.data, { w: msg.w, h: msg.h, seq: msg.seq });
      return;
    }
    const req = pending.get(msg.env.id);
    if (!req) return;
    clearTimeout(req.timer);
    pending.delete(msg.env.id);
    if (msg.env.ok) {
      let out = {};
      try { out = msg.env.out ? JSON.parse(msg.env.out) : {}; } catch (e) { out = {}; }
      req.resolve(out);
    } else {
      req.reject(new Error(msg.env.err || 'screen host error'));
    }
  }

  function _request(payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      const p = _ensureHost();
      if (!p) { reject(new Error('screen host unavailable')); return; }
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('screen host timeout'));
      }, timeoutMs || 5000);
      if (timer.unref) timer.unref();
      pending.set(id, { resolve, reject, timer });
      try { p.stdin.write(JSON.stringify(Object.assign({ id }, payload)) + '\n'); }
      catch (e) { clearTimeout(timer); pending.delete(id); reject(e); }
    });
  }

  function list() { return _request({ action: 'list' }); }

  function start(cfg) {
    _clearIdle();   // active again — cancel any pending idle teardown
    const c = cfg || {};
    return _request({
      action: 'start',
      monitor: typeof c.monitor === 'string' && c.monitor ? c.monitor : 'virtual',
      fps: c.fps,
      maxWidth: c.maxWidth,
      maxHeight: c.maxHeight,
      quality: c.quality,
    });
  }

  function stop() {
    if (!proc) return Promise.resolve({ stopped: true });
    const r = _request({ action: 'stop' }).catch(() => ({ stopped: true }));
    _scheduleIdleRetire();   // capture stopped — free the process if it stays idle
    return r;
  }

  // Commit a display mode (resolution) on the virtual monitor. A freshly created
  // VDD monitor advertises its configured modes but sits at a stale default until
  // one is actually applied — this is what makes the chosen resolution stick. No
  // elevation needed (per-user display setting); resolves { ok, code, width, height }.
  function setMode(cfg) {
    const c = cfg || {};
    return _request({
      action: 'setmode',
      monitor: typeof c.monitor === 'string' && c.monitor ? c.monitor : 'virtual',
      width: c.width,
      height: c.height,
      refresh: c.refresh,
    });
  }

  // Fire-and-forget input forwarding (mouse/key/wheel). High-rate and ack-less by
  // design — the helper injects it via SendInput and emits no control frame.
  function input(evt) {
    if (!proc || !evt || typeof evt !== 'object') return;
    try { proc.stdin.write(JSON.stringify(Object.assign({ action: 'input' }, evt)) + '\n'); }
    catch (e) { /* ignore: a dropped input event is harmless */ }
  }

  function shutdown() { _clearIdle(); _retire('shutdown'); }

  return { available, setFrameSink, list, start, stop, setMode, input, shutdown, _parseLine: parseLine };
}

module.exports = { createScreenCapture, parseLine };
