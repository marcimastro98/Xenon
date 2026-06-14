'use strict';
// Embedded-browser host for the dashboard "Browser" widget.
//
// We drive ONE headless Microsoft Edge instance through the Chrome DevTools
// Protocol (CDP). Each dashboard browser tile gets its own CDP *target* (a real
// page) attached over a single browser-level WebSocket using flatten sessions.
// The page is rendered off-screen and streamed to the tile via
// `Page.startScreencast`, which is change-driven: a static page emits almost no
// frames, so an open-but-idle tile costs ~nothing. Pointer/keyboard input flows
// back and is injected with `Input.dispatch*`.
//
// Why a server proxy (not the client talking to CDP directly): keeping CDP on
// the server keeps the raw DevTools endpoint off the browser's trust surface,
// lets us validate every navigation/input, avoids needing `--remote-allow-origins`
// (a Node `ws` client sends no Origin, so Edge accepts it), and fits the project's
// loopback-only, allowlisted security posture. The debug port is bound to
// 127.0.0.1 only.
//
// WebSocket: the `ws` library (a direct dependency) — Node's built-in client is
// avoided for the same compression-handling reason documented in actions/streamerbot.js.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_WS = (() => {
  try { return require('ws'); } catch (e) { return globalThis.WebSocket; }
})();

// ── Pure helpers (exported for tests) ────────────────────────────────────────

// Locate msedge.exe across the usual machine-wide and per-user install roots.
function findEdge() {
  const roots = [
    process.env['ProgramFiles(x86)'],
    process.env.ProgramFiles,
    process.env.LOCALAPPDATA,
  ];
  for (const root of roots) {
    if (!root) continue;
    const exe = path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    try { if (fs.existsSync(exe)) return exe; } catch (e) { /* ignore */ }
  }
  return null;
}

// Validate/normalize a user-entered URL. Only http/https are allowed into the
// tile (no file:, chrome:, javascript:, data:, …). A bare host gets https://.
// Returns { ok:true, url } or { ok:false, error }.
function normalizeUrl(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return { ok: false, error: 'empty_url' };
  let candidate = raw;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(candidate)) candidate = 'https://' + candidate;
  let u;
  try { u = new URL(candidate); } catch (e) { return { ok: false, error: 'bad_url' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: 'blocked_scheme' };
  return { ok: true, url: u.href };
}

// Translate a normalized client input event into a CDP Input.* command.
// Coordinates are page CSS pixels (the client maps canvas → page coords).
// Returns { method, params } or null if the event is unusable.
function inputToCdp(evt) {
  if (!evt || typeof evt !== 'object') return null;
  const num = (v, d) => (Number.isFinite(v) ? v : d);
  const mods = num(evt.modifiers, 0) | 0;
  if (evt.kind === 'mouse') {
    const type = { pressed: 'mousePressed', released: 'mouseReleased', moved: 'mouseMoved' }[evt.subtype];
    if (!type) return null;
    return { method: 'Input.dispatchMouseEvent', params: {
      type, x: num(evt.x, 0), y: num(evt.y, 0),
      button: ['left', 'right', 'middle', 'none'].includes(evt.button) ? evt.button : 'left',
      buttons: num(evt.buttons, 0) | 0,
      clickCount: num(evt.clickCount, 0) | 0,
      modifiers: mods,
    } };
  }
  if (evt.kind === 'wheel') {
    return { method: 'Input.dispatchMouseEvent', params: {
      type: 'mouseWheel', x: num(evt.x, 0), y: num(evt.y, 0),
      deltaX: num(evt.deltaX, 0), deltaY: num(evt.deltaY, 0),
      button: 'none', modifiers: mods,
    } };
  }
  if (evt.kind === 'key') {
    const type = { down: 'keyDown', up: 'keyUp', char: 'char' }[evt.subtype];
    if (!type) return null;
    const params = { type, modifiers: mods };
    if (typeof evt.key === 'string') params.key = evt.key;
    if (typeof evt.code === 'string') params.code = evt.code;
    if (typeof evt.text === 'string') params.text = evt.text;
    if (Number.isFinite(evt.keyCode)) { params.windowsVirtualKeyCode = evt.keyCode | 0; params.nativeVirtualKeyCode = evt.keyCode | 0; }
    return { method: 'Input.dispatchKeyEvent', params };
  }
  return null;
}

// Read Edge's DevToolsActivePort file (line 1 = port, line 2 = browser ws path),
// polling until it appears or the timeout elapses.
function readDevToolsPort(portFile, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + (timeoutMs || 8000);
    const tick = () => {
      let txt = '';
      try { txt = fs.readFileSync(portFile, 'utf8'); } catch (e) { txt = ''; }
      const lines = txt.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length >= 2 && /^\d+$/.test(lines[0])) {
        resolve({ port: Number(lines[0]), wsPath: lines[1] });
        return;
      }
      if (Date.now() >= deadline) { reject(new Error('devtools_port_timeout')); return; }
      setTimeout(tick, 100).unref();
    };
    tick();
  });
}

// ── CDP host ─────────────────────────────────────────────────────────────────

