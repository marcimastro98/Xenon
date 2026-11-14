'use strict';
const path = require('path');

const DEFAULT_WS = (() => {
  try { return require('ws'); } catch (e) { return globalThis.WebSocket; }
})();

// ── Pure helpers (exported for tests) ────────────────────────────────────────

const { findEdge } = require('./windows-tiles/browser-find.js');

const { normalizeUrl } = require('./windows-tiles/browser-address.js');

const { inputToCdp } = require('./windows-tiles/browser-input.js');

const { STEALTH_SHIM, AUDIO_SHIM } = require('./windows-tiles/browser-page-shims.js');

// ── CDP host ─────────────────────────────────────────────────────────────────

const {
  FRAME_INTERVAL_MS, clampDim, renderScale,
} = require('./windows-tiles/browser-render-size.js');

// opts: { WebSocketImpl, launch, dataDir, idleMs } — all injectable for tests.
// `launch(profileDir)` -> Promise<{ proc, wsUrl }>.
function createEmbeddedBrowser(opts) {
  const o = opts || {};
  const WebSocketImpl = o.WebSocketImpl || DEFAULT_WS;
  const dataDir = o.dataDir || path.join(__dirname, 'data');
  const profileDir = path.join(dataDir, 'embedded-browser-profile');
  const idleMs = Number.isFinite(o.idleMs) ? o.idleMs : 15000;
  // How long a DevTools command may go unanswered (issue #144). Before this,
  // send() waited forever: an Edge that stayed alive but stopped answering left
  // every tile on its loading spinner until somebody killed Edge by hand,
  // because nothing ever failed for the self-healing below to act on.
  // Navigation gets longer: it answers only once the page has committed, and a
  // slow site is not a broken browser.
  const cmdTimeoutMs = Number.isFinite(o.cmdTimeoutMs) ? o.cmdTimeoutMs : 30000;
  const navTimeoutMs = Number.isFinite(o.navTimeoutMs) ? o.navTimeoutMs : 60000;
  const probeTimeoutMs = Number.isFinite(o.probeTimeoutMs) ? o.probeTimeoutMs : 5000;
  // How long a started screencast may go without painting a frame (issue #144,
  // still seen on 5.0). Edge can keep answering every command while it draws
  // nothing: a lost frame ack holds the stream forever, or the renderer stops
  // compositing. Nothing failed, so the tile sat on its spinner with no error.
  // A healthy Edge paints the forced frame in well under a second.
  const frameWaitMs = Number.isFinite(o.frameWaitMs) ? o.frameWaitMs : 15000;
  // A page can stall on its own (a script that never yields). Restarting the
  // shared Edge for it would blank every other tile, and a page that does it on
  // purpose could do it on every reload: at most one stall restart per window.
  const stallRestartGapMs = Number.isFinite(o.stallRestartGapMs) ? o.stallRestartGapMs : 120000;
  let lastStallRestartAt = -Infinity;
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
    tiles.forEach(clearResizeSettle);
    tiles.forEach(releaseFrameWaiters);
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

  // Open a page in a browser WINDOW of its own rather than as a tab in the
  // shared one.
  //
  // Chromium composites only the foreground tab of a window, and
  // `Page.startScreencast` is driven by the compositor - so as tabs, every tile
  // but the most recently created one simply stopped producing frames. It never
  // looked like a stall: the older tile kept its last picture, forever, because
  // a screencast is change-driven and there were no more changes to send.
  //
  // That is GitHub #116. Two dashboards open at once (a browser window on the PC
  // and the XENEON EDGE) each open their own page for the same tile, by design -
  // they can be different sizes. Whichever opened last took the foreground and
  // the other froze, and closing either one brought the survivor back to life,
  // which is exactly what the reporter described. Measured here before and after:
  // two 1280x720 tiles on a page repainting every frame went from 0.0 and 23.7
  // frames per second to 24.0 and 23.8.
  //
  // The throttling flags in edgeArgs are a different fault with a similar smell
  // (a stream dying ~5 minutes in, #116's original report) and are still needed:
  // they keep an off-screen window's timers running. They cannot help here,
  // because a background TAB is not composited at all.
  //
  // `newWindow` has been understood since Chrome 86 and headless accepts it (its
  // own error for width/height says they are "only for new windows"). A build
  // that rejects it still gets a tile - one that behaves exactly as it did
  // before - rather than no tile at all.
  let newWindowSupported = true;
  async function createTargetWindow(url) {
    if (newWindowSupported) {
      try { return await send('Target.createTarget', { url, newWindow: true }); }
      catch (e) {
        if (!/invalid parameter|newwindow|not supported|unknown/i.test(String((e && e.message) || e))) throw e;
        newWindowSupported = false;
      }
    }
    return send('Target.createTarget', { url });
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
        ({ targetId } = await createTargetWindow('about:blank'));
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
      // Frame-rate cap via deferred ack. Edge holds the next screencast frame
      // until the previous one is ACKed, so spacing the acks is a real cap at
      // the source: the headless renderer never rasterises (SwiftShader, all
      // CPU) or JPEG-encodes frames we haven't asked for. A still page is
      // change-driven and unaffected; a page whose compositor changes every
      // frame — a live camera stream (GitHub #99) — is held to MAX_STREAM_FPS
      // instead of pinning CPU cores at the page's own frame rate. The ack
      // uses the frame's own numeric sessionId, distinct from the CDP target
      // sessionId.
      // The deferred ack timer is at most FRAME_INTERVAL_MS away and self-
      // expires (unref'd); a tile torn down inside that window just acks a
      // dead session, which the catch swallows — no handle bookkeeping needed.
      const ack = () => send('Page.screencastFrameAck', { sessionId: params.sessionId }, sessionId).catch(() => {});
      const tile = tileId && tiles.get(tileId);
      const now = Date.now();
      const dueAt = tile ? Math.max(now, tile.nextAckAt || 0) : now;
      if (tile) tile.nextAckAt = dueAt + FRAME_INTERVAL_MS;
      if (dueAt <= now) ack();
      else { const tm = setTimeout(ack, dueAt - now); tm.unref && tm.unref(); }
      // Only the tile's active page paints the tile (a backgrounded opener under a
      // popup must not fight the popup for the canvas).
      if (tile && sessionId === activeSession(tile)) {
        releaseFrameWaiters(tile);
        if (tile.onFrame) tile.onFrame(params.data, params.metadata || {});
      }
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

  function send(method, params, sessionId, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!ws) { reject(new Error('no_socket')); return; }
      const id = nextId++;
      const sock = ws;
      const limit = Number.isFinite(timeoutMs) ? timeoutMs
        : (method === 'Page.navigate' ? navTimeoutMs : cmdTimeoutMs);
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error('cdp_timeout'));
        checkAlive(sock);
      }, limit);
      timer.unref && timer.unref();
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      const frame = { id, method, params: params || {} };
      if (sessionId) frame.sessionId = sessionId;
      try { ws.send(JSON.stringify(frame)); }
      catch (e) { pending.delete(id); clearTimeout(timer); reject(e); }
    });
  }

  // One command went unanswered. A browser-level question Edge answers at once
  // when it is alive tells a slow page from a hung browser: only the second is
  // torn down, and the tile's own retry (browser-tile.js, on any *timeout* error)
  // then opens on a fresh Edge. One probe at a time, and only for the socket
  // that timed out, so a teardown already under way is not repeated.
  let probing = false;
  function checkAlive(sock) {
    if (probing || sock !== ws) return;
    probing = true;
    send('Browser.getVersion', {}, undefined, probeTimeoutMs).then(
      () => { probing = false; },
      () => {
        probing = false;
        if (sock !== ws) return;
        console.warn('[embedded-browser] Edge stopped answering: restarting it');
        // A reason the tiles' retry recognises (browser-tile.js isLaunchError
        // matches "closed"), so a tile whose command was cut short reopens too.
        killBrowser('hung_closed');
      },
    );
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
    // Size is applied via Emulation.setDeviceMetricsOverride below, not here:
    // the window is created empty and the viewport emulated into it.
    const { targetId } = await createTargetWindow('about:blank');
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
      tile = { pages: [{ targetId, sessionId }], onFrame, onNav, w: width, h: height, dpr: scale, reqDpr, streaming: false, audible: false, nextAckAt: 0, settleTimer: null, frameWaiters: new Set(), recovering: false };
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
    if (tile.streaming) {
      await startScreencast(tileId);   // re-issue with new caps (this also forces one frame)
      scheduleResizeSettle(tileId, tile);
    }
  }

  // A resize is one CDP call, but the repaint it needs is not instantaneous. The
  // single frame startScreencast forces can be captured while the page is still
  // relaying out at the previous size, and because the screencast is change-driven
  // that frame is then the LAST one a page which goes still ever emits: the tile
  // keeps showing the old viewport indefinitely (GitHub #116 — the Browser tile left
  // filling a fraction of its box after "Hide toolbar"). Force one more frame once
  // the page has had time to settle. Replaces any pending follow-up for the same
  // tile, and is dropped when the tile goes away.
  const RESIZE_SETTLE_MS = 350;
  function scheduleResizeSettle(tileId, tile) {
    clearResizeSettle(tile);
    tile.settleTimer = setTimeout(() => {
      tile.settleTimer = null;
      if (tiles.get(tileId) !== tile || !tile.streaming) return;
      forceFrame(tile).catch(() => {});
    }, RESIZE_SETTLE_MS);
    tile.settleTimer.unref && tile.settleTimer.unref();
  }

  function clearResizeSettle(tile) {
    if (tile && tile.settleTimer) { clearTimeout(tile.settleTimer); tile.settleTimer = null; }
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
      let painted = null;
      try {
        // Watched from before the start: Edge may push the first frame ahead of
        // the command's own answer.
        painted = nextFrame(tile, frameWaitMs);
        await send('Page.startScreencast', screencastParams(tile), activeSession(tile));
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
        if (!(await painted)) await recoverStalledStream(tileId, tile);
        return;
      } catch (e) {
        painted.cancel();
        if (!/not attached/i.test(String((e && e.message) || e))) throw e;
        await new Promise((r) => { const tm = setTimeout(r, 150); tm.unref && tm.unref(); });
      }
    }
  }

  function screencastParams(tile) {
    return {
      // quality 85 (not 70): the stream is loopback so bandwidth is free, and the
      // lower setting left visible JPEG softness/ringing on text-heavy pages.
      format: 'jpeg', quality: 85,
      maxWidth: Math.round(tile.w * tile.dpr), maxHeight: Math.round(tile.h * tile.dpr),
      everyNthFrame: 1,
    };
  }

  // Resolves true on the tile's next painted frame, false after `ms` without one.
  // `cancel()` drops the watch when the start it guarded failed.
  function nextFrame(tile, ms) {
    let done = null;
    const p = new Promise((resolve) => {
      done = (got) => { clearTimeout(tm); tile.frameWaiters.delete(done); resolve(got); };
      const tm = setTimeout(() => done(false), ms);
      tm.unref && tm.unref();
      tile.frameWaiters.add(done);
    });
    p.cancel = () => done(true);
    return p;
  }

  // A stop, a close or a teardown is not a stall: wake the waiters as "painted".
  function releaseFrameWaiters(tile) {
    if (tile && tile.frameWaiters) [...tile.frameWaiters].forEach((done) => done(true));
  }

  // The stream started but never painted (#144). Restarting it clears a lost frame
  // ack, which holds every later frame. If that paints nothing either, the page or
  // the renderer is stuck while Edge still answers: see escalateStall. Either way
  // the error names a closed page, which the tile retries by reopening it.
  async function recoverStalledStream(tileId, tile) {
    if (tile.recovering) return;   // a concurrent start is already on it
    tile.recovering = true;
    try {
      console.warn('[embedded-browser] a page stopped sending frames: restarting its stream');
      const session = activeSession(tile);
      await send('Page.stopScreencast', {}, session).catch(() => {});
      if (!tile.streaming || tiles.get(tileId) !== tile) return;
      tile.nextAckAt = 0;
      const painted = nextFrame(tile, frameWaitMs);
      try {
        await send('Page.startScreencast', screencastParams(tile), session);
      } catch (e) { painted.cancel(); throw e; }
      await forceFrame(tile);
      if (await painted) return;
      if (!tile.streaming || tiles.get(tileId) !== tile) return;
      await escalateStall(tile);
      throw new Error('stalled_closed');
    } finally {
      tile.recovering = false;
    }
  }

  // Edge is restarted only when the stall is Edge's: no other tile on screen
  // still paints when asked, and no stall restart happened in the last window.
  // Otherwise only this page is reopened (by the tile's retry), and the others
  // keep running.
  async function escalateStall(tile) {
    if (await anotherTilePaints(tile)) return;
    const now = Date.now();
    if (now - lastStallRestartAt < stallRestartGapMs) return;
    lastStallRestartAt = now;
    console.warn('[embedded-browser] Edge stopped drawing pages: restarting it');
    killBrowser('stalled_closed');
  }

  async function anotherTilePaints(tile) {
    const peer = [...tiles.values()].find((t) => t !== tile && t.streaming);
    if (!peer) return false;
    const painted = nextFrame(peer, frameWaitMs);
    await forceFrame(peer);
    return painted;
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
    releaseFrameWaiters(tile);
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
    clearResizeSettle(tile);
    releaseFrameWaiters(tile);
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

const { resetPoisonedProfile } = require('./windows-tiles/browser-profile.js');

const {
  readDevToolsPort, killProcessTree, edgeArgs, defaultLaunch,
} = require('./windows-tiles/browser-launch.js');

module.exports = { createEmbeddedBrowser, findEdge, normalizeUrl, inputToCdp, readDevToolsPort, resetPoisonedProfile, edgeArgs };
