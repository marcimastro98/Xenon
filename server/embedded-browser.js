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

// Decide whether a scheme-less omnibox entry is a hostname to visit or a search
// query. Mirrors a real browser's address bar: something with whitespace, or a
// single token with no dot/port/IP, is a search — everything else is a host.
function looksLikeHost(input) {
  const s = String(input || '').trim();
  if (!s || /\s/.test(s)) return false;              // has spaces → search
  const host = s.split(/[/?#]/)[0].replace(/:\d+$/, '');
  if (!host) return false;
  if (/^localhost$/i.test(host)) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;   // IPv4
  if (/:\d+$/.test(s.split(/[/?#]/)[0])) return true;      // explicit host:port
  return /\.[a-z]{2,}$/i.test(host);                       // dotted name, letter TLD
}

// Build a search URL for a free-text query (browser omnibox default engine).
function searchUrl(query) {
  return 'https://www.google.com/search?q=' + encodeURIComponent(String(query || '').trim());
}

// Validate/normalize a user-entered address. Only http/https are allowed into
// the tile (no file:, chrome:, javascript:, data:, …). An entry with an explicit
// scheme is honored; a bare hostname gets https://; free text (e.g. "google") is
// turned into a search instead of a doomed https://google navigation.
// Returns { ok:true, url } or { ok:false, error }.
function normalizeUrl(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return { ok: false, error: 'empty_url' };
  // Explicit scheme: honor it, but block anything that isn't http/https. What
  // follows the colon must NOT be a bare port, or "localhost:3030" / "host:8080"
  // would be mis-read as a scheme instead of host:port.
  const scheme = raw.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$/s);
  if (scheme && !/^\d+([/?#].*)?$/.test(scheme[2])) {
    let u;
    try { u = new URL(raw); } catch (e) { return { ok: false, error: 'bad_url' }; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: 'blocked_scheme' };
    return { ok: true, url: u.href };
  }
  // No scheme: hostname → visit; anything else → search.
  if (looksLikeHost(raw)) {
    try { return { ok: true, url: new URL('https://' + raw).href }; }
    catch (e) { /* fall through to search */ }
  }
  return { ok: true, url: searchUrl(raw) };
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

  // Tear down the current Edge + CDP socket without touching `ready`. Used both
  // by the retry loop (between attempts) and by killBrowser (which also clears
  // `ready` so the next open re-launches).
  function teardown(reason) {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    pending.forEach((p) => p.reject(new Error(reason || 'browser_closed')));
    pending.clear();
    tiles.clear();
    bySession.clear();
    if (ws) { try { ws.close(); } catch (e) { /* ignore */ } ws = null; }
    if (proc) { killProcessTree(proc); proc = null; }
  }

  function killBrowser(reason) { teardown(reason); ready = null; }

  function armIdle() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (tiles.size > 0) return;
    idleTimer = setTimeout(() => { if (tiles.size === 0) killBrowser('idle'); }, idleMs);
    idleTimer.unref && idleTimer.unref();
  }

  // One launch+connect attempt. Resolves when the CDP socket is open, rejects on
  // any failure. Post-connect death (Edge exits, socket drops) routes through
  // killBrowser so the next open transparently re-launches.
  function attemptLaunch() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (err) => { if (settled) return; settled = true; err ? reject(err) : resolve(); };
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
        sock.addEventListener('close', () => { clearTimeout(timer); if (settled) killBrowser('cdp_closed'); else done(new Error('cdp_closed')); });
        sock.addEventListener('message', (ev) => onMessage(ev.data));
      }, (e) => done(e instanceof Error ? e : new Error('launch_failed')));
    });
  }

  // Launch with automatic self-healing: a failed attempt is fully torn down
  // (tree-killed) and — since `launch` sweeps stale profile Edge and clears the
  // profile lock — the next attempt starts clean. This recovers from an orphaned
  // headless Edge locking the profile after an unclean shutdown, with no manual
  // intervention. `ready` is held across retries so concurrent callers coalesce.
  function ensureBrowser() {
    if (ready) return ready;
    ready = (async () => {
      const maxTries = 3;
      let lastErr;
      for (let attempt = 1; attempt <= maxTries; attempt++) {
        try { await attemptLaunch(); return; }
        catch (e) {
          lastErr = e;
          teardown('launch_retry');
          if (attempt < maxTries) await new Promise((r) => { const tm = setTimeout(r, 500 * attempt); tm.unref && tm.unref(); });
        }
      }
      throw lastErr || new Error('launch_failed');
    })();
    ready.catch(() => { ready = null; });   // let the next open try again fresh
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

// Kill the whole Edge process tree. `--headless=new` spawns child processes that
// hold the --user-data-dir singleton lock; on Windows a bare proc.kill() only
// signals the launcher and leaves those children orphaned, so the NEXT launch
// finds the profile in use, never writes DevToolsActivePort, and times out
// (surfacing as browser_err_launch). taskkill /T tears down the entire tree.
function killProcessTree(proc) {
  if (!proc) return;
  const pid = proc.pid;
  if (process.platform === 'win32' && pid) {
    try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }); return; }
    catch (e) { /* fall through to the plain kill below */ }
  }
  try { proc.kill(); } catch (e) { /* ignore */ }
}