// opts: { WebSocketImpl, launch, dataDir, idleMs } — all injectable for tests.
// `launch(profileDir)` -> Promise<{ proc, wsUrl }>.
function createEmbeddedBrowser(opts) {
  const o = opts || {};
  const WebSocketImpl = o.WebSocketImpl || DEFAULT_WS;
  const dataDir = o.dataDir || path.join(__dirname, 'data');
  const profileDir = path.join(dataDir, 'embedded-browser-profile');
  const idleMs = Number.isFinite(o.idleMs) ? o.idleMs : 15000;
  const launch = o.launch || (() => defaultLaunch(profileDir));

  let proc = null;
  let ws = null;
  let ready = null;            // Promise<void> resolved once the CDP socket is open
  let nextId = 1;
  const pending = new Map();   // cdp message id -> { resolve, reject }
  const tiles = new Map();     // tileId -> { targetId, sessionId, onFrame, onNav, w, h, dpr }
  const bySession = new Map(); // CDP sessionId -> tileId
  let idleTimer = null;

  function killBrowser(reason) {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    pending.forEach((p) => p.reject(new Error(reason || 'browser_closed')));
    pending.clear();
    tiles.clear();
    bySession.clear();
    if (ws) { try { ws.close(); } catch (e) { /* ignore */ } ws = null; }
    if (proc) { try { proc.kill(); } catch (e) { /* ignore */ } proc = null; }
    ready = null;
  }

  function armIdle() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (tiles.size > 0) return;
    idleTimer = setTimeout(() => { if (tiles.size === 0) killBrowser('idle'); }, idleMs);
    idleTimer.unref && idleTimer.unref();
  }

  function ensureBrowser() {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      let settled = false;
      const done = (err) => {
        if (settled) return; settled = true;
        if (err) { reject(err); killBrowser('launch_failed'); } else { resolve(); }
      };
      Promise.resolve().then(launch).then(({ proc: p, wsUrl }) => {
        proc = p;
        if (proc && proc.on) {
          proc.on('exit', () => { if (proc === p) killBrowser('edge_exited'); });
          proc.on('error', () => { if (proc === p) killBrowser('edge_error'); });
        }
        let sock;
        try { sock = new WebSocketImpl(wsUrl); } catch (e) { done(e); return; }
        ws = sock;
        const timer = setTimeout(() => done(new Error('cdp_connect_timeout')), 10000);
        timer.unref && timer.unref();
        sock.addEventListener('open', () => { clearTimeout(timer); done(); });
        sock.addEventListener('error', () => { clearTimeout(timer); done(new Error('cdp_connect_failed')); });
        sock.addEventListener('close', () => { clearTimeout(timer); if (proc) killBrowser('cdp_closed'); });
        sock.addEventListener('message', (ev) => onMessage(ev.data));
      }, (e) => done(e instanceof Error ? e : new Error('launch_failed')));
    });
    ready.catch(() => {});
    return ready;
  }

  function onMessage(data) {
    const raw = typeof data === 'string' ? data
      : Buffer.isBuffer(data) ? data.toString('utf8')
      : data instanceof ArrayBuffer ? Buffer.from(data).toString('utf8') : '';
    let msg; try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg) return;
    if (msg.id != null && pending.has(msg.id)) {     // command response
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error((msg.error && msg.error.message) || 'cdp_error'));
      else p.resolve(msg.result || {});
      return;
    }
    if (msg.method) onEvent(msg.method, msg.params || {}, msg.sessionId);
  }

  function onEvent(method, params, sessionId) {
    const tileId = sessionId && bySession.get(sessionId);
    if (method === 'Page.screencastFrame') {
      // Ack immediately so Edge keeps sending frames; the ack uses the frame's
      // own numeric sessionId, distinct from the CDP target sessionId.
      send('Page.screencastFrameAck', { sessionId: params.sessionId }, sessionId).catch(() => {});
      const tile = tileId && tiles.get(tileId);
      if (tile && tile.onFrame) tile.onFrame(params.data, params.metadata || {});
      return;
    }
    if ((method === 'Page.frameNavigated' && params.frame && !params.frame.parentId) ||
        method === 'Page.navigatedWithinDocument') {
      const tile = tileId && tiles.get(tileId);
      const url = (params.frame && params.frame.url) || params.url;
      if (tile && tile.onNav && url) tile.onNav(url);
    }
  }

  function send(method, params, sessionId) {
    return new Promise((resolve, reject) => {
      if (!ws) { reject(new Error('no_socket')); return; }
      const id = nextId++;
      pending.set(id, { resolve, reject });
      const frame = { id, method, params: params || {} };
      if (sessionId) frame.sessionId = sessionId;
      try { ws.send(JSON.stringify(frame)); }
      catch (e) { pending.delete(id); reject(e); }
    });
  }

  // Open (or re-open) a tile on `url`, sized to w×h CSS px at the given dpr.
  // onFrame(base64Jpeg, metadata) and onNav(url) report back to the relay.
  async function open(tileId, url, w, h, dpr, onFrame, onNav) {
    const norm = normalizeUrl(url);
    if (!norm.ok) throw new Error(norm.error);
    if (tiles.has(tileId)) await closeTile(tileId);
    await ensureBrowser();
    const width = clampDim(w, 800);
    const height = clampDim(h, 600);
    const scale = Number.isFinite(dpr) && dpr > 0 ? Math.min(dpr, 3) : 1;
    // Size is applied via Emulation.setDeviceMetricsOverride below — passing
    // width/height here is rejected in headless ("only for new windows").
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const tile = { targetId, sessionId, onFrame, onNav, w: width, h: height, dpr: scale, streaming: false };
    tiles.set(tileId, tile);
    bySession.set(sessionId, tileId);
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    await send('Page.enable', {}, sessionId);
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false }, sessionId);
    await send('Page.navigate', { url: norm.url }, sessionId);
    return { url: norm.url };
  }

  async function navigate(tileId, url) {
    const tile = tiles.get(tileId);
    if (!tile) throw new Error('no_tile');
    const norm = normalizeUrl(url);
    if (!norm.ok) throw new Error(norm.error);
    await send('Page.navigate', { url: norm.url }, tile.sessionId);
    return { url: norm.url };
  }

  async function setSize(tileId, w, h, dpr) {
    const tile = tiles.get(tileId);
    if (!tile) return;
    tile.w = clampDim(w, tile.w);
    tile.h = clampDim(h, tile.h);
    tile.dpr = Number.isFinite(dpr) && dpr > 0 ? Math.min(dpr, 3) : tile.dpr;
    await send('Emulation.setDeviceMetricsOverride', { width: tile.w, height: tile.h, deviceScaleFactor: tile.dpr, mobile: false }, tile.sessionId);
    if (tile.streaming) await startScreencast(tileId); // re-issue with new caps
  }

  async function startScreencast(tileId) {
    const tile = tiles.get(tileId);
    if (!tile) return;
    tile.streaming = true;
    await send('Page.startScreencast', {
      format: 'jpeg', quality: 70,
      maxWidth: Math.round(tile.w * tile.dpr), maxHeight: Math.round(tile.h * tile.dpr),
      everyNthFrame: 1,
    }, tile.sessionId);
  }

  async function stopScreencast(tileId) {
    const tile = tiles.get(tileId);
    if (!tile || !tile.streaming) return;
    tile.streaming = false;
    await send('Page.stopScreencast', {}, tile.sessionId).catch(() => {});
  }

  async function input(tileId, evt) {
    const tile = tiles.get(tileId);
    if (!tile) return;
    const cmd = inputToCdp(evt);
    if (!cmd) return;
    await send(cmd.method, cmd.params, tile.sessionId).catch(() => {});
  }

  function navHistory(tileId, dir) {
    const tile = tiles.get(tileId);
    if (!tile) return Promise.resolve();
    // Back/forward via history entries.
    return send('Page.getNavigationHistory', {}, tile.sessionId).then((h) => {
      const idx = h.currentIndex + (dir < 0 ? -1 : 1);
      const entry = (h.entries || [])[idx];
      if (entry) return send('Page.navigateToHistoryEntry', { entryId: entry.id }, tile.sessionId);
    }).catch(() => {});
  }

  function reload(tileId) {
    const tile = tiles.get(tileId);
    if (!tile) return Promise.resolve();
    return send('Page.reload', {}, tile.sessionId).catch(() => {});
  }

  async function closeTile(tileId) {
    const tile = tiles.get(tileId);
    if (!tile) return;
    tiles.delete(tileId);
    bySession.delete(tile.sessionId);
    try { await send('Target.closeTarget', { targetId: tile.targetId }); } catch (e) { /* ignore */ }
    armIdle(); // shut Edge down if this was the last tile
  }

  function available() { return !!findEdge(); }

  function shutdown() { killBrowser('shutdown'); }

  return {
    open, navigate, setSize, startScreencast, stopScreencast, input,
    navHistory, reload, closeTile, available, shutdown,
    _tiles: tiles, // exposed for tests
  };
}

function clampDim(v, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(64, Math.min(n, 4096));
}

// Default real launcher: spawn headless Edge, read its chosen debug port.
async function defaultLaunch(profileDir) {
  const exe = findEdge();
  if (!exe) throw new Error('edge_not_found');
  try { fs.mkdirSync(profileDir, { recursive: true }); } catch (e) { /* ignore */ }
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  try { fs.unlinkSync(portFile); } catch (e) { /* stale file may be absent */ }
  const proc = spawn(exe, [
    '--headless=new',
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    '--user-data-dir=' + profileDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,TranslateUI',
    '--mute-audio',
    'about:blank',
  ], { windowsHide: true });
  proc.on('error', () => {});      // surfaced via the 'exit'/connect path
  if (proc.stderr) proc.stderr.on('data', () => {});
  if (proc.unref) proc.unref();
  const { port, wsPath } = await readDevToolsPort(portFile, 8000);
  return { proc, wsUrl: 'ws://127.0.0.1:' + port + wsPath };
}

module.exports = { createEmbeddedBrowser, findEdge, normalizeUrl, inputToCdp, readDevToolsPort };
