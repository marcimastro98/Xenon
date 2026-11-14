'use strict';
const path = require('path');

const DEFAULT_WS = (() => {
  try { return require('ws'); } catch (e) { return globalThis.WebSocket; }
})();

// ── Pure helpers (exported for tests) ────────────────────────────────────────

const { findEdge } = require('./windows-tiles/browser-find.js');

const { normalizeUrl } = require('./windows-tiles/browser-address.js');

const { inputToCdp } = require('./windows-tiles/browser-input.js');

// ── CDP host ─────────────────────────────────────────────────────────────────

const { clampDim, renderScale } = require('./windows-tiles/browser-render-size.js');

const { makeTileState } = require('./windows-tiles/browser-tile-state.js');

const { makePageSetup } = require('./windows-tiles/browser-page-setup.js');

const { makeStream } = require('./windows-tiles/browser-stream.js');

const { makeTargets } = require('./windows-tiles/browser-targets.js');

const { makeTileActions } = require('./windows-tiles/browser-tile-actions.js');

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
  const edge = {
    lastStallRestartAt: -Infinity,
    proc: null,
    ws: null,
    ready: null,            // Promise<void> resolved once the CDP socket is open
    userAgent: '',          // real Edge UA with "Headless" stripped (fetched lazily)
    widevineReady: null,    // Promise: resolves once the Widevine CDM is registered
    nextId: 1,
    idleTimer: null,
  };
  // Called fresh at each Edge launch → returns the unpacked extension dirs to load
  // (e.g. the opt-in ad-blocker). Read at launch time so a settings toggle takes
  // effect on the next relaunch without touching this module's state.
  const getExtensionDirs = typeof o.getExtensionDirs === 'function' ? o.getExtensionDirs : () => [];
  const launch = o.launch || (() => defaultLaunch(profileDir, getExtensionDirs));

  const pending = new Map();   // cdp message id -> { resolve, reject }
  const tiles = new Map();     // tileId -> { targetId, sessionId, onFrame, onNav, w, h, dpr }
  const bySession = new Map(); // CDP sessionId -> tileId
  const orphanSweep = {
    // Every page target must be attributable: a tile's stack, the launch's own
    // about:blank, a scratch page, or a popup mid-adoption. Anything else is an
    // orphan — a live Edge tab nobody renders or will ever close, which Windows 11
    // keeps listing in Alt+Tab (Edge registers its tabs with the shell even
    // headless). The sweep below closes those; these three sets are its allowlist.
    initialTargetId: null,      // the about:blank tab Edge starts with
    sweepTimer: null,
  };
  const scratchTargets = new Set(); // internal helper pages (Widevine warm-up)
  const pendingAdoption = new Set(); // popups between discovery and stack push

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

  const {
    activeSession, clearResizeSettle, screencastParams, nextFrame, releaseFrameWaiters,
  } = makeTileState();

  const {
    killBrowser, armIdle, ensureBrowser, widevineGate, send,
  } = makeConnection({ WebSocketImpl, idleMs, cmdTimeoutMs, navTimeoutMs, edge, launch, pending, tiles, bySession, orphanSweep, scratchTargets, pendingAdoption, createTargetWindow, onMessage, clearResizeSettle, releaseFrameWaiters, checkAlive });

  const {
    setPageMuted, applyAudio, setupPage, forceFrame,
  } = makePageSetup({ edge, activeSession, send });

  // One command went unanswered. A browser-level question Edge answers at once
  // when it is alive tells a slow page from a hung browser: only the second is
  // torn down, and the tile's own retry (browser-tile.js, on any *timeout* error)
  // then opens on a fresh Edge. One probe at a time, and only for the socket
  // that timed out, so a teardown already under way is not repeated.
  let probing = false;
  function checkAlive(sock) {
    if (probing || sock !== edge.ws) return;
    probing = true;
    send('Browser.getVersion', {}, undefined, probeTimeoutMs).then(
      () => { probing = false; },
      () => {
        probing = false;
        if (sock !== edge.ws) return;
        console.warn('[embedded-browser] Edge stopped answering: restarting it');
        // A reason the tiles' retry recognises (browser-tile.js isLaunchError
        // matches "closed"), so a tile whose command was cut short reopens too.
        killBrowser('hung_closed');
      },
    );
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
    if (edge.idleTimer) { clearTimeout(edge.idleTimer); edge.idleTimer = null; }
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

  const {
    startScreencast, stopScreencast,
  } = makeStream({ frameWaitMs, stallRestartGapMs, edge, tiles, killBrowser, activeSession, screencastParams, nextFrame, releaseFrameWaiters, applyAudio, forceFrame, send });

  const {
    onEvent, scheduleOrphanSweep, sweepOrphanTargets,
  } = makeTargets({ edge, tiles, bySession, orphanSweep, scratchTargets, pendingAdoption, activeSession, releaseFrameWaiters, setPageMuted, applyAudio, setupPage, send, startScreencast });

  const {
    setSize, input, navHistory, reload, clearData, closeTile,
  } = makeTileActions({ tiles, bySession, armIdle, activeSession, clearResizeSettle, releaseFrameWaiters, send, scheduleResizeSettle, startScreencast, scheduleOrphanSweep });

  function available() { return !!findEdge(); }

  function shutdown() { killBrowser('shutdown'); }

  return {
    open, navigate, setSize, startScreencast, stopScreencast, input,
    navHistory, reload, clearData, closeTile, available, shutdown,
    _tiles: tiles, _sweepOrphanTargets: sweepOrphanTargets, // exposed for tests
  };
}

const { resetPoisonedProfile } = require('./windows-tiles/browser-profile.js');

const { readDevToolsPort, edgeArgs, defaultLaunch } = require('./windows-tiles/browser-launch.js');

const { makeConnection } = require('./windows-tiles/browser-connection.js');

module.exports = { createEmbeddedBrowser, findEdge, normalizeUrl, inputToCdp, readDevToolsPort, resetPoisonedProfile, edgeArgs };