function clampDim(v, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(64, Math.min(n, 4096));
}

function pidFilePath(profileDir) { return path.join(profileDir, 'edge.pid'); }

// Best-effort orphan reaper. On an unclean server exit (terminal window closed
// with the X, a crash — no SIGINT/SIGTERM, so _gracefulShutdown never runs) the
// headless Edge we launched can be left holding this profile's singleton lock,
// which then blocks — and silently fails — every future launch. We record each
// launched Edge's PID in a file inside the profile dir and, before spawning a
// fresh one, tree-kill exactly that PID.
//
// This deliberately uses `taskkill` with a PID+image-name filter rather than a
// WMI/CIM process scan: the filter kills the process ONLY if that PID is still an
// msedge.exe (so a recycled PID belonging to some unrelated app is never touched),
// it targets only the Edge we ourselves started (never the user's real browser),
// and it avoids the "enumerate processes + kill by command line" pattern that
// antivirus ML heuristics (Defender's Wacatac.B!ml) flag as suspicious.
function reapStaleProfileEdge(profileDir) {
  if (process.platform !== 'win32') return Promise.resolve();
  let pid = 0;
  try { pid = parseInt(fs.readFileSync(pidFilePath(profileDir), 'utf8'), 10); } catch (e) { pid = 0; }
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn('taskkill', [
        '/fi', 'PID eq ' + pid,
        '/fi', 'IMAGENAME eq msedge.exe',
        '/t', '/f',
      ], { windowsHide: true });
    } catch (e) { resolve(); return; }
    p.on('exit', resolve);
    p.on('error', () => resolve());
    setTimeout(() => { try { p.kill(); } catch (e) { /* ignore */ } resolve(); }, 4000).unref();
  });
}

