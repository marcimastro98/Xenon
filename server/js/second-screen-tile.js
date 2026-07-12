'use strict';
// "Second screen" dashboard widget — a live view of a real virtual monitor.
//
// A signed Virtual Display Driver (installed one-click from this tile) adds a
// genuine extra Windows desktop; the Xenon Helper captures it (GDI) and streams
// JPEG frames over a loopback WebSocket (/second-screen/ws), which we draw onto a
// <canvas>. Like the Browser tile, it only streams while actually visible and
// suspends under game/performance mode, so an unused tile costs nothing.
//
// Single-instance by design: there is one virtual display, so this widget is not
// duplicable. v1 is view + one-click setup; pointer/keyboard control is added in
// a follow-up (the capture/relay seam is already in place).
(function () {
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));
  const ICON = (p) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
  const ICONS = {
    expand: ICON('<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>'),
    collapse: ICON('<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>'),
    screen: ICON('<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>'),
    // fill = "fill the tile (crop)"; fit = "show the whole screen (letterbox)".
    fill: ICON('<rect x="2" y="5" width="20" height="14" rx="2"/>'),
    fit: ICON('<rect x="2" y="5" width="20" height="14" rx="2"/><rect x="7" y="9" width="10" height="6" rx="1"/>'),
    // touchPointer = finger drives the screen; touchScroll = finger scrolls the dashboard.
    touchPointer: ICON('<path d="M5 3l5 16 2.5-6.5L19 10z"/>'),
    touchScroll: ICON('<path d="M12 4v16M7 9l5-5 5 5M7 15l5 5 5-5"/>'),
    // tune = quick FPS/quality presets (sliders).
    tune: ICON('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.5"/><circle cx="9" cy="17" r="2.5"/>'),
  };

  const CLOSE_DELAY_MS = 8000;     // grace before tearing the capture down on hide
  const tiles = new Map();         // instanceId -> tile state
  let relay = null;
  let perfPaused = false;

  // ── Streaming gate (visible AND not suspended by game/performance mode) ───────
  function applyTileState(tile, id) {
    const want = tile.onScreen && !perfPaused && tile.ready;
    if (want && !tile.streaming) startStream(tile, id);
    else if (!want && tile.streaming) stopStream(tile, id);
  }

  // Same opt-in signal the Browser tile uses: body `.game-mode` (gaming) or
  // `.perf-active` (any optimization session) plus the user's "pause heavy tiles"
  // setting (on by default). So gaming AND a manual/auto optimization both close
  // the capture when the user wants it — never otherwise.
  function evalPerfPause() {
    let pause = false;
    try {
      const opt = hubSettings && hubSettings.performance && hubSettings.performance.opts;
      const wantsPause = !opt || opt.pauseStreams !== false;
      const active = document.body.classList.contains('game-mode') ||
                     document.body.classList.contains('perf-active');
      pause = wantsPause && active;
    } catch (e) { pause = false; }
    if (pause === perfPaused) return;
    perfPaused = pause;
    tiles.forEach((tile, id) => applyTileState(tile, id));
  }

  // ── Relay socket (shared; one capture host serves one tile) ───────────────────
  // Frames arrive as binary WebSocket messages ([u16BE header length][JSON
  // header][JPEG bytes]) — requested via {binary:true} on 'start'. No base64 layer
  // on the wire and no per-frame atob loop on the main thread; the JSON 'frame'
  // branch stays as the fallback against an older server.
  const HEADER_DECODER = typeof TextDecoder === 'function' ? new TextDecoder() : null;
  function handleBinaryFrame(buf) {
    let header, bytes;
    try {
      const hlen = new DataView(buf).getUint16(0);
      header = JSON.parse(HEADER_DECODER.decode(new Uint8Array(buf, 2, hlen)));
      bytes = new Uint8Array(buf, 2 + hlen);
    } catch (e) { return; }
    if (!header || header.type !== 'frame') return;
    tiles.forEach((tile) => { if (tile.streaming) drawFrame(tile, bytes); });
  }

  function ensureRelay() {
    if (relay && (relay.readyState === 0 || relay.readyState === 1)) return;
    try {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      relay = new WebSocket(proto + '//' + location.host + '/second-screen/ws');
      relay.binaryType = 'arraybuffer';
    } catch (e) { relay = null; return; }
    relay.addEventListener('open', () => {
      tiles.forEach((tile, id) => { tile.streaming = false; if (tile.onScreen && !perfPaused && tile.ready) startStream(tile, id); });
    });
    relay.addEventListener('message', (ev) => {
      if (ev.data instanceof ArrayBuffer) { handleBinaryFrame(ev.data); return; }
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (!m) return;
      if (m.type === 'frame') { tiles.forEach((tile) => { if (tile.streaming) drawFrame(tile, m.data); }); }
    });
    const drop = () => { tiles.forEach((tile) => { tile.streaming = false; }); };
    relay.addEventListener('close', drop);
    relay.addEventListener('error', drop);
  }

  function relaySend(obj) {
    ensureRelay();
    if (!relay || relay.readyState !== 1) return false;
    try { relay.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
  }

  function tileMetrics(tile) {
    const rect = tile.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return {
      maxWidth: Math.max(320, Math.round(rect.width * dpr)),
      maxHeight: Math.max(240, Math.round(rect.height * dpr)),
    };
  }

  // Capture knobs come from Settings → Second screen (fps/quality), falling back
  // to sane defaults if settings aren't loaded yet.
  function captureCfg() {
    let fps = 15, quality = 55;
    try {
      const s = hubSettings && hubSettings.secondScreen;
      if (s) { if (Number.isFinite(s.fps)) fps = s.fps; if (Number.isFinite(s.quality)) quality = s.quality; }
    } catch (e) { /* defaults */ }
    return { fps, quality };
  }

  // Re-assert the saved resolution once, and only when we actually start viewing —
  // so the capture helper isn't spawned just because the widget exists on a hidden
  // page. The server reads the persisted resolution itself, so we send no value;
  // Windows resets a virtual monitor to a tiny default after a reboot, this restores
  // it the first time you look at it. No-op if it's already right.
  function maybeRestoreMode(tile) {
    if (tile._modeRestored) return;
    tile._modeRestored = true;
    postJson('/second-screen/apply-resolution', { soft: true })
      .then((r) => { if (r && r.ok) window.dispatchEvent(new CustomEvent('second-screen-mode-changed')); })
      .catch(() => {});
  }

  function startStream(tile, id) {
    if (!tile.canvas) return;
    maybeRestoreMode(tile);
    const m = tileMetrics(tile);
    const cfg = captureCfg();
    if (relaySend({ type: 'start', monitor: 'virtual', fps: cfg.fps, maxWidth: m.maxWidth, maxHeight: m.maxHeight, quality: cfg.quality, binary: true })) {
      tile.streaming = true;
      if (tile.closeTimer) { clearTimeout(tile.closeTimer); tile.closeTimer = null; }
    }
  }

  function stopStream(tile, id) {
    tile.streaming = false;
    if (tile.closeTimer) clearTimeout(tile.closeTimer);
    // Brief grace before stopping the capture, so a quick page flip doesn't churn it.
    tile.closeTimer = setTimeout(() => {
      tile.closeTimer = null;
      if (!tile.onScreen || perfPaused) relaySend({ type: 'stop' });
    }, CLOSE_DELAY_MS);
  }

  // `data` is the JPEG as a Uint8Array (binary relay) or a base64 string (older
  // server fallback).
  function drawFrame(tile, data) {
    if (!data || !tile.canvas) return;
    let bytes = data;
    if (typeof data === 'string') {
      try { const bin = atob(data); bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); }
      catch (e) { return; }
    }
    createImageBitmap(new Blob([bytes], { type: 'image/jpeg' })).then((bmp) => {
      if (tile.canvas.width !== bmp.width || tile.canvas.height !== bmp.height) {
        tile.canvas.width = bmp.width; tile.canvas.height = bmp.height;
      }
      const ctx = tile.ctx || (tile.ctx = tile.canvas.getContext('2d'));
      ctx.drawImage(bmp, 0, 0);
      bmp.close && bmp.close();
      if (tile.loadingEl) tile.loadingEl.hidden = true;
    }).catch(() => {});
  }

  // ── Input forwarding ──────────────────────────────────────────────────────────
  // Pure: a pointer position on the canvas → fractional 0..1 coords over the
  // *displayed frame*. The canvas may be object-fit:contain (frame letterboxed
  // inside the box) or :cover (frame fills the box and overflows). Either way we
  // compute the displayed frame rect and its offset so clicks land where the user
  // sees them. The helper turns the fractions into absolute virtual-desktop
  // coordinates for SendInput.
  function frac(clientX, clientY, canvas, cover) {
    const rect = canvas.getBoundingClientRect();
    const fw = canvas.width || rect.width;        // frame (bitmap) dimensions
    const fh = canvas.height || rect.height;
    if (rect.width <= 0 || rect.height <= 0 || fw <= 0 || fh <= 0) return { fx: 0, fy: 0 };
    const boxA = rect.width / rect.height;
    const imgA = fw / fh;
    let dispW, dispH;
    // contain: fit inside (letterbox); cover: fill the box (overflow cropped).
    if ((imgA > boxA) !== !!cover) { dispW = rect.width; dispH = rect.width / imgA; }
    else { dispH = rect.height; dispW = rect.height * imgA; }
    const offX = (rect.width - dispW) / 2;
    const offY = (rect.height - dispH) / 2;
    const fx = (clientX - rect.left - offX) / dispW;
    const fy = (clientY - rect.top - offY) / dispH;
    return { fx: Math.max(0, Math.min(1, fx)), fy: Math.max(0, Math.min(1, fy)) };
  }

  function sendInput(tile, event) { if (tile.streaming) relaySend({ type: 'input', event }); }

  // Movement (px) / time (ms) under which a press counts as a tap, not a swipe.
  const TAP_MOVE_PX = 10;
  const TAP_TIME_MS = 600;

  function wireInput(tile) {
    const canvas = tile.canvas;
    if (!canvas) return;
    const btn = (e) => (e.button === 1 ? 'middle' : e.button === 2 ? 'right' : 'left');
    const at = (e) => frac(e.clientX, e.clientY, canvas, tile.fit === 'cover');
    const controlling = () => tile.touchControl === true;

    canvas.addEventListener('pointerdown', (e) => {
      if (!controlling()) {
        // Scroll mode: don't capture/preventDefault, so a drag scrolls the dashboard
        // natively. Remember the press so a release that barely moved becomes a click.
        tile._tap = { id: e.pointerId, x: e.clientX, y: e.clientY, t: Date.now(), moved: false };
        return;
      }
      canvas.focus();
      if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
      const p = at(e); sendInput(tile, { kind: 'mouse', subtype: 'down', fx: p.fx, fy: p.fy, button: btn(e) });
      e.preventDefault();
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!controlling()) {
        const tp = tile._tap;
        if (tp && tp.id === e.pointerId && !tp.moved &&
            (Math.abs(e.clientX - tp.x) > TAP_MOVE_PX || Math.abs(e.clientY - tp.y) > TAP_MOVE_PX)) {
          tp.moved = true;   // it's a swipe → let it scroll, never a click
        }
        return;
      }
      if (!tile.streaming || tile._moveQ) return;       // one move per frame
      tile._moveQ = true; requestAnimationFrame(() => { tile._moveQ = false; });
      const p = at(e); sendInput(tile, { kind: 'mouse', subtype: 'move', fx: p.fx, fy: p.fy });
    });

    // The browser fires pointercancel when it takes over the gesture for scrolling.
    canvas.addEventListener('pointercancel', (e) => { const tp = tile._tap; if (tp && tp.id === e.pointerId) tp.moved = true; });

    canvas.addEventListener('pointerup', (e) => {
      if (!controlling()) {
        const tp = tile._tap; tile._tap = null;
        if (!tp || tp.id !== e.pointerId || tp.moved) return;            // a scroll/drag, not a tap
        if (Date.now() - tp.t > TAP_TIME_MS) return;                     // too slow to be a tap
        if (Math.abs(e.clientX - tp.x) > TAP_MOVE_PX || Math.abs(e.clientY - tp.y) > TAP_MOVE_PX) return;
        canvas.focus();                                                  // so typing can follow the click
        const p = at(e);                                                 // tap → a single left click
        sendInput(tile, { kind: 'mouse', subtype: 'down', fx: p.fx, fy: p.fy, button: 'left' });
        sendInput(tile, { kind: 'mouse', subtype: 'up', fx: p.fx, fy: p.fy, button: 'left' });
        return;
      }
      const p = at(e); sendInput(tile, { kind: 'mouse', subtype: 'up', fx: p.fx, fy: p.fy, button: btn(e) });
    });

    canvas.addEventListener('contextmenu', (e) => { if (controlling()) e.preventDefault(); });
    canvas.addEventListener('wheel', (e) => {
      if (!controlling()) return;     // scroll mode: let the wheel scroll the dashboard
      const p = at(e); sendInput(tile, { kind: 'wheel', fx: p.fx, fy: p.fy, delta: e.deltaY > 0 ? -120 : 120 });
      e.preventDefault();
    }, { passive: false });

    // Keys forward whenever the canvas has focus and is streaming — focus only
    // happens via a deliberate click (a tap in scroll mode, a press in control mode),
    // so they never fire spuriously. Printable chars go as Unicode (self-contained
    // down+up in the helper); other keys go as virtual-key down/up.
    const printable = (e) => e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
    canvas.addEventListener('keydown', (e) => {
      if (!tile.streaming) return;
      if (printable(e)) sendInput(tile, { kind: 'key', subtype: 'char', cp: e.key.codePointAt(0) });
      else if (e.keyCode) sendInput(tile, { kind: 'key', subtype: 'down', vk: e.keyCode });
      if (['Tab', 'Backspace', ' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(e.key)) e.preventDefault();
    });
    canvas.addEventListener('keyup', (e) => {
      if (!tile.streaming) return;
      if (!printable(e) && e.keyCode) sendInput(tile, { kind: 'key', subtype: 'up', vk: e.keyCode });
    });
  }

  // ── Views ─────────────────────────────────────────────────────────────────────
  function instanceIdOf(section) {
    const item = section.closest('.grid-stack-item');
    return (item && item.getAttribute('gs-id')) || 'secondscreen';
  }

  function mkBtn(cls, icon, title, onClick) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'ss-btn ' + cls; b.innerHTML = icon; b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  // Live capture view: a toolbar (expand) + the canvas the frames draw onto.
  function renderLive(tile) {
    const wrap = document.createElement('div');
    wrap.className = 'ss-wrap';

    const bar = document.createElement('div');
    bar.className = 'ss-bar';
    const spacer = document.createElement('div'); spacer.className = 'ss-spacer';
    const tune = mkBtn('ss-tunebtn', ICONS.tune, t('second_screen_tune', 'Stream quality'), () => toggleTunePanel(tile));
    const touch = mkBtn('ss-touch', ICONS.touchScroll, '', () => toggleTouchControl(tile));
    const fill = mkBtn('ss-fill', ICONS.fill, '', () => toggleFit(tile));
    const expand = mkBtn('ss-expand', ICONS.expand, t('browser_expand', 'Expand'), () => toggleExpand(tile.id));
    bar.append(spacer, tune, touch, fill, expand);
    tile.touchBtn = touch; tile.fillBtn = fill; tile.tuneBtn = tune;

    const stage = document.createElement('div');
    stage.className = 'ss-stage';
    const canvas = document.createElement('canvas');
    canvas.className = 'ss-canvas';
    canvas.tabIndex = 0;                  // focusable so it can receive keyboard
    const loading = document.createElement('div');
    loading.className = 'ss-loading'; loading.textContent = t('second_screen_connecting', 'Connecting…');
    // Quick FPS/quality presets — a small glass panel over the stage; persists
    // through the same store as Settings → Second screen and re-requests the
    // stream immediately so the change is visible on the spot.
    const tunePanel = document.createElement('div');
    tunePanel.className = 'ss-tune-panel'; tunePanel.hidden = true;
    tile.tunePanel = tunePanel;
    stage.append(canvas, loading, tunePanel);

    wrap.append(bar, stage);
    tile.mount.replaceChildren(wrap);
    tile.wrap = wrap; tile.stage = stage; tile.canvas = canvas; tile.ctx = null;
    tile.expandBtn = expand; tile.loadingEl = loading;
    tile.fit = savedFit();
    applyFit(tile);
    tile.touchControl = savedTouchControl();
    applyTouchMode(tile);
    wireInput(tile);

    // When the tile resizes (expand/collapse, grid resize), re-request the stream
    // at the new size so the capture is downscaled to fit — not stretched up from
    // a tiny frame. Debounced to one restart per frame; only while streaming.
    if (tile._ro) tile._ro.disconnect();
    let roQ = false;
    tile._ro = new ResizeObserver(() => {
      if (roQ) return; roQ = true;
      requestAnimationFrame(() => { roQ = false; if (tile.streaming) startStream(tile, tile.id); });
    });
    tile._ro.observe(stage);
  }

  // Guided setup / unavailable view, driven by the /second-screen/requirements codes.
  function renderSetup(tile, req) {
    const wrap = document.createElement('div');
    wrap.className = 'ss-wrap ss-setup';
    tile.wrap = wrap; tile.canvas = null;

    const card = document.createElement('div');
    card.className = 'ss-setup-card';
    const icon = document.createElement('div'); icon.className = 'ss-setup-icon'; icon.innerHTML = ICONS.screen;
    const title = document.createElement('div'); title.className = 'ss-setup-title'; title.textContent = t('second_screen_title', 'Second screen');
    const msg = document.createElement('div'); msg.className = 'ss-setup-msg';
    const status = document.createElement('div'); status.className = 'ss-setup-status'; status.hidden = true;
    card.append(icon, title, msg);

    if (!req || req.captureAvailable === false) {
      msg.textContent = t('second_screen_unavailable_helper', 'The Xenon Helper (native companion) is required. Re-run INSTALL.bat to add it.');
      wrap.append(card);
      tile.mount.replaceChildren(wrap);
      return;
    }

    const winget = req.steps && req.steps.find((s) => s.id === 'winget');
    if (winget && winget.action === 'manual') {
      msg.textContent = t('second_screen_need_winget', 'Windows App Installer (winget) is required. Install it from the Microsoft Store, then retry.');
      const retry = mkBtn('ss-action', '', t('second_screen_retry', 'Retry'), () => refresh(tile));
      retry.textContent = t('second_screen_retry', 'Retry');
      card.append(retry);
      wrap.append(card);
      tile.mount.replaceChildren(wrap);
      return;
    }

    msg.textContent = t('second_screen_setup_intro', 'Add a real virtual monitor you can use and control from the dashboard.');
    const btn = mkBtn('ss-action', '', t('second_screen_vdd_install', 'Set up the second screen'), () => runSetup(tile, btn, status));
    btn.textContent = t('second_screen_vdd_install', 'Set up the second screen');
    const hint = document.createElement('div'); hint.className = 'ss-setup-hint';
    hint.textContent = t('second_screen_vdd_hint', 'Adds a virtual monitor for a real second screen. Signed driver, one-click install.');
    card.append(btn, hint, status);
    wrap.append(card);
    tile.mount.replaceChildren(wrap);
  }

  // Run the one-click setup: install the driver (if needed) then create the display.
  // Each network/elevated step maps a stable server `code` to a clear message —
  // never a dead end.
  async function runSetup(tile, btn, status) {
    btn.disabled = true;
    status.hidden = false;
    status.textContent = t('second_screen_working', 'Setting up…');
    try {
      let req = await fetchRequirements();
      if (req && !req.vddInstalled) {
        const r = await postJson('/second-screen/install');
        if (!r || r.ok !== true) { status.textContent = t('second_screen_install_failed', 'Setup didn’t finish. Accept the Windows prompts, then retry.'); btn.disabled = false; return; }
        req = await fetchRequirements();
      }
      if (req && req.vddInstalled && !req.displayActive) {
        // apply-resolution creates the display (idempotent, never spams monitors)
        // AND commits the user's chosen mode in one step, so the new screen comes
        // up at the right size instead of the driver's stale 800x600 default.
        const r = await postJson('/second-screen/apply-resolution', { mode: savedMode() });
        if (r && r.code === 'display_needs_reboot') { status.textContent = t('second_screen_reboot', 'Driver installed. Restart Windows to activate the second screen.'); btn.disabled = false; return; }
        if (!r || r.ok !== true) { status.textContent = t('second_screen_install_failed', 'Setup didn’t finish. Accept the Windows prompts, then retry.'); btn.disabled = false; return; }
      }
      await refresh(tile);   // re-probe; flips to the live view when ready
    } catch (e) {
      status.textContent = t('second_screen_install_failed', 'Setup didn’t finish. Accept the Windows prompts, then retry.');
      btn.disabled = false;
    }
  }

  function fetchRequirements() {
    return fetch('/second-screen/requirements').then((r) => r.json()).catch(() => null);
  }
  function postJson(path, body) {
    const init = { method: 'POST' };
    if (body !== undefined) { init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(body); }
    return fetch(path, init).then((r) => r.json()).catch(() => null);
  }

  // hubSettings is a shared classic-script global from settings.js (a top-level
  // `let`, NOT window.hubSettings) — read it by bare name, like performance.js does.
  function readHubSettings() {
    try { return (typeof hubSettings !== 'undefined' && hubSettings) || {}; } catch (e) { return {}; }
  }

  // Fill mode: 'cover' fills the tile edge-to-edge (cropping the overflow when the
  // virtual screen's aspect differs from the tile's), 'contain' shows the whole
  // desktop letterboxed. Persisted in Settings → Second screen.
  function savedFit() {
    try {
      const s = readHubSettings().secondScreen;
      if (s && s.fit === 'cover') return 'cover';
    } catch (e) { /* default */ }
    return 'contain';
  }

  function applyFit(tile) {
    const cover = tile.fit === 'cover';
    if (tile.canvas) tile.canvas.classList.toggle('ss-fill', cover);
    if (tile.fillBtn) {
      tile.fillBtn.innerHTML = cover ? ICONS.fit : ICONS.fill;
      tile.fillBtn.title = cover
        ? t('second_screen_fit_actual', 'Show whole screen')
        : t('second_screen_fit_fill', 'Fill the tile');
    }
  }

  function toggleFit(tile) {
    tile.fit = tile.fit === 'cover' ? 'contain' : 'cover';
    applyFit(tile);
    if (typeof window.setSecondScreenFit === 'function') window.setSecondScreenFit(tile.fit);
  }

  // Touch mode: whether a finger drives the virtual screen or scrolls the dashboard.
  // A mouse always drives it; this only gates touch so a big tile doesn't swallow
  // swipes (page navigation) or near-miss taps on the toolbar. Default = scroll.
  function savedTouchControl() {
    try {
      const s = readHubSettings().secondScreen;
      if (s && s.touchControl === true) return true;
    } catch (e) { /* default */ }
    return false;
  }

  function applyTouchMode(tile) {
    const control = tile.touchControl === true;
    // In scroll mode let the browser handle touch gestures (so swipes reach the
    // pager); in control mode the canvas owns every touch.
    if (tile.canvas) tile.canvas.classList.toggle('ss-touchscroll', !control);
    if (tile.touchBtn) {
      tile.touchBtn.innerHTML = control ? ICONS.touchPointer : ICONS.touchScroll;
      tile.touchBtn.classList.toggle('ss-btn-active', control);
      tile.touchBtn.title = control
        ? t('second_screen_touch_control_on', 'Touch controls the screen — tap to scroll the dashboard instead')
        : t('second_screen_touch_control_off', 'Touch scrolls the dashboard — tap to control the screen with touch');
    }
  }

  function toggleTouchControl(tile) {
    tile.touchControl = !tile.touchControl;
    applyTouchMode(tile);
    if (typeof window.setSecondScreenTouchControl === 'function') window.setSecondScreenTouchControl(tile.touchControl);
  }

  // ── On-tile FPS/quality presets ───────────────────────────────────────────────
  // The full knobs live in Settings → Second screen; these are the quick presets
  // for while you're actually looking at the stream. Persisted through the same
  // normalized store (setSecondScreenCapture), applied live via a stream restart.
  const TUNE_FPS = [15, 30, 60];
  const TUNE_QUALITY = () => ([
    { value: 35, label: t('settings_secondscreen_q_low', 'Bassa') },
    { value: 55, label: t('settings_secondscreen_q_med', 'Media') },
    { value: 75, label: t('settings_secondscreen_q_high', 'Alta') },
  ]);

  function applyCapture(tile, fps, quality) {
    if (typeof window.setSecondScreenCapture === 'function') window.setSecondScreenCapture(fps, quality);
    if (tile.streaming) startStream(tile, tile.id);   // restart picks up the new presets
  }

  function buildTunePanel(tile) {
    const panel = tile.tunePanel;
    if (!panel) return;
    const cfg = captureCfg();
    panel.replaceChildren();
    const addRow = (labelText, options, current, onPick) => {
      const row = document.createElement('div'); row.className = 'ss-tune-row';
      const lab = document.createElement('span'); lab.className = 'ss-tune-label'; lab.textContent = labelText;
      const seg = document.createElement('div'); seg.className = 'ss-tune-seg';
      options.forEach((opt) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ss-tune-opt' + (opt.value === current ? ' is-active' : '');
        b.textContent = opt.label;
        b.addEventListener('click', () => { onPick(opt.value); buildTunePanel(tile); });
        seg.appendChild(b);
      });
      row.append(lab, seg);
      panel.appendChild(row);
    };
    addRow('FPS', TUNE_FPS.map((v) => ({ value: v, label: String(v) })), cfg.fps,
      (v) => applyCapture(tile, v, undefined));
    addRow(t('settings_secondscreen_quality', 'Qualità immagine'), TUNE_QUALITY(), cfg.quality,
      (v) => applyCapture(tile, undefined, v));
  }

  function toggleTunePanel(tile) {
    const panel = tile.tunePanel;
    if (!panel) return;
    const show = panel.hidden;
    if (show) buildTunePanel(tile);
    panel.hidden = !show;
    if (tile.tuneBtn) tile.tuneBtn.classList.toggle('ss-btn-active', show);
  }

  // The resolution the user picked in Settings → Second screen (falls back to 1080p).
  function savedMode() {
    try {
      const s = readHubSettings().secondScreen;
      if (s && s.width > 0 && s.height > 0) return { width: s.width, height: s.height };
    } catch (e) { /* defaults */ }
    return { width: 1920, height: 1080 };
  }

  // Decide which view a tile should show, then (re)observe visibility. Guarded so
  // overlapping scans (the fetch is async) can't double-render the same tile.
  async function refresh(tile) {
    if (tile._refreshing) return;
    tile._refreshing = true;
    try {
      const req = await fetchRequirements();
      const ready = !!(req && req.ready && req.captureAvailable);
      tile.ready = ready;
      if (ready) renderLive(tile); else renderSetup(tile, req);
      observeVisibility(tile);
      applyTileState(tile, tile.id);
    } finally {
      tile._refreshing = false;
    }
  }

  // Visibility = section not explicitly hidden AND actually occupying screen space.
  // The PRIMARY signal is an IntersectionObserver, because the tile's visibility is
  // very often controlled by an ANCESTOR — a tab group's inactive body is
  // display:none, the pager transforms off-screen pages away — that never mutates the
  // section's own attributes. A MutationObserver on the section alone misses those
  // changes and leaves the capture stream stopped, so the tile never draws a frame
  // (a permanently-black tile) even while it's on screen. The offsetParent/clientWidth
  // read is only the fallback when IO is unavailable. Mirrors browser-tile.js.
  function observeVisibility(tile) {
    const section = tile.mount.closest('.dashboard-widget') || tile.mount.parentElement;
    if (!section) return;
    tile.section = section;
    if (tile._io) { tile._io.disconnect(); tile._io = null; }
    if (tile._mo) tile._mo.disconnect();
    const evaluate = () => {
      const hidden = section.getAttribute('data-dashboard-hidden') === 'true';
      const onScreen = tile._io
        ? tile._intersecting
        : (section.offsetParent !== null && section.clientWidth > 0);
      tile.onScreen = !hidden && onScreen;
      applyTileState(tile, tile.id);
    };
    tile._evaluate = evaluate;
    if (typeof IntersectionObserver === 'function') {
      tile._intersecting = section.offsetParent !== null && section.clientWidth > 0;
      tile._io = new IntersectionObserver((entries) => {
        for (const e of entries) tile._intersecting = e.isIntersecting;
        evaluate();
      }, { threshold: 0.01 });
      tile._io.observe(section);
    }
    tile._mo = new MutationObserver(evaluate);
    tile._mo.observe(section, { attributes: true, attributeFilter: ['data-dashboard-hidden', 'style', 'class'] });
    evaluate();
  }

  // ── Expand to a true full-viewport overlay (portal to <body>, like the Browser
  //    tile + lock screen — escapes the GridStack stacking context and root zoom). ─
  function toggleExpand(id) {
    const tile = tiles.get(id);
    if (!tile || !tile.wrap) return;
    if (tile.expanded) collapse(tile); else expand(tile);
  }
  function expand(tile) {
    if (tile.expanded || !tile.wrap) return;
    tile.expanded = true;
    document.body.appendChild(tile.wrap);
    tile.wrap.classList.add('ss-overlay');
    if (tile.expandBtn) { tile.expandBtn.innerHTML = ICONS.collapse; tile.expandBtn.title = t('browser_collapse', 'Collapse'); }
    if (tile.wrap.requestFullscreen) {
      tile.wrap.requestFullscreen().catch(() => {});
      if (!tile._fsHandler) {
        tile._fsHandler = () => { if (!document.fullscreenElement && tile.expanded) collapse(tile); };
        document.addEventListener('fullscreenchange', tile._fsHandler);
      }
    }
  }
  function collapse(tile) {
    if (!tile.expanded) return;
    tile.expanded = false;
    tile.wrap.classList.remove('ss-overlay');
    if (tile.expandBtn) { tile.expandBtn.innerHTML = ICONS.expand; tile.expandBtn.title = t('browser_expand', 'Expand'); }
    if (tile._fsHandler) { document.removeEventListener('fullscreenchange', tile._fsHandler); tile._fsHandler = null; }
    if (document.fullscreenElement) { try { document.exitFullscreen(); } catch (e) { /* ignore */ } }
    if (tile.mount) tile.mount.appendChild(tile.wrap);
  }

  // ── Scanning ──────────────────────────────────────────────────────────────────
  function scan() {
    if (typeof document === 'undefined') return;
    document.querySelectorAll('[data-dashboard-widget="secondscreen"]').forEach((section) => {
      const mount = section.querySelector('.secondscreen-widget-mount');
      if (!mount) return;
      const id = instanceIdOf(section);
      const existing = tiles.get(id);
      if (existing && existing.expanded) { existing.mount = mount; return; }
      if (existing && existing.wrap && mount.contains(existing.wrap)) { existing._evaluate && existing._evaluate(); return; }
      const tile = existing || { id, expanded: false, ready: false, streaming: false, onScreen: false, closeTimer: null };
      tile.mount = mount;
      tiles.set(id, tile);
      refresh(tile);
    });
    // Free a tile whose widget was removed from the dashboard.
    tiles.forEach((tile, id) => {
      if (tile.section && !document.contains(tile.section)) {
        if (tile.closeTimer) { clearTimeout(tile.closeTimer); tile.closeTimer = null; }
        if (tile.streaming) relaySend({ type: 'stop' });
        if (tile._io) { tile._io.disconnect(); tile._io = null; }
        if (tile._mo) tile._mo.disconnect();
        if (tile._ro) tile._ro.disconnect();
        tiles.delete(id);
      }
    });
    evalPerfPause();
  }

  function init() {
    let queued = false;
    const obs = new MutationObserver(() => {
      if (queued) return; queued = true;
      requestAnimationFrame(() => { queued = false; scan(); });
    });
    obs.observe(document.body, { childList: true, subtree: true });
    new MutationObserver(evalPerfPause).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    // The resolution was changed from Settings → re-request each live stream so the
    // new virtual-display size is picked up immediately (the capture reads the
    // monitor geometry afresh on each start).
    window.addEventListener('second-screen-mode-changed', () => {
      tiles.forEach((tile, id) => { if (tile.streaming) startStream(tile, id); });
    });
    scan();
    evalPerfPause();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
