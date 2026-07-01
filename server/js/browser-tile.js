'use strict';
// "Browser" dashboard widget — an interactive web page rendered inside a tile.
//
// The server runs a headless Edge (via CDP) and streams JPEG frames over a single
// loopback WebSocket (/embedded-browser/ws); we draw them onto a <canvas> and send
// pointer/keyboard input back. To keep it cheap, a tile only streams while it's
// actually visible: hidden/off-page tiles stop the screencast immediately and, if
// they stay hidden, close their page so the headless Edge can shut itself down.
//
// Multi-instance safe: each tile is keyed by its grid instance id (the .grid-stack-
// item gs-id), so duplicated Browser tiles each keep their own URL and page.
(function () {
  const t = (k, fb) => {
    const v = typeof window.t === 'function' ? window.t(k) : null;
    if (v && v !== k) return v;              // translated
    return fb != null ? fb : k;              // fall back to the provided default, never the raw key
  };
  const ICON = (p) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
  const ICONS = {
    back: ICON('<path d="M15 18l-6-6 6-6"/>'),
    forward: ICON('<path d="M9 18l6-6-6-6"/>'),
    reload: ICON('<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>'),
    go: ICON('<path d="M5 12h14M13 6l6 6-6 6"/>'),
    expand: ICON('<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>'),
    collapse: ICON('<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>'),
  };

  // CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8.
  function cdpModifiers(e) {
    return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
  }

  // Pure: map a pointer position on the canvas to page CSS coordinates using the
  // latest screencast frame metadata (falls back to the tile size).
  function mapPointerToPage(clientX, clientY, rect, meta, fallbackW, fallbackH) {
    const rx = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    const ry = rect.height > 0 ? (clientY - rect.top) / rect.height : 0;
    const w = (meta && meta.deviceWidth) || fallbackW || rect.width;
    const h = (meta && meta.deviceHeight) || fallbackH || rect.height;
    return {
      x: Math.max(0, Math.min(1, rx)) * w,
      y: Math.max(0, Math.min(1, ry)) * h,
    };
  }

  const tiles = new Map();   // instanceId -> tile state
  let relay = null;          // shared WebSocket to the server relay
  let relayReady = false;
  let available = null;      // null = unknown, true/false once probed
  let perfPaused = false;    // true → suspend streaming (game/performance mode, if opted in)
  const CLOSE_DELAY_MS = 30000;

  // A tile streams only while it's on screen AND not suspended by game/performance
  // mode. Re-evaluated whenever either input changes; showTile/hideTile own the
  // actual screencast start/stop + grace-close.
  function applyTileState(tile, id) {
    const want = tile.onScreen && !perfPaused;
    if (want && !tile.visible) showTile(tile, id);
    else if (!want && tile.visible) hideTile(tile, id);
  }

  // Game/Performance mode suspends the heavy live stream when the user opts in
  // (Settings → Performance → "pause heavy tiles", on by default). The signal is
  // the body class the rest of the app already uses: `.game-mode` while gaming, and
  // `.perf-active` while any optimization session runs (set regardless of whether
  // that session also paused animations).
  function evalPerfPause() {
    let pause = false;
    try {
      const opt = hubSettings && hubSettings.performance && hubSettings.performance.opts;
      const wantsPause = !opt || opt.pauseStreams !== false;   // default: pause
      const active = document.body.classList.contains('game-mode') ||
                     document.body.classList.contains('perf-active');
      pause = wantsPause && active;
    } catch (e) { pause = false; }
    if (pause === perfPaused) return;
    perfPaused = pause;
    tiles.forEach((tile, id) => applyTileState(tile, id));
  }

  // ── Relay socket ────────────────────────────────────────────────────────────
  function ensureRelay() {
    if (relay && (relay.readyState === 0 || relay.readyState === 1)) return;
    try {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      relay = new WebSocket(proto + '//' + location.host + '/embedded-browser/ws');
    } catch (e) { relay = null; return; }
    relayReady = false;
    relay.addEventListener('open', () => {
      relayReady = true;
      // Re-open any tile that should currently be streaming (e.g. after a reconnect).
      tiles.forEach((tile, id) => { tile.opened = false; tile.streaming = false; if (tile.visible && tile.url) openTile(id); });
    });
    relay.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (!m || !m.tile) return;
      const tile = tiles.get(m.tile);
      if (!tile) return;
      if (m.type === 'frame') drawFrame(tile, m.data, m.meta);
      else if (m.type === 'nav' || m.type === 'opened') { if (m.url) setUrlField(tile, m.url); }
      else if (m.type === 'error') handleTileError(tile, m.tile, m.error);
    });
    const drop = () => { relayReady = false; tiles.forEach((tl) => { tl.opened = false; tl.streaming = false; }); };
    relay.addEventListener('close', drop);
    relay.addEventListener('error', drop);
  }

  function relaySend(obj) {
    ensureRelay();
    if (!relay || relay.readyState !== 1) return false;
    try { relay.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
  }

  // ── Per-tile lifecycle ───────────────────────────────────────────────────────
  function tileMetrics(tile) {
    const rect = tile.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return { w: Math.max(64, Math.round(rect.width)), h: Math.max(64, Math.round(rect.height)), dpr };
  }

  function openTile(id) {
    const tile = tiles.get(id);
    if (!tile || !tile.url) return;
    const mtr = tileMetrics(tile);
    if (relaySend({ type: 'open', tile: id, url: tile.url, w: mtr.w, h: mtr.h, dpr: mtr.dpr })) {
      tile.opened = true; tile.streaming = true;
    }
  }

  function showTile(tile, id) {
    tile.visible = true;
    if (tile.closeTimer) { clearTimeout(tile.closeTimer); tile.closeTimer = null; }
    if (!tile.url) return;
    if (!tile.opened) openTile(id);
    else if (!tile.streaming) { if (relaySend({ type: 'screencast', tile: id, on: true })) tile.streaming = true; }
  }

  function hideTile(tile, id) {
    tile.visible = false;
    if (tile.retryTimer) { clearTimeout(tile.retryTimer); tile.retryTimer = null; }   // don't retry an off-screen tile
    if (tile.streaming) { relaySend({ type: 'screencast', tile: id, on: false }); tile.streaming = false; }
    // Give a grace period for quick page flips before freeing the headless page.
    if (tile.closeTimer) clearTimeout(tile.closeTimer);
    tile.closeTimer = setTimeout(() => {
      tile.closeTimer = null;
      if (!tile.visible && tile.opened) { relaySend({ type: 'close', tile: id }); tile.opened = false; }
    }, CLOSE_DELAY_MS);
  }

  function navigateTile(id, rawUrl) {
    const tile = tiles.get(id);
    if (!tile) return;
    const url = String(rawUrl || '').trim();
    if (!url) return;
    tile.url = url;
    tile.launchRetries = 0;              // fresh navigation → fresh retry budget
    if (tile.retryTimer) { clearTimeout(tile.retryTimer); tile.retryTimer = null; }
    setTileUrl(id, url);                 // persist
    if (!tile.opened) openTile(id);
    else relaySend({ type: 'navigate', tile: id, url });
  }

  function drawFrame(tile, b64, meta) {
    if (!b64 || !tile.canvas) return;
    tile.meta = meta || tile.meta;
    let bytes;
    try { const bin = atob(b64); bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); }
    catch (e) { return; }
    const blob = new Blob([bytes], { type: 'image/jpeg' });
    createImageBitmap(blob).then((bmp) => {
      if (tile.canvas.width !== bmp.width || tile.canvas.height !== bmp.height) {
        tile.canvas.width = bmp.width; tile.canvas.height = bmp.height;
      }
      const ctx = tile.ctx || (tile.ctx = tile.canvas.getContext('2d'));
      ctx.drawImage(bmp, 0, 0);
      bmp.close && bmp.close();
      tile.loaded = true;
      tile.launchRetries = 0;             // a live frame means the browser is healthy again
      if (tile.loadingEl) { tile.loadingEl.hidden = true; tile.loadingEl.classList.remove('is-error'); }
    }).catch(() => {});
  }

  const MAX_LAUNCH_RETRIES = 2;

  function isLaunchError(code) {
    return /timeout|connect|launch|exited|closed|port|socket|failed/i.test(String(code || ''));
  }

  // Errors self-heal: a launch failure (usually a headless Edge still shutting
  // down from a previous run) is retried silently a couple of times — the server
  // sweeps stale processes on each attempt — before we ever bother the user. Only
  // a persistent failure surfaces a short, plain message; the user is never asked
  // to close anything by hand.
  function handleTileError(tile, id, code) {
    if (isLaunchError(code) && tile.visible && tile.url) {
      tile.launchRetries = (tile.launchRetries || 0) + 1;
      if (tile.launchRetries <= MAX_LAUNCH_RETRIES) {
        if (tile.loadingEl) { tile.loadingEl.textContent = t('browser_loading', 'Loading…'); tile.loadingEl.classList.remove('is-error'); tile.loadingEl.hidden = false; }
        if (tile.retryTimer) clearTimeout(tile.retryTimer);
        tile.retryTimer = setTimeout(() => {
          tile.retryTimer = null;
          tile.opened = false; tile.streaming = false;
          if (tile.visible && tile.url) openTile(id);
        }, 1500);
        return;
      }
    }
    showTileError(tile, code);
  }

  // Persistent, user-facing message (rare — retries usually recover first).
  function friendlyError(code) {
    const c = String(code || '');
    if (c === 'blocked_scheme') return t('browser_blocked_scheme', 'Only http:// and https:// addresses are allowed.');
    if (c === 'edge_not_found') return t('browser_unavailable', 'Microsoft Edge isn’t installed — it’s required for the Browser widget.');
    if (isLaunchError(c)) return t('browser_err_launch', 'Couldn’t open this page right now. Please try again in a moment.');
    return '';   // no_tile / bad_url / empty_url / unknown → stay quiet
  }

  function showTileError(tile, code) {
    const msg = friendlyError(code);
    if (!msg || !tile.loadingEl) return;
    tile.loadingEl.textContent = msg;
    tile.loadingEl.classList.add('is-error');
    tile.loadingEl.hidden = false;
  }

  // ── Persistence (per-instance URL) ────────────────────────────────────────────
  function getTileUrl(id) {
    try { return (hubSettings.browserTiles && hubSettings.browserTiles[id] && hubSettings.browserTiles[id].url) || ''; }
    catch (e) { return ''; }
  }
  function setTileUrl(id, url) {
    try {
      if (!hubSettings.browserTiles) hubSettings.browserTiles = {};
      hubSettings.browserTiles[id] = { url };
      if (typeof saveHubSettings === 'function') saveHubSettings({ server: true });
    } catch (e) { /* ignore */ }
  }

  function setUrlField(tile, url) { if (tile.urlInput && document.activeElement !== tile.urlInput) tile.urlInput.value = url; tile.url = url; }

  // ── Skeleton + input wiring ───────────────────────────────────────────────────
  function instanceIdOf(section) {
    const item = section.closest('.grid-stack-item');
    return (item && item.getAttribute('gs-id')) || 'browser';
  }

  function buildSkeleton(mount, id) {
    const wrap = document.createElement('div');
    wrap.className = 'browser-wrap';

    const bar = document.createElement('div');
    bar.className = 'browser-bar';
    const mkBtn = (cls, icon, titleKey, fb, onClick) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'browser-btn ' + cls;
      b.innerHTML = icon; b.title = t(titleKey, fb);
      b.addEventListener('click', onClick);
      return b;
    };
    const back = mkBtn('browser-back', ICONS.back, 'browser_back', 'Back', () => relaySend({ type: 'history', tile: id, dir: -1 }));
    const fwd = mkBtn('browser-fwd', ICONS.forward, 'browser_forward', 'Forward', () => relaySend({ type: 'history', tile: id, dir: 1 }));
    const reload = mkBtn('browser-reload', ICONS.reload, 'browser_reload', 'Reload', () => relaySend({ type: 'reload', tile: id }));
    const input = document.createElement('input');
    input.type = 'text'; input.className = 'browser-url'; input.spellcheck = false;
    input.setAttribute('data-i18n-placeholder', 'browser_url_placeholder');
    input.placeholder = t('browser_url_placeholder', 'Enter an address…');
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); navigateTile(id, input.value); input.blur(); } });
    const go = mkBtn('browser-go', ICONS.go, 'browser_reload', 'Go', () => navigateTile(id, input.value));
    const expand = mkBtn('browser-expand', ICONS.expand, 'browser_expand', 'Expand', () => toggleExpand(id));
    bar.append(back, fwd, reload, input, go, expand);

    const stage = document.createElement('div');
    stage.className = 'browser-stage';
    const canvas = document.createElement('canvas');
    canvas.className = 'browser-canvas';
    canvas.tabIndex = 0;                 // focusable so it can receive keyboard
    const loading = document.createElement('div');
    loading.className = 'browser-loading'; loading.textContent = t('browser_loading', 'Loading…'); loading.hidden = true;
    stage.append(canvas, loading);

    wrap.append(bar, stage);
    mount.replaceChildren(wrap);

    const tile = { id, mount, wrap, stage, canvas, urlInput: input, expandBtn: expand, loadingEl: loading,
      ctx: null, meta: null, url: '', opened: false, streaming: false, visible: false, onScreen: false,
      loaded: false, closeTimer: null, moveQueued: false, expanded: false };
    tiles.set(id, tile);
    tile.url = getTileUrl(id);
    if (tile.url) input.value = tile.url;

    wireInput(tile, id);
    observeVisibility(tile, id, mount);
    return tile;
  }

  function wireInput(tile, id) {
    const canvas = tile.canvas;
    const sendMouse = (subtype, e) => {
      if (!tile.streaming) return;
      const pt = mapPointerToPage(e.clientX, e.clientY, canvas.getBoundingClientRect(), tile.meta, tile.lastW, tile.lastH);
      const button = e.button === 1 ? 'middle' : e.button === 2 ? 'right' : 'left';
      relaySend({ type: 'input', tile: id, event: { kind: 'mouse', subtype, x: pt.x, y: pt.y, button, buttons: e.buttons, clickCount: subtype === 'released' || subtype === 'pressed' ? (e.detail || 1) : 0, modifiers: cdpModifiers(e) } });
    };
    canvas.addEventListener('pointerdown', (e) => { canvas.focus(); canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId); sendMouse('pressed', e); e.preventDefault(); });
    canvas.addEventListener('pointerup', (e) => { sendMouse('released', e); });
    canvas.addEventListener('pointermove', (e) => {
      if (!tile.streaming || tile.moveQueued) return;     // throttle to one move per frame
      tile.moveQueued = true;
      requestAnimationFrame(() => { tile.moveQueued = false; });
      sendMouse('moved', e);
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', (e) => {
      if (!tile.streaming) return;
      const pt = mapPointerToPage(e.clientX, e.clientY, canvas.getBoundingClientRect(), tile.meta, tile.lastW, tile.lastH);
      relaySend({ type: 'input', tile: id, event: { kind: 'wheel', x: pt.x, y: pt.y, deltaX: e.deltaX, deltaY: e.deltaY, modifiers: cdpModifiers(e) } });
      e.preventDefault();
    }, { passive: false });
    canvas.addEventListener('keydown', (e) => {
      if (!tile.streaming) return;
      relaySend({ type: 'input', tile: id, event: { kind: 'key', subtype: 'down', key: e.key, code: e.code, keyCode: e.keyCode, modifiers: cdpModifiers(e) } });
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
        relaySend({ type: 'input', tile: id, event: { kind: 'key', subtype: 'char', text: e.key, key: e.key, modifiers: cdpModifiers(e) } });
      }
      // Keep page-driving keys inside the canvas (don't scroll/redirect the dashboard).
      if (['Tab', 'Backspace', ' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(e.key)) e.preventDefault();
    });
    canvas.addEventListener('keyup', (e) => {
      if (!tile.streaming) return;
      relaySend({ type: 'input', tile: id, event: { kind: 'key', subtype: 'up', key: e.key, code: e.code, keyCode: e.keyCode, modifiers: cdpModifiers(e) } });
    });

    // Resize → tell the server to re-render at the new size (debounced via rAF).
    let roQueued = false;
    const ro = new ResizeObserver(() => {
      if (roQueued) return; roQueued = true;
      requestAnimationFrame(() => {
        roQueued = false;
        const m = tileMetrics(tile); tile.lastW = m.w; tile.lastH = m.h;
        if (tile.opened) relaySend({ type: 'resize', tile: id, w: m.w, h: m.h, dpr: m.dpr });
      });
    });
    ro.observe(tile.stage);
  }

  // Visibility = section not hidden and actually on screen. Drives stream start/stop.
  function observeVisibility(tile, id, mount) {
    const section = mount.closest('.dashboard-widget') || mount.parentElement;
    if (!section) return;
    tile.section = section;
    const evaluate = () => {
      const hidden = section.getAttribute('data-dashboard-hidden') === 'true';
      const onScreen = section.offsetParent !== null && section.clientWidth > 0;
      tile.onScreen = !hidden && onScreen;
      applyTileState(tile, id);
    };
    const mo = new MutationObserver(evaluate);
    mo.observe(section, { attributes: true, attributeFilter: ['data-dashboard-hidden', 'style', 'class'] });
    tile._evaluate = evaluate;
    evaluate();
  }

  // ── Expand to a true full-viewport overlay ────────────────────────────────────
  // The tile lives inside the GridStack item, whose stacking context (and the
  // Xeneon Edge's root `zoom` compensation) would trap/garble a position:fixed
  // child. So we *portal the wrap to <body>* and pin it with bare inset:0 — the
  // same approach the lock screen uses for a reliable full-screen overlay. Native
  // OS fullscreen is layered on top only as a bonus where the host allows it
  // (a normal browser tab); it's blocked inside the iCUE WebView iframe, where the
  // body overlay already fills the screen.
  function toggleExpand(id) {
    const tile = tiles.get(id);
    if (!tile) return;
    if (tile.expanded) collapse(tile); else expand(tile);
  }
  function expand(tile) {
    if (tile.expanded) return;
    tile.expanded = true;
    document.body.appendChild(tile.wrap);              // portal out of the tile
    tile.wrap.classList.add('browser-overlay');
    tile.expandBtn.innerHTML = ICONS.collapse; tile.expandBtn.title = t('browser_collapse', 'Collapse');
    if (tile.wrap.requestFullscreen) {
      tile.wrap.requestFullscreen().catch(() => {});   // overlay already covers if denied
      if (!tile._fsHandler) {
        // Esc-ing out of OS fullscreen also collapses the overlay.
        tile._fsHandler = () => { if (!document.fullscreenElement && tile.expanded) collapse(tile); };
        document.addEventListener('fullscreenchange', tile._fsHandler);
      }
    }
  }
  function collapse(tile) {
    if (!tile.expanded) return;
    tile.expanded = false;
    tile.wrap.classList.remove('browser-overlay');
    tile.expandBtn.innerHTML = ICONS.expand; tile.expandBtn.title = t('browser_expand', 'Expand');
    if (tile._fsHandler) { document.removeEventListener('fullscreenchange', tile._fsHandler); tile._fsHandler = null; }
    if (document.fullscreenElement) { try { document.exitFullscreen(); } catch (e) { /* ignore */ } }
    if (tile.mount) tile.mount.appendChild(tile.wrap); // restore into the tile
  }

  // ── Scanning ──────────────────────────────────────────────────────────────────
  function scan() {
    if (typeof document === 'undefined') return;
    if (available === false) { showUnavailable(); return; }
    document.querySelectorAll('[data-dashboard-widget="browser"]').forEach((section) => {
      const mount = section.querySelector('.browser-widget-mount');
      if (!mount) return;
      const id = instanceIdOf(section);
      const existing = tiles.get(id);
      // While expanded the wrap is portaled to <body>, so it's intentionally not
      // inside its mount — don't mistake that for a missing tile and rebuild it.
      if (existing && existing.expanded) { existing.mount = mount; return; }
      if (existing && existing.wrap && mount.contains(existing.wrap)) { existing._evaluate && existing._evaluate(); return; }
      buildSkeleton(mount, id);
    });
    // Release any tile whose widget was deleted from the dashboard so its headless
    // page is freed (and the relay tile closed) instead of lingering until reload.
    tiles.forEach((tile, id) => {
      if (tile.section && !document.contains(tile.section)) {
        if (tile.closeTimer) { clearTimeout(tile.closeTimer); tile.closeTimer = null; }
        if (tile.opened) relaySend({ type: 'close', tile: id });
        tiles.delete(id);
      }
    });
    // Pick up a changed "pause heavy tiles" setting without waiting for a mode flip.
    evalPerfPause();
  }

  function showUnavailable() {
    document.querySelectorAll('[data-dashboard-widget="browser"] .browser-widget-mount').forEach((mount) => {
      if (mount.querySelector('.browser-unavailable')) return;
      const div = document.createElement('div');
      div.className = 'browser-unavailable';
      div.textContent = t('browser_unavailable', 'Microsoft Edge isn’t installed — it’s required for the Browser widget.');
      mount.replaceChildren(div);
    });
  }

  function probeAvailability() {
    fetch('/embedded-browser/available').then((r) => r.json()).then((d) => {
      available = !!(d && d.available);
      scan();
    }).catch(() => { available = true; scan(); });   // assume present; the relay will no-op if not
  }

  function init() {
    probeAvailability();
    // Re-scan when tiles are added/duplicated or the layout re-renders.
    let queued = false;
    const obs = new MutationObserver(() => {
      if (queued) return; queued = true;
      requestAnimationFrame(() => { queued = false; scan(); });
    });
    obs.observe(document.body, { childList: true, subtree: true });
    // React to game/performance mode toggling (the app flips body .game-mode /
    // .perf-mode) so heavy streaming is suspended/resumed promptly.
    new MutationObserver(evalPerfPause).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    evalPerfPause();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // Expose pure helpers for tests / debugging.
  window.BrowserTile = { mapPointerToPage, cdpModifiers };
})();