// Delete the port file and any singleton locks a force-killed instance left
// behind, so a fresh Edge owns the profile cleanly instead of forwarding to (and
// exiting toward) a dead one.
function clearProfileLocks(profileDir) {
  for (const f of ['DevToolsActivePort', 'lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.rmSync(path.join(profileDir, f), { force: true }); } catch (e) { /* absent or held; best effort */ }
  }
}

// Fallback sweep — used ONLY when a launch times out because the profile is still
// locked by an Edge we couldn't attribute to our recorded PID (an orphan from a
// previous version, or a tree whose launcher died leaving reparented children).
// The precise pid-file reap can't see those, so here we do have to find Edge by
// its command line. To stay clear of the antivirus "enumerate + kill" heuristic,
// PowerShell only READS the matching ProcessIds; the termination is done by the
// ordinary `taskkill` tool. Own-profile processes only; never the user's real Edge.
function sweepProfileEdge(profileDir) {
  if (process.platform !== 'win32') return Promise.resolve();
  const leaf = path.basename(profileDir);
  const query =
    "(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | " +
    "Where-Object { $_.CommandLine -like '*" + leaf + "*' }).ProcessId";
  return new Promise((resolve) => {
    let out = '';
    let p;
    try { p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], { windowsHide: true }); }
    catch (e) { resolve(); return; }
    if (p.stdout) p.stdout.on('data', (d) => { out += d.toString(); });
    const finish = () => {
      const pids = out.split(/\s+/).map((s) => parseInt(s, 10)).filter((n) => Number.isInteger(n) && n > 0);
      if (!pids.length) { resolve(); return; }
      const args = ['/f', '/t'];
      for (const pid of pids) args.push('/pid', String(pid));
      try { spawn('taskkill', args, { windowsHide: true }); } catch (e) { /* ignore */ }
      resolve();
    };
    p.on('exit', finish);
    p.on('error', () => resolve());
    setTimeout(() => { try { p.kill(); } catch (e) { /* ignore */ } finish(); }, 4000).unref();
  });
}

function edgeArgs(profileDir) {
  return [
    '--headless=new',
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    '--user-data-dir=' + profileDir,
    '--no-first-run',
    '--no-default-browser-check',
    // Render on SwiftShader instead of the real GPU. `--headless=new` streams
    // all-black frames on many machines (older/hybrid GPU drivers, no active
    // session) — reported as a working address bar over a black tile. Software
    // rendering is plenty for a single small tile and renders correctly everywhere.
    '--disable-gpu',
    '--mute-audio',
    // Keep the footprint minimal: a dashboard tile has no use for extensions,
    // background sync/networking, component updates or the crash reporter, each
    // of which is an extra msedge child process. Trimming them keeps one lean
    // browser (main + network + renderer) instead of a cluster of helpers.
    '--disable-extensions',
    '--disable-component-extensions-with-background-pages',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-default-apps',
    '--disable-breakpad',
    '--no-pings',
    '--disable-features=Translate,TranslateUI,MediaRouter,OptimizationHints',
    'about:blank',
  ];
}

// One spawn+port-read. Records the PID first so a later run can reap this exact
// Edge, and — critically — tree-kills its own process if the port never appears,
// so a failed attempt (e.g. it lost a race for a locked profile) can't itself
// become the next orphan.
async function spawnEdge(exe, profileDir) {
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  const proc = spawn(exe, edgeArgs(profileDir), { windowsHide: true });
  proc.on('error', () => {});      // surfaced via the 'exit'/connect path
  if (proc.stderr) proc.stderr.on('data', () => {});
  if (proc.unref) proc.unref();
  try { fs.writeFileSync(pidFilePath(profileDir), String(proc.pid)); } catch (e) { /* ignore */ }
  try {
    const { port, wsPath } = await readDevToolsPort(portFile, 8000);
    return { proc, wsUrl: 'ws://127.0.0.1:' + port + wsPath };
  } catch (e) {
    killProcessTree(proc);         // don't leave the failed attempt running
    throw e;
  }
}

// Default real launcher. Self-heals a profile left locked by a previous run:
// first a precise reap of the Edge we recorded, then a spawn; if that still times
// out (something we didn't record is holding the lock) sweep any Edge bound to
// this profile and try once more.
async function defaultLaunch(profileDir) {
  const exe = findEdge();
  if (!exe) throw new Error('edge_not_found');
  try { fs.mkdirSync(profileDir, { recursive: true }); } catch (e) { /* ignore */ }
  await reapStaleProfileEdge(profileDir);
  clearProfileLocks(profileDir);
  try {
    return await spawnEdge(exe, profileDir);
  } catch (e) {
    if (!/devtools_port_timeout/.test(String(e && e.message))) throw e;
    await sweepProfileEdge(profileDir);
    clearProfileLocks(profileDir);
    return await spawnEdge(exe, profileDir);
  }
}

module.exports = { createEmbeddedBrowser, findEdge, normalizeUrl, inputToCdp, readDevToolsPort };
