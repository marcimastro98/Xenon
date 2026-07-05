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
// Google may show its anti-bot CAPTCHA to the headless browser, but the tile is
// interactive so it can simply be solved in place.
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
  if (evt.kind === 'touch') {
    // Real touch input goes through Chromium's gesture recognizer, so a drag
    // scrolls the page natively (with fling inertia) and a tap synthesizes a
    // click — instead of a touch-drag acting like a mouse text-selection.
    const type = { start: 'touchStart', move: 'touchMove', end: 'touchEnd', cancel: 'touchCancel' }[evt.subtype];
    if (!type) return null;
    // Per the CDP contract, end/cancel send an empty touchPoints list (the
    // protocol diffs against the active points to find the lifted one).
    const touchPoints = (type === 'touchStart' || type === 'touchMove')
      ? [{ x: num(evt.x, 0), y: num(evt.y, 0) }]
      : [];
    return { method: 'Input.dispatchTouchEvent', params: { type, touchPoints, modifiers: mods } };
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

// Injected into every page before its own scripts run: hide the headless
// automation tell. `navigator.webdriver` is true in headless Edge, which sites
// like Twitch sniff to show a "browser not supported" wall (verified: even with a
// clean User-Agent, webdriver:true still triggered it).
//
// NOTE: this used to also force window.open()/target!=_self links back into the
// same page, because a popup spawned an invisible target that wedged the visible
// page. That broke real popups — most importantly OAuth "Continue with Google/
// Amazon" flows, whose popup must postMessage/`window.opener` its opener and then
// self-close; reusing the opener's own window left the callback with no opener and
// a blank page. Popups are now rendered for real (each tile keeps a stack of pages
// and shows the top one — see onTargetCreated/onTargetGone), so the hijack is gone and
// window.open behaves natively.
const STEALTH_SHIM = [
  '(function(){',
  '  try { Object.defineProperty(navigator, "webdriver", { get: function(){ return false; }, configurable: true }); } catch(_){}',
  '})();',
].join('\n');

// Per-page audio gate, injected before the page's own scripts. The single shared
// Edge is launched WITHOUT the global `--mute-audio`, so audio must be gated per
// page: only the tab currently being viewed (active tab of an on-screen tile)
// should be audible, or a backgrounded/off-screen page would keep playing sound.
//
// The gate starts MUTED and the server flips it audible on `startScreencast` and
// back to muted on `stopScreencast`, so audio tracks the exact same "is this the
// visible, streaming tab" state the screencast already tracks.
//
// It only ever touches media it muted itself (tracked in `forced`): going audible
// un-mutes solely those elements, never forcing a site's intentionally-muted media
// (e.g. an autoplay preview) to play sound. New/late media elements are caught via
// a MutationObserver and the capture-phase "play"/"volumechange" listeners, so the
// current state is always enforced (even if the site programmatically un-mutes an
// already-playing element).
//
// Frames: the shim is injected into EVERY frame (each starts muted), but the server
// only evaluates set() in the top frame. So the state is propagated down the frame
// tree with postMessage — this reaches cross-origin embeds (YouTube/Twitch iframe
// players), which querySelectorAll can't. A late-created frame asks its parent for
// the current state on init, so it doesn't get stuck at the muted default.
const AUDIO_SHIM = [
  '(function(){',
  '  try {',
  '    var muted = true;',
  '    var forced = new WeakSet();',
  '    var apply = function(el){',
  '      try {',
  '        if (muted) { if (!el.muted) { el.muted = true; forced.add(el); } }',
  '        else if (forced.has(el)) { el.muted = false; forced.delete(el); }',
  '      } catch(_){}',
  '    };',
  '    var applyAll = function(){ try { var m = document.querySelectorAll("video,audio"); for (var i=0;i<m.length;i++) apply(m[i]); } catch(_){} };',
  '    var broadcast = function(){ try { for (var i=0;i<window.frames.length;i++){ try { window.frames[i].postMessage({ __xenonMute: muted }, "*"); } catch(_){} } } catch(_){} };',
  '    var applyMute = function(mu){ muted = !!mu; applyAll(); broadcast(); };',
  '    window.__xenonAudio = { set: applyMute };',
  '    window.addEventListener("message", function(e){ var d = e && e.data; if(!d || typeof d !== "object") return; if(d.__xenonMute !== undefined){ applyMute(!!d.__xenonMute); } else if(d.__xenonMuteReq && e.source){ try { e.source.postMessage({ __xenonMute: muted }, "*"); } catch(_){} } }, false);',
  '    document.addEventListener("play", function(e){ if(e.target) apply(e.target); }, true);',
  '    document.addEventListener("volumechange", function(e){ if(e.target) apply(e.target); }, true);',
  '    var scan = function(nodes){ for (var i=0;i<nodes.length;i++){ var n = nodes[i]; if(!n || n.nodeType !== 1) continue; if(n.matches && n.matches("video,audio")) apply(n); if(n.querySelectorAll){ var mm = n.querySelectorAll("video,audio"); for (var k=0;k<mm.length;k++) apply(mm[k]); } } };',
  '    var mo = new MutationObserver(function(muts){ for (var i=0;i<muts.length;i++) scan(muts[i].addedNodes); });',
  '    var startObs = function(){ try { mo.observe(document.documentElement || document, { childList:true, subtree:true }); applyAll(); } catch(_){} };',
  '    if (document.documentElement) startObs(); else document.addEventListener("DOMContentLoaded", startObs);',
  '    if (window.top !== window.self) { try { window.parent.postMessage({ __xenonMuteReq: 1 }, "*"); } catch(_){} }',
  '  } catch(_){}',
  '})();',
].join('\n');

// ── CDP host ─────────────────────────────────────────────────────────────────

// opts: { WebSocketImpl, launch, dataDir, idleMs } — all injectable for tests.
// `launch(profileDir)` -> Promise<{ proc, wsUrl }>.
function createEmbeddedBrowser(opts) {
  const o = opts || {};
  const WebSocketImpl = o.WebSocketImpl || DEFAULT_WS;
  const dataDir = o.dataDir || path.join(__dirname, 'data');
  const profileDir = path.join(dataDir, 'embedded-browser-profile');
  const idleMs = Number.isFinite(o.idleMs) ? o.idleMs : 15000;
  // Called fresh at each Edge launch → returns the unpacked extension dirs to load
  // (e.g. the opt-in ad-blocker). Read at launch time so a settings toggle takes
  // effect on the next relaunch without touching this module's state.
  const getExtensionDirs = typeof o.getExtensionDirs === 'function' ? o.getExtensionDirs : () => [];
  const launch = o.launch || (() => defaultLaunch(profileDir, getExtensionDirs));

  let proc = null;
  let ws = null;
  let ready = null;            // Promise<void> resolved once the CDP socket is open
  let userAgent = '';          // real Edge UA with "Headless" stripped (fetched lazily)
  let widevineReady = null;    // Promise: resolves once the Widevine CDM is registered
  let nextId = 1;
  const pending = new Map();   // cdp message id -> { resolve, reject }
  const tiles = new Map();     // tileId -> { targetId, sessionId, onFrame, onNav, w, h, dpr }
  const bySession = new Map(); // CDP sessionId -> tileId
  let idleTimer = null;
  // Every page target must be attributable: a tile's stack, the launch's own
  // about:blank, a scratch page, or a popup mid-adoption. Anything else is an
  // orphan — a live Edge tab nobody renders or will ever close, which Windows 11
  // keeps listing in Alt+Tab (Edge registers its tabs with the shell even
  // headless). The sweep below closes those; these three sets are its allowlist.
  let initialTargetId = null;      // the about:blank tab Edge starts with
  const scratchTargets = new Set(); // internal helper pages (Widevine warm-up)
  const pendingAdoption = new Set(); // popups between discovery and stack push
  let sweepTimer = null;

  // Tear down the current Edge + CDP socket without touching `ready`. Used both
  // by the retry loop (between attempts) and by killBrowser (which also clears
  // `ready` so the next open re-launches).
  function teardown(reason) {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (sweepTimer) { clearTimeout(sweepTimer); sweepTimer = null; }
    pending.forEach((p) => p.reject(new Error(reason || 'browser_closed')));
    pending.clear();
    tiles.clear();
    bySession.clear();
    initialTargetId = null;
    scratchTargets.clear();
    pendingAdoption.clear();
    if (ws) { try { ws.close(); } catch (e) { /* ignore */ } ws = null; }
    if (proc) { killProcessTree(proc); proc = null; }
    widevineReady = null;   // per-Edge state; a fresh launch warms up again
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
        try {
          await attemptLaunch();
          // Passively discover new targets so we can render popups (window.open,
          // OAuth "Continue with…" windows) opened by our pages. Discovery is used
          // instead of Target.setAutoAttach because auto-attach, in flatten mode,
          // takes over the attachment of our manually-attached page sessions and
          // invalidates them ("Session with given id not found"), killing the
          // screencast — the tile then hangs on the loading spinner. Discovery only
          // NOTIFIES; we attach popups ourselves, exactly like the base page.
          await send('Target.setDiscoverTargets', { discover: true }).catch(() => {});
          // Remember the tab Edge itself opened at launch (the trailing about:blank
          // in edgeArgs). It's the only page target that legitimately belongs to no
          // tile, so the orphan sweep must never close it — closing the last page
          // of the launch window is not worth risking.
          try {
            const r = await send('Target.getTargets', {});
            const page = (Array.isArray(r && r.targetInfos) ? r.targetInfos : []).find((t) => t && t.type === 'page');
            initialTargetId = page ? page.targetId : null;
          } catch (e) { initialTargetId = null; }
          warmUpWidevine();
          return;
        }
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

  // Prime Widevine right after launch. Edge registers its bundled Widevine CDM
  // lazily and asynchronously, on the first `requestMediaKeySystemAccess` call —
  // so the first DRM site loaded on a fresh Edge (e.g. a tile auto-reopening to
  // twitch.tv right after a server restart) can ask before it's ready, get told
  // "unsupported", and keep showing its "browser not supported" wall until a
  // manual reload. This kicks the registration off on a scratch page and exposes
  // completion as `widevineReady`, which open() awaits (capped) before navigating,
  // so the first real page never races the CDM registration.
  function warmUpWidevine() {
    widevineReady = (async () => {
      let targetId;
      try {
        ({ targetId } = await send('Target.createTarget', { url: 'about:blank' }));
        scratchTargets.add(targetId);   // ours, internal — the orphan sweep must skip it
        const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
        const expr = "navigator.requestMediaKeySystemAccess('com.widevine.alpha',[{initDataTypes:['cenc'],videoCapabilities:[{contentType:'video/mp4;codecs=\"avc1.42E01E\"',robustness:'SW_SECURE_DECODE'}]}]).then(function(){return 'ok';}).catch(function(){return 'no';})";
        for (let i = 0; i < 40; i++) {
          if (!ws) break;   // browser torn down (idle/close) meanwhile — stop
          const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId).catch(() => null);
          // No `result` shape at all means a non-CDP environment (tests) — bail.
          if (!r || !r.result) break;
          if (r.result.value === 'ok') break;   // CDM registered
          await new Promise((res) => { const tm = setTimeout(res, 250); tm.unref && tm.unref(); });
        }
      } catch (e) { /* best effort — the on-demand path still works, just slower */ }
      finally {
        if (targetId) {
          send('Target.closeTarget', { targetId }).catch(() => {});
          scratchTargets.delete(targetId);
        }
      }
    })();
  }

  // Await Widevine registration before the first navigation, but never stall a
  // tile for long: cap the wait. Resolves instantly once the CDM is registered
  // (the warm-up promise is already settled for every launch after the first).
  function widevineGate() {
    if (!widevineReady) return Promise.resolve();
    return Promise.race([
      widevineReady,
      new Promise((r) => { const tm = setTimeout(r, 8000); tm.unref && tm.unref(); }),
    ]);
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

  // The live session/target for a tile is the TOP of its page stack — the base page
  // normally, or a popup (OAuth window, target=_blank) layered over it. All live
  // operations (screencast, input, navigate, audio) act on the active page.
  function activeSession(tile) { const p = tile.pages[tile.pages.length - 1]; return p && p.sessionId; }

  function onEvent(method, params, sessionId) {
    if (method === 'Target.targetCreated') { onTargetCreated(params.targetInfo || {}); return; }
    if (method === 'Target.targetDestroyed') { onTargetGone(params.targetId); return; }
    const tileId = sessionId && bySession.get(sessionId);
    if (method === 'Page.screencastFrame') {
      // Ack immediately so Edge keeps sending frames; the ack uses the frame's
      // own numeric sessionId, distinct from the CDP target sessionId.
      send('Page.screencastFrameAck', { sessionId: params.sessionId }, sessionId).catch(() => {});
      const tile = tileId && tiles.get(tileId);
      // Only the tile's active page paints the tile (a backgrounded opener under a
      // popup must not fight the popup for the canvas).
      if (tile && tile.onFrame && sessionId === activeSession(tile)) tile.onFrame(params.data, params.metadata || {});
      return;
    }
    if ((method === 'Page.frameNavigated' && params.frame && !params.frame.parentId) ||
        method === 'Page.navigatedWithinDocument') {
      const tile = tileId && tiles.get(tileId);
      if (!tile || sessionId !== activeSession(tile)) return;   // ignore a background page's nav
      const url = (params.frame && params.frame.url) || params.url;
      // A full-document navigation resets the audio gate to its muted default, so
      // re-assert the tile's desired audio state (keeps the active page audible
      // across link clicks / address-bar navigations).
      if (method === 'Page.frameNavigated') applyAudio(tile);
      if (tile.onNav && url) tile.onNav(url);
    }
  }

  // Find the tile that owns a target id (any page in its stack), or null.
  function tileOwningTarget(targetId) {
    for (const [tileId, tile] of tiles) {
      if (tile.pages.some((p) => p.targetId === targetId)) return { tileId, tile };
    }
    return null;
  }

  // A page opened by another page (window.open, target=_blank, and — crucially —
  // OAuth "Continue with…" popups) shows up here via target discovery. If its opener
  // is one of our tiles' pages, we attach and render it as that tile's new active
  // page, stacked over its opener: the opener stays alive (so the popup can
  // postMessage/window.opener it and the login completes) while the tile shows the
  // popup until it closes. Targets we created ourselves (base pages, the Widevine
  // scratch page) have no opener and are ignored.
  function onTargetCreated(info) {
    if (!info || info.type !== 'page') return;
    const owner = info.openerId ? tileOwningTarget(info.openerId) : null;
    if (!owner) {
      // A page target we can't attribute to any tile (opener lost or never set —
      // e.g. a rel=noopener window). Nothing will ever render or close it, so it
      // would linger as a live Edge tab for the whole Edge lifetime — the "ghost
      // pages in Alt+Tab" report. Let the reconciliation sweep reclaim it.
      if (info.targetId !== initialTargetId && !scratchTargets.has(info.targetId)) scheduleOrphanSweep();
      return;
    }
    if (owner.tile.pages.some((p) => p.targetId === info.targetId)) return;  // already tracked
    // Shield the popup from the sweep while adoption is in flight (attachToTarget
    // is an await away from the stack push).
    pendingAdoption.add(info.targetId);
    attachPopup(owner.tileId, info.targetId).finally(() => pendingAdoption.delete(info.targetId));
  }

  async function attachPopup(tileId, targetId) {
    const tile = tiles.get(tileId);
    if (!tile) { send('Target.closeTarget', { targetId }).catch(() => {}); return; }
    let sessionId;
    try { ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })); }
    catch (e) {
      // Attach failed (fast-navigating/self-closing popup, transient CDP error):
      // we'll never track it, so close it — an unattached live target is exactly
      // the window that survives forever in Alt+Tab.
      send('Target.closeTarget', { targetId }).catch(() => {});
      return;
    }
    if (!tiles.has(tileId)) { send('Target.closeTarget', { targetId }).catch(() => {}); return; }  // tile went away meanwhile
    // Silence + stop streaming the opener while the popup is on top.
    const openerSession = activeSession(tile);
    if (openerSession) setPageMuted(openerSession, true);
    if (tile.streaming && openerSession) send('Page.stopScreencast', {}, openerSession).catch(() => {});
    tile.pages.push({ targetId, sessionId });
    bySession.set(sessionId, tileId);
    try { await setupPage(sessionId, tile); } catch (e) { /* best effort */ }
    // Now the popup is the active page — stream it into the same tile canvas.
    if (tile.streaming) startScreencast(tileId).catch(() => {});
  }

  // A popup closing (its window.close(), or the OAuth callback self-closing) fires
  // targetDestroyed. Pop it off the stack and hand the tile back to the opener —
  // which, on a successful login, has meanwhile navigated/refreshed itself into its
  // signed-in state — resuming its stream and address bar.
  function onTargetGone(targetId) {
    const owner = tileOwningTarget(targetId);
    if (!owner) return;
    const { tileId, tile } = owner;
    const idx = tile.pages.findIndex((p) => p.targetId === targetId);
    if (idx <= 0) return;   // base page (0) — tile teardown, handled by closeTile
    const removed = tile.pages.splice(idx);   // drop this popup and anything above it
    removed.forEach((p) => {
      bySession.delete(p.sessionId);
      // The target that just closed is already gone (no-op); any popup stacked ABOVE
      // a popup that closed first would otherwise linger as an untracked live target.
      if (p.targetId !== targetId) send('Target.closeTarget', { targetId: p.targetId }).catch(() => {});
    });
    if (tile.streaming) startScreencast(tileId).catch(() => {});   // re-issues on the opener + repaints + unmutes
    // Refresh the address bar to the opener's current URL.
    const s = activeSession(tile);
    if (s) send('Page.getNavigationHistory', {}, s).then((h) => {
      const e = (h.entries || [])[h.currentIndex];
      if (e && e.url && tile.onNav) tile.onNav(e.url);
    }).catch(() => {});
  }

  // Reconciliation sweep: close every page target that belongs to nobody. This is
  // the hard guarantee behind "a tab closed on the dashboard disappears from the
  // OS too": Edge (even headless) registers its tabs with the Windows shell, so a
  // leaked target keeps showing in Alt+Tab for as long as Edge runs — which, with
  // a long-lived Browser tile keeping Edge alive, can be the whole session.
  // Debounced a few seconds so a popup mid-attribution isn't raced (belt and
  // suspenders on top of the pendingAdoption shield).
  function scheduleOrphanSweep() {
    if (sweepTimer) return;
    sweepTimer = setTimeout(() => { sweepTimer = null; sweepOrphanTargets(); }, 3000);
    sweepTimer.unref && sweepTimer.unref();
  }

  async function sweepOrphanTargets() {
    if (!ws) return;
    let infos;
    try { infos = (await send('Target.getTargets', {})).targetInfos; } catch (e) { return; }
    if (!Array.isArray(infos)) return;
    for (const t of infos) {
      if (!t || t.type !== 'page') continue;
      if (t.targetId === initialTargetId || scratchTargets.has(t.targetId) || pendingAdoption.has(t.targetId)) continue;
      if (tileOwningTarget(t.targetId)) continue;
      send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
    }
  }

  // Push a page's audio-gate state. The gate (AUDIO_SHIM) defaults to muted; this
  // makes a page audible (mu=false) or silent (mu=true). The `&&` guard no-ops if
  // the shim isn't present yet (e.g. a popup mid-first-load).
  function setPageMuted(session, muted) {
    if (!session) return;
    send('Runtime.evaluate', {
      expression: 'window.__xenonAudio&&window.__xenonAudio.set(' + (muted ? 'true' : 'false') + ')',
      returnByValue: true,
    }, session).catch(() => {});
  }

  // Apply a tile's desired audio state to its active page. Called on screencast
  // start/stop and re-asserted after navigation (a fresh document resets the gate).
  function applyAudio(tile) {
    if (!tile) return;
    setPageMuted(activeSession(tile), !tile.audible);
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

  // Configure a freshly-attached page session: identity spoof, the audio gate, size,
  // and auto-attach so ITS popups (and nested ones) surface here too. Used for both
  // the base page and every popup, so a popup is as capable as the tile it came from.
  async function setupPage(sessionId, tile) {
    // Every step is best-effort so a transient reject on one command (common on a
    // fast-navigating OAuth popup) doesn't leave the page half-configured. Popups
    // this page opens are discovered browser-wide (setDiscoverTargets), so no
    // per-session auto-attach is needed — and must not be used: it would invalidate
    // this manually-attached session and kill the screencast.
    await send('Page.enable', {}, sessionId).catch(() => {});
    // Present as a normal desktop Edge. Headless Edge's User-Agent carries a
    // "HeadlessChrome" token that some sites (e.g. Twitch's login) sniff to show a
    // "browser not supported" wall. Reuse the installed Edge's own UA with that
    // token stripped, fetched once and cached.
    if (!userAgent) {
      try {
        const v = await send('Browser.getVersion', {});
        userAgent = String((v && v.userAgent) || '').replace(/Headless/gi, '').replace(/\s{2,}/g, ' ').trim();
      } catch (e) { userAgent = ''; }
    }
    if (userAgent) {
      // Also override the UA-Client-Hints brands. Passing `userAgent` alone leaves
      // `navigator.userAgentData.brands` empty ([]), which is itself a bot tell;
      // supply a normal Chromium/Edge brand list built from the real major version.
      const major = (userAgent.match(/Edg\/(\d+)/) || userAgent.match(/Chrome\/(\d+)/) || [])[1] || '120';
      const brands = [
        { brand: 'Not/A)Brand', version: '24' },
        { brand: 'Chromium', version: major },
        { brand: 'Microsoft Edge', version: major },
      ];
      await send('Emulation.setUserAgentOverride', {
        userAgent,
        userAgentMetadata: {
          brands,
          fullVersionList: brands.map((b) => ({ brand: b.brand, version: major + '.0.0.0' })),
          platform: 'Windows', platformVersion: '15.0.0',
          architecture: 'x86', bitness: '64', model: '', mobile: false, wow64: false,
        },
      }, sessionId).catch(() => {});
    }
    // navigator.webdriver spoof (injected before the page's own scripts run).
    await send('Page.addScriptToEvaluateOnNewDocument', { source: STEALTH_SHIM }, sessionId).catch(() => {});
    // Per-page audio gate (see AUDIO_SHIM). Starts muted; startScreencast makes the
    // visible/active page audible, stopScreencast mutes it again.
    await send('Page.addScriptToEvaluateOnNewDocument', { source: AUDIO_SHIM }, sessionId).catch(() => {});
    await send('Emulation.setDeviceMetricsOverride', { width: tile.w, height: tile.h, deviceScaleFactor: tile.dpr, mobile: false }, sessionId).catch(() => {});
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
    // reqDpr = the display's own pixel ratio (what the client reported); dpr = the
    // scale we actually rasterise at (reqDpr, supersampled for small tiles). Keep both:
    // reqDpr is re-used to recompute the render scale when the tile is resized.
    const reqDpr = Number.isFinite(dpr) && dpr > 0 ? Math.min(dpr, 3) : 1;
    const scale = renderScale(width, height, reqDpr);
    // Size is applied via Emulation.setDeviceMetricsOverride below — passing
    // width/height here is rejected in headless ("only for new windows").
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    // Shield the fresh page from the orphan sweep until it's registered in
    // `tiles` — a sweep scheduled by a recent closeTile (close tab → open tab
    // is a common sequence) could otherwise fire between createTarget and the
    // registration below and reap the new base page as an orphan.
    pendingAdoption.add(targetId);
    let tile;
    try {
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      // A tile owns a STACK of pages: the base page plus any popups layered on top.
      // The last entry is the active page (streamed + driven); see activeSession().
      tile = { pages: [{ targetId, sessionId }], onFrame, onNav, w: width, h: height, dpr: scale, reqDpr, streaming: false, audible: false };
      tiles.set(tileId, tile);
      bySession.set(sessionId, tileId);
    } finally { pendingAdoption.delete(targetId); }
    const sessionId = tile.pages[0].sessionId;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    await setupPage(sessionId, tile);
    // Don't race the Widevine registration: a DRM site (Twitch…) loaded before the
    // CDM is ready brands the tile "unsupported" and stays that way until reloaded.
    await widevineGate();
    await send('Page.navigate', { url: norm.url }, sessionId);
    return { url: norm.url };
  }

  async function navigate(tileId, url) {
    const tile = tiles.get(tileId);
    if (!tile) throw new Error('no_tile');
    const norm = normalizeUrl(url);
    if (!norm.ok) throw new Error(norm.error);
    await widevineGate();
    await send('Page.navigate', { url: norm.url }, activeSession(tile));
    return { url: norm.url };
  }

  async function setSize(tileId, w, h, dpr) {
    const tile = tiles.get(tileId);
    if (!tile) return;
    tile.w = clampDim(w, tile.w);
    tile.h = clampDim(h, tile.h);
    if (Number.isFinite(dpr) && dpr > 0) tile.reqDpr = Math.min(dpr, 3);
    // Recompute the render scale from the new size too: growing a tile spends the pixel
    // budget so it eases off supersampling, shrinking it earns more back.
    tile.dpr = renderScale(tile.w, tile.h, tile.reqDpr || 1);
    const metrics = { width: tile.w, height: tile.h, deviceScaleFactor: tile.dpr, mobile: false };
    // Resize every page in the stack, not just the active one — otherwise a
    // backgrounded opener is left at a stale viewport and streams misfit once the
    // popup on top of it closes.
    for (const p of tile.pages) await send('Emulation.setDeviceMetricsOverride', metrics, p.sessionId).catch(() => {});
    if (tile.streaming) await startScreencast(tileId); // re-issue with new caps
  }

  async function startScreencast(tileId) {
    const tile = tiles.get(tileId);
    if (!tile) return;
    tile.streaming = true;
    // Navigating to a real page briefly tears down the current document; during
    // that window `Page.startScreencast` rejects with "Not attached to an active
    // page". Heavy pages (google, youtube) stay in that window long enough to be
    // hit right after `open()`, which used to kill the whole stream (0 frames → a
    // permanently black tile); fast pages like example.com commit before we ask,
    // which is why they always worked. Retry until the page is attached again.
    for (let attempt = 0; attempt < 20; attempt++) {
      if (!tile.streaming || !tiles.has(tileId)) return;   // stopped/closed meanwhile
      try {
        await send('Page.startScreencast', {
          // quality 85 (not 70): the stream is loopback so bandwidth is free, and the
          // lower setting left visible JPEG softness/ringing on text-heavy pages.
          format: 'jpeg', quality: 85,
          maxWidth: Math.round(tile.w * tile.dpr), maxHeight: Math.round(tile.h * tile.dpr),
          everyNthFrame: 1,
        }, activeSession(tile));
        // `Page.startScreencast` only pushes frames on a compositor change. On an
        // already-painted, static page — the common case after the tile flips
        // hidden→visible, or after a resize that landed while streaming was off —
        // it would otherwise emit nothing and the tile would sit on a stale/blank
        // frame (the "black until you enter layout mode" report: entering edit mode
        // resized the tile, which was the only thing forcing a repaint). Nudge one
        // fresh frame out with a 1px device-metrics wiggle, which reliably repaints.
        await forceFrame(tile);
        tile.audible = true;     // this is now the visible/active tab — let it be heard
        applyAudio(tile);
        return;
      } catch (e) {
        if (!/not attached/i.test(String((e && e.message) || e))) throw e;
        await new Promise((r) => { const tm = setTimeout(r, 150); tm.unref && tm.unref(); });
      }
    }
  }

  // Force a single screencast frame by momentarily perturbing the device metrics.
  // A same-size re-apply does NOT trigger a frame (verified), so we bump the width
  // by 1px and immediately restore it; the transient off-by-one is corrected within
  // the same tick and never reaches a stable frame.
  async function forceFrame(tile) {
    if (!tile) return;
    const base = { width: tile.w, height: tile.h, deviceScaleFactor: tile.dpr, mobile: false };
    const session = activeSession(tile);
    try {
      await send('Emulation.setDeviceMetricsOverride', Object.assign({}, base, { width: tile.w + 1 }), session);
      await send('Emulation.setDeviceMetricsOverride', base, session);
    } catch (e) { /* best effort */ }
  }

  async function stopScreencast(tileId) {
    const tile = tiles.get(tileId);
    if (!tile || !tile.streaming) return;
    tile.streaming = false;
    tile.audible = false;        // no longer the viewed tab — silence it
    applyAudio(tile);
    await send('Page.stopScreencast', {}, activeSession(tile)).catch(() => {});
  }

  async function input(tileId, evt) {
    const tile = tiles.get(tileId);
    if (!tile) return;
    const cmd = inputToCdp(evt);
    if (!cmd) return;
    await send(cmd.method, cmd.params, activeSession(tile)).catch(() => {});
  }

  function navHistory(tileId, dir) {
    const tile = tiles.get(tileId);
    if (!tile) return Promise.resolve();
    const session = activeSession(tile);
    // Back/forward via history entries.
    return send('Page.getNavigationHistory', {}, session).then((h) => {
      const idx = h.currentIndex + (dir < 0 ? -1 : 1);
      const entry = (h.entries || [])[idx];
      if (entry) return send('Page.navigateToHistoryEntry', { entryId: entry.id }, session);
      // Back with no earlier entry while a popup is on top → close the popup and
      // return to its opener. A popup has no window chrome of its own, so this is
      // the user's escape hatch for one that didn't self-close (a plain _blank
      // window rather than a self-closing OAuth callback).
      if (dir < 0 && tile.pages.length > 1) return closeActivePopup(tileId);
    }).catch(() => {});
  }

  // Close the tile's top popup; onTargetGone then pops the stack and restores the
  // opener's stream. Safe no-op when only the base page remains.
  async function closeActivePopup(tileId) {
    const tile = tiles.get(tileId);
    if (!tile || tile.pages.length <= 1) return;
    const popup = tile.pages[tile.pages.length - 1];
    await send('Target.closeTarget', { targetId: popup.targetId }).catch(() => {});
  }

  function reload(tileId) {
    const tile = tiles.get(tileId);
    if (!tile) return Promise.resolve();
    return send('Page.reload', {}, activeSession(tile)).catch(() => {});
  }

  // Wipe the browsing data this tile's page has stored (localStorage, sessionStorage,
  // IndexedDB, Cache Storage, cookies) and hard-reload so the site re-runs from a
  // clean slate. This is the user-facing recovery for a site that cached a stale
  // verdict against the profile — e.g. a "browser not supported" wall an anti-bot
  // check minted earlier and kept showing: clearing the stored data drops that
  // verdict. The in-page wipe is the part that actually heals it; the CDP Storage
  // call is best-effort belt-and-suspenders for cookies/cache. Only this tile's
  // current origin is touched — other tiles and the rest of the profile are unaffected.
  async function clearData(tileId) {
    const tile = tiles.get(tileId);
    if (!tile) throw new Error('no_tile');
    const wipe = [
      '(async function(){',
      '  try { localStorage.clear(); } catch(_){}',
      '  try { sessionStorage.clear(); } catch(_){}',
      '  try { if (indexedDB.databases) { var dbs = await indexedDB.databases(); for (var i=0;i<dbs.length;i++){ try{ indexedDB.deleteDatabase(dbs[i].name); }catch(_){} } } } catch(_){}',
      "  try { if ('caches' in window) { var ks = await caches.keys(); for (var j=0;j<ks.length;j++) await caches.delete(ks[j]); } } catch(_){}",
      '  return location.origin;',
      '})()',
    ].join('\n');
    const session = activeSession(tile);
    let origin = '';
    try {
      const r = await send('Runtime.evaluate', { expression: wipe, awaitPromise: true, returnByValue: true }, session);
      origin = (r && r.result && r.result.value) || '';
    } catch (e) { /* best effort — the reload below still gives a fresh start */ }
    if (origin && /^https?:/i.test(origin)) {
      await send('Storage.clearDataForOrigin', {
        origin,
        storageTypes: 'cookies,cache_storage,indexeddb,local_storage,service_workers,websql',
      }, session).catch(() => {});
    }
    await send('Page.reload', { ignoreCache: true }, session).catch(() => {});
  }

  async function closeTile(tileId) {
    const tile = tiles.get(tileId);
    if (!tile) return;
    tiles.delete(tileId);
    // Close every page in the stack (base + any lingering popups).
    for (const p of tile.pages) {
      bySession.delete(p.sessionId);
      try { await send('Target.closeTarget', { targetId: p.targetId }); } catch (e) { /* ignore */ }
    }
    // Reclaim anything this tile's pages spawned that never got attributed (a
    // rel=noopener window, a popup whose attach raced the close) — otherwise it
    // stays a live Edge tab, still listed in Windows Alt+Tab.
    scheduleOrphanSweep();
    armIdle(); // shut Edge down if this was the last tile
  }

  function available() { return !!findEdge(); }

  function shutdown() { killBrowser('shutdown'); }

  return {
    open, navigate, setSize, startScreencast, stopScreencast, input,
    navHistory, reload, clearData, closeTile, available, shutdown,
    _tiles: tiles, _sweepOrphanTargets: sweepOrphanTargets, // exposed for tests
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

// ── Render resolution ────────────────────────────────────────────────────────
// The tile's sharpness is bounded by the resolution the page is rasterised at:
// deviceScaleFactor × the tile's CSS size. The client reports window.devicePixelRatio,
// but on the embedded (iCUE) surface that reading is flaky and frequently UNDER-reports
// (1.0 when the panel is really ~1.2), so a small dashboard tile ends up rendered at too
// few pixels and looks soft when scaled onto the display.
//
// renderScale() therefore SUPERSAMPLES: it aims to rasterise small tiles at up to
// MIN_SUPERSAMPLE× device pixels (which the canvas then downsamples crisply, and which
// also nudges resolution-aware sites like YouTube to serve sharper assets), while a
// MAX_FRAME_PX budget caps the total raster so a large/expanded tile never renders more
// pixels than we can cheaply JPEG-encode on the software renderer. The result never drops
// below the display's own dpr, so a big tile keeps exactly its native resolution — no
// regression for the already-good expanded case.
const MIN_SUPERSAMPLE = 2;       // target at least 2× device pixels on small tiles…
const MAX_FRAME_PX = 2_600_000;  // …but never rasterise more than ~1920×1350 worth of pixels
function renderScale(w, h, dpr) {
  const base = Number.isFinite(dpr) && dpr > 0 ? Math.min(dpr, 3) : 1;
  const budget = Math.sqrt(MAX_FRAME_PX / Math.max(1, w * h));
  return Math.min(3, Math.max(base, Math.min(MIN_SUPERSAMPLE, budget)));
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

function edgeArgs(profileDir, extensionDirs) {
  const exts = Array.isArray(extensionDirs) ? extensionDirs.filter(Boolean) : [];
  const loadExts = exts.length > 0;
  return [
    '--headless=new',
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    '--user-data-dir=' + profileDir,
    '--no-first-run',
    '--no-default-browser-check',
    // Drop the "controlled by automation" blink flag so navigator.webdriver reads
    // false natively (some sites, e.g. Twitch login, block a webdriver browser as
    // "not supported"). The injected shim also spoofs it as a belt-and-suspenders.
    '--disable-blink-features=AutomationControlled',
    // Render on SwiftShader instead of the real GPU. `--headless=new` streams
    // all-black frames on many machines (older/hybrid GPU drivers, no active
    // session) — reported as a working address bar over a black tile. Software
    // rendering is plenty for a single small tile and renders correctly everywhere.
    '--disable-gpu',
    // NOTE: intentionally NOT `--mute-audio`. Web content should be audible, but
    // per-page (only the visible/active tab) — that gating is done in-page via the
    // AUDIO_SHIM, driven by startScreencast/stopScreencast, not by a global flag.
    // Keep the footprint minimal: a dashboard tile has no use for extensions,
    // background sync/networking, component updates or the crash reporter, each
    // of which is an extra msedge child process. Trimming them keeps one lean
    // browser (main + network + renderer) instead of a cluster of helpers.
    // EXCEPTION: when the user opts into the ad-blocker, we must NOT pass
    // --disable-extensions (it would also disable the --load-extension one) and
    // instead load the unpacked MV3 extension the user chose to install. This is
    // the only path that adds an extension process, and only on explicit opt-in.
    ...(loadExts ? ['--load-extension=' + exts.join(',')] : ['--disable-extensions']),
    '--disable-component-extensions-with-background-pages',
    '--disable-background-networking',
    // NOTE: do NOT add --disable-component-update here. It blocks Edge from
    // registering its bundled Widevine CDM, so DRM sites (Twitch, Netflix, Spotify
    // Web…) declare the tile an "unsupported browser" and refuse to work — even
    // though the UA/webdriver/brands all look like a normal Edge. Verified: with the
    // flag, requestMediaKeySystemAccess('com.widevine.alpha') is rejected and Twitch
    // shows its wall; without it, Widevine is supported and Twitch behaves.
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
async function spawnEdge(exe, profileDir, extensionDirs) {
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  const proc = spawn(exe, edgeArgs(profileDir, extensionDirs), { windowsHide: true });
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

// Sites remember a bot verdict against the profile's cookies, not just the live
// fingerprint: before generation 2 the tile presented itself as headless
// (HeadlessChrome UA, webdriver:true, Widevine rejected), and Twitch kept serving
// "browser not supported" to those same session cookies even after every live
// signal was fixed — deleting the twitch cookies healed it instantly (verified on
// a live tile). So when the fingerprint changes incompatibly, bump this and the
// profile is wiped once; logins could not work before gen 2, so users lose nothing.
const FINGERPRINT_GENERATION = 2;

function resetPoisonedProfile(profileDir) {
  const marker = path.join(profileDir, 'fingerprint-generation');
  let gen = 0;
  try { gen = parseInt(fs.readFileSync(marker, 'utf8'), 10) || 0; } catch (e) { gen = 0; }
  if (gen >= FINGERPRINT_GENERATION) return;
  if (fs.existsSync(path.join(profileDir, 'Default'))) {
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) { /* held file; checked below */ }
    // Wipe incomplete (a file was still locked): leave the marker absent so the
    // next launch retries, rather than sealing a still-poisoned profile as clean.
    if (fs.existsSync(path.join(profileDir, 'Default'))) return;
  }
  try { fs.mkdirSync(profileDir, { recursive: true }); } catch (e) { /* ignore */ }
  try { fs.writeFileSync(marker, String(FINGERPRINT_GENERATION)); } catch (e) { /* ignore */ }
}

// Default real launcher. Self-heals a profile left locked by a previous run:
// first a precise reap of the Edge we recorded, then a spawn; if that still times
// out (something we didn't record is holding the lock) sweep any Edge bound to
// this profile and try once more.
async function defaultLaunch(profileDir, getExtensionDirs) {
  const exe = findEdge();
  if (!exe) throw new Error('edge_not_found');
  try { fs.mkdirSync(profileDir, { recursive: true }); } catch (e) { /* ignore */ }
  await reapStaleProfileEdge(profileDir);   // must run before the reset: it reads edge.pid inside the profile
  resetPoisonedProfile(profileDir);
  clearProfileLocks(profileDir);
  let extensionDirs = [];
  try { extensionDirs = (typeof getExtensionDirs === 'function' ? getExtensionDirs() : []) || []; }
  catch (e) { extensionDirs = []; }   // an extension resolver fault must never block the browser
  try {
    return await spawnEdge(exe, profileDir, extensionDirs);
  } catch (e) {
    if (!/devtools_port_timeout/.test(String(e && e.message))) throw e;
    await sweepProfileEdge(profileDir);
    clearProfileLocks(profileDir);
    return await spawnEdge(exe, profileDir, extensionDirs);
  }
}

module.exports = { createEmbeddedBrowser, findEdge, normalizeUrl, inputToCdp, readDevToolsPort, resetPoisonedProfile, edgeArgs };
