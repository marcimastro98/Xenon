'use strict';
// UniFi Protect "Cameras" dashboard widget + its Settings card.
//
// Shows the user's UniFi Protect cameras as near-live JPEG snapshots. Protect caps
// snapshots to ~640×360 (v6+), which is perfect for a glanceable tile. Frames are
// PULLED from the loopback proxy (GET /api/unifiprotect/snapshot/<id>) only while
// the tile is actually on screen and not suspended by game/performance mode — so a
// hidden/unused tile costs nothing (no server-side polling loop exists).
//
// The console password never reaches the browser: the server holds it and proxies
// each snapshot. This module only handles camera names, ids, and JPEG bytes.
(function () {
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));

  const STATE_POLL_MS = 30000;    // re-check config/camera list/status while visible
  const SNAP = (id) => '/api/unifiprotect/snapshot/' + encodeURIComponent(id) + '?ts=' + Date.now();

  const tiles = new Map();        // instanceId -> tile state
  let perfPaused = false;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;   // user-visible text → textContent
    return n;
  }

  function api(path, init) {
    return fetch(path, init).then((r) => r.json()).catch(() => null);
  }

  function readHubSettings() {
    try { return (typeof hubSettings !== 'undefined' && hubSettings) || {}; } catch (e) { return {}; }
  }

  // The user's selected camera ids (empty = show every camera the console reports).
  function selectedIds() {
    try {
      const u = readHubSettings().unifi;
      if (u && Array.isArray(u.cameras)) return u.cameras.slice();
    } catch (e) { /* default */ }
    return [];
  }

  // ── Display layout (columns / fit / aspect / order) ───────────────────────────
  // All client-side + persisted in settings.unifi; the server normalizer is the
  // authority (mirrored here for defaults). aspect maps to a CSS aspect-ratio value.
  const ASPECT_CSS = { '16:9': '16 / 9', '4:3': '4 / 3', '1:1': '1 / 1' };
  const ROTATIONS = [0, 90, 180, 270];
  const DEFAULT_REFRESH_MS = 1500;

  function layoutOf() {
    const u = readHubSettings().unifi || {};
    const cols = Number(u.columns);
    const ms = Number(u.refreshMs);
    return {
      columns: Number.isFinite(cols) ? Math.min(6, Math.max(0, Math.round(cols))) : 0,
      fit: u.fit === 'contain' ? 'contain' : 'cover',
      aspect: ASPECT_CSS[u.aspect] ? u.aspect : '16:9',
      order: Array.isArray(u.order) ? u.order : [],
      refreshMs: Number.isFinite(ms) ? Math.min(60000, Math.max(500, Math.round(ms))) : DEFAULT_REFRESH_MS,
      angles: (u.angles && typeof u.angles === 'object') ? u.angles : {},
    };
  }

  // The per-camera view adjustment (rotation + horizontal flip + digital zoom/pan).
  // Missing/invalid → neutral. Pass an already-computed `lay` to avoid rebuilding
  // the whole layout object per camera when applying angles across a grid.
  const MAX_ZOOM = 3;
  const clampPan = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.min(100, Math.max(-100, n)) : 0; };
  function angleOf(id, lay) {
    const a = (lay || layoutOf()).angles[id];
    const rot = a && ROTATIONS.includes(a.rot) ? a.rot : 0;
    const flip = !!(a && a.flip);
    const z = a && Number(a.zoom);
    const zoom = Number.isFinite(z) ? Math.min(MAX_ZOOM, Math.max(1, z)) : 1;
    const panX = zoom > 1 ? clampPan(a && a.panX) : 0;
    const panY = zoom > 1 ? clampPan(a && a.panY) : 0;
    return { rot, flip, zoom, panX, panY };
  }

  // Apply a rotation/flip/zoom/pan to a snapshot <img>. Quarter turns (90/270) swap
  // the image's aspect, so switch that card to `contain` to avoid a mis-crop. The
  // pan translate is the outermost op (screen-space), so panning stays intuitive
  // regardless of rotation; at panX/Y = ±100 the image edge just reaches the frame.
  function applyCamAngle(img, ang) {
    if (!img) return;
    const parts = [];
    const z = ang.zoom > 1 ? ang.zoom : 1;
    if (z > 1 && (ang.panX || ang.panY)) {
      const tx = (ang.panX * (z - 1)) / 2;         // % of the element box
      const ty = (ang.panY * (z - 1)) / 2;
      parts.push('translate(' + tx.toFixed(2) + '%, ' + ty.toFixed(2) + '%)');
    }
    if (ang.rot) parts.push('rotate(' + ang.rot + 'deg)');
    if (ang.flip) parts.push('scaleX(-1)');
    if (z > 1) parts.push('scale(' + z + ')');
    img.style.transform = parts.join(' ');
    img.classList.toggle('up-cam-img--rot', ang.rot === 90 || ang.rot === 270);
  }

  // Sort a camera list by the user's saved order; unranked/new cameras keep their
  // original relative order at the end (Array.prototype.sort is stable).
  function orderCameras(list, order) {
    if (!Array.isArray(order) || !order.length) return list;
    const rank = new Map(order.map((id, i) => [id, i]));
    return list.slice().sort((a, b) => {
      const ra = rank.has(a.id) ? rank.get(a.id) : Infinity;
      const rb = rank.has(b.id) ? rank.get(b.id) : Infinity;
      return ra - rb;
    });
  }

  // Push the layout choices onto a .up-grid as CSS variables + a mode class. Auto
  // (columns 0) keeps the default responsive auto-fit; a fixed count switches to
  // repeat(N). fit/aspect are variables consumed by .up-cam / .up-cam-img.
  function applyGridVars(grid, lay) {
    if (!grid) return;
    grid.style.setProperty('--up-fit', lay.fit);
    grid.style.setProperty('--up-aspect', ASPECT_CSS[lay.aspect] || '16 / 9');
    if (lay.columns > 0) {
      grid.style.setProperty('--up-cols', String(lay.columns));
      grid.classList.add('up-grid--fixed');
    } else {
      grid.style.removeProperty('--up-cols');
      grid.classList.remove('up-grid--fixed');
    }
  }

  // Re-apply layout to a live tile WITHOUT rebuilding the grid: variables update in
  // place, and cards are re-appended in the new order (no snapshot re-fade).
  function applyLayout(tile) {
    const grid = tile.mount && tile.mount.querySelector('.up-grid');
    if (!grid) return;
    const lay = layoutOf();
    applyGridVars(grid, lay);
    if (tile.cams && tile.cams.length) {
      const ordered = orderCameras(tile.cams, lay.order);
      ordered.forEach((cam) => {
        if (cam.card) grid.appendChild(cam.card);
        applyCamAngle(cam.img, angleOf(cam.id, lay));
      });
      tile.cams = ordered;
    }
    if (tile.expandCam) applyCamAngle(tile.expandCam.img, angleOf(tile.expandCam.id, lay));
    retimePulling(tile);
  }

  function applyLayoutAll() { tiles.forEach((tile) => applyLayout(tile)); }

  // Re-apply ONE camera's view transform across every tile (and any open expand
  // overlay) without re-appending cards — a zoom/rotate/pan tweak must not
  // detach+reinsert every grid card just to restyle a single <img>.
  function applyCamAngleAll(camId) {
    const ang = angleOf(camId);
    tiles.forEach((tile) => {
      (tile.cams || []).forEach((cam) => { if (cam.id === camId && cam.img) applyCamAngle(cam.img, ang); });
      if (tile.expandCam && tile.expandCam.id === camId && tile.expandCam.img) applyCamAngle(tile.expandCam.img, ang);
    });
  }

  // ── Streaming gate (visible AND not suspended by game/performance mode) ────────
  function applyTileState(tile) {
    const want = tile.onScreen && !perfPaused;
    if (want && !tile.pulling) startPulling(tile);
    else if (!want && tile.pulling) stopPulling(tile);
  }

  function evalPerfPause() {
    let pause = false;
    try {
      const opt = readHubSettings().performance && readHubSettings().performance.opts;
      const wantsPause = !opt || opt.pauseStreams !== false;
      const active = document.body.classList.contains('game-mode') ||
                     document.body.classList.contains('perf-active');
      pause = wantsPause && active;
    } catch (e) { pause = false; }
    if (pause === perfPaused) return;
    perfPaused = pause;
    tiles.forEach((tile) => applyTileState(tile));
  }

  // ── Snapshot refresh loop ─────────────────────────────────────────────────────
  // Double-buffer: preload the next frame into a detached Image and only swap the
  // visible <img> once it has decoded, so a refresh never flashes blank. A
  // per-camera in-flight guard keeps a slow console from stacking requests.
  function refreshOne(cam) {
    if (!cam || cam.loading || !cam.img) return;
    cam.loading = true;
    const pre = new Image();
    pre.onload = () => {
      cam.loading = false;
      if (cam.img) { cam.img.src = pre.src; cam.img.classList.add('is-live'); }
      if (cam.card) cam.card.classList.remove('up-cam--stale');
    };
    pre.onerror = () => {
      cam.loading = false;
      if (cam.card) cam.card.classList.add('up-cam--stale');
    };
    pre.src = SNAP(cam.id);
  }

  function tick(tile) {
    if (!tile.pulling) return;
    tile.cams.forEach(refreshOne);
    if (tile.expandCam) refreshOne(tile.expandCam);
  }

  function startPulling(tile) {
    if (tile.pulling) return;
    tile.pulling = true;
    tick(tile);                                   // immediate first frame
    tile.refreshMs = layoutOf().refreshMs;
    tile.timer = setInterval(() => tick(tile), tile.refreshMs);
    if (!tile.statePoll) tile.statePoll = setInterval(() => loadState(tile), STATE_POLL_MS);
  }

  // Restart the snapshot timer if the user changed the refresh rate while it runs.
  function retimePulling(tile) {
    if (!tile.pulling) return;
    const ms = layoutOf().refreshMs;
    if (ms === tile.refreshMs) return;
    tile.refreshMs = ms;
    if (tile.timer) clearInterval(tile.timer);
    tile.timer = setInterval(() => tick(tile), ms);
  }

  function stopPulling(tile) {
    tile.pulling = false;
    if (tile.timer) { clearInterval(tile.timer); tile.timer = null; }
    if (tile.statePoll) { clearInterval(tile.statePoll); tile.statePoll = null; }
  }

  // ── State + rendering ─────────────────────────────────────────────────────────
  // STRUCTURAL signature — only what forces a full grid REBUILD: config state, the
  // error empty-state, the selection, and the SET of cameras by id. A camera's
  // connected flag or name is deliberately NOT here: those change often (a wireless
  // camera flapping online/offline) and are applied in place (updateStatuses) so a
  // single status change never rebuilds — and re-fades — the whole grid.
  function stateSig(tile) {
    const s = tile.state || {};
    const ids = Array.isArray(s.cameras) ? s.cameras.map((c) => c.id).join(',') : '';
    return [!!s.configured, s.error ? 'e' : '', selectedIds().join(','), ids].join('|');
  }

  // Apply connected-dot + name changes to the existing cards without a rebuild.
  function updateStatuses(tile) {
    const s = tile.state || {};
    const byId = new Map((Array.isArray(s.cameras) ? s.cameras : []).map((c) => [c.id, c]));
    (tile.cams || []).forEach((cam) => {
      const c = byId.get(cam.id);
      if (!c) return;
      if (cam.dot) cam.dot.classList.toggle('is-off', c.connected === false);
      if (c.name && c.name !== cam.name) {
        cam.name = c.name;
        if (cam.nameEl) cam.nameEl.textContent = c.name;
        if (cam.card) cam.card.title = c.name;
      }
    });
  }

  async function loadState(tile) {
    const data = await api('/api/unifiprotect/state');
    if (!tile.mount || !document.contains(tile.mount)) return;
    tile.state = data || { configured: false, cameras: [] };
    const sig = stateSig(tile);
    if (sig === tile.sig && tile.mount.firstChild) { updateStatuses(tile); return; }   // structure unchanged — status only
    tile.sig = sig;
    render(tile);
  }

  function render(tile) {
    const s = tile.state || {};
    if (!s.configured) { renderSetup(tile); return; }
    const cameras = Array.isArray(s.cameras) ? s.cameras : [];
    const sel = selectedIds();
    const show = sel.length ? cameras.filter((c) => sel.includes(c.id)) : cameras;
    if (!cameras.length) { renderEmpty(tile, s.error ? t('unifi_error', 'Couldn’t reach UniFi Protect') : t('unifi_no_cameras', 'No cameras found')); return; }
    if (!show.length) { renderEmpty(tile, t('unifi_none_selected', 'No cameras selected — pick some in Settings → Cameras')); return; }
    renderGrid(tile, show);
  }

  function renderSetup(tile) {
    const wrap = el('div', 'up-setup');
    wrap.appendChild(el('div', 'up-setup-icon')).innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="14" height="12" rx="2"/><path d="m16 10 4.6-2.6a1 1 0 0 1 1.5.9v7.4a1 1 0 0 1-1.5.9L16 14"/><circle cx="9" cy="12" r="2.5"/></svg>';
    wrap.appendChild(el('div', 'up-setup-title', t('unifi_title', 'Cameras')));
    wrap.appendChild(el('div', 'up-setup-msg', t('unifi_setup_intro', 'Connect your UniFi Protect console to see your cameras here.')));
    const btn = el('button', 'ui-btn ui-btn--primary', t('unifi_open_settings', 'Set up'));
    btn.type = 'button';
    btn.addEventListener('click', openUnifiSettings);
    wrap.appendChild(btn);
    tile.mount.replaceChildren(wrap);
    tile.cams = [];
  }

  function renderEmpty(tile, msg) {
    const wrap = el('div', 'up-setup');
    wrap.appendChild(el('div', 'up-setup-msg', msg));
    const btn = el('button', 'ui-btn', t('unifi_open_settings', 'Open settings'));
    btn.type = 'button';
    btn.addEventListener('click', openUnifiSettings);
    wrap.appendChild(btn);
    tile.mount.replaceChildren(wrap);
    tile.cams = [];
  }

  function renderGrid(tile, cameras) {
    const lay = layoutOf();
    const grid = el('div', 'up-grid');
    applyGridVars(grid, lay);
    tile.cams = orderCameras(cameras, lay.order).map((c) => {
      const card = el('button', 'up-cam');
      card.type = 'button';
      card.title = c.name;
      const img = el('img', 'up-cam-img');
      img.alt = c.name;
      img.decoding = 'async';
      applyCamAngle(img, angleOf(c.id, lay));
      const label = el('div', 'up-cam-label');
      const dot = el('span', 'up-cam-dot' + (c.connected === false ? ' is-off' : ''));
      const nameEl = el('span', 'up-cam-name', c.name);
      label.append(dot, nameEl);
      card.append(img, label);
      const cam = { id: c.id, name: c.name, img, card, dot, nameEl, loading: false };
      card.addEventListener('click', () => openExpand(tile, cam));
      grid.appendChild(card);
      return cam;
    });
    tile.mount.replaceChildren(grid);
    if (tile.pulling) tick(tile);
  }

  // Persist a camera's rotation/flip/zoom/pan. A fully neutral view drops the entry
  // so the map stays lean (and "show all"-style defaults keep working for new
  // cameras). Pan is only stored while zoomed in.
  function setCamAngle(id, next) {
    const cur = layoutOf().angles;
    const angles = {};
    for (const k of Object.keys(cur)) angles[k] = cur[k];   // shallow copy
    const rot = ROTATIONS.includes(next.rot) ? next.rot : 0;
    const flip = next.flip ? 1 : 0;
    const z = Number(next.zoom);
    const zoom = Number.isFinite(z) ? Math.min(MAX_ZOOM, Math.max(1, Math.round(z * 100) / 100)) : 1;
    if (!rot && !flip && zoom <= 1) {
      delete angles[id];
    } else {
      const entry = { rot, flip };
      if (zoom > 1) {
        entry.zoom = zoom;
        const panX = Math.round(clampPan(next.panX)), panY = Math.round(clampPan(next.panY));
        if (panX) entry.panX = panX;
        if (panY) entry.panY = panY;
      }
      angles[id] = entry;
    }
    if (window.setUnifiSettings) window.setUnifiSettings({ angles });
  }

  // ── Expand one camera to a full-viewport overlay (portal to <body>). ───────────
  function openExpand(tile, cam) {
    if (tile.overlay) closeExpand(tile);
    const overlay = el('div', 'up-overlay');
    // A fixed 16:9 frame (the Protect snapshot's own aspect) that CLIPS the image,
    // so zoom/pan preview here exactly as they'll crop the live tile card.
    const frame = el('div', 'up-overlay-frame');
    const img = el('img', 'up-overlay-img');
    img.alt = cam.name;
    frame.appendChild(img);
    applyCamAngle(img, angleOf(cam.id));
    const bar = el('div', 'up-overlay-bar');
    bar.append(el('span', 'up-overlay-name', cam.name));

    // Rotate / mirror / zoom — the "adjust how the camera is shown" controls. They
    // transform the shown snapshot only (no command is sent to the camera). Every
    // change preserves the camera's other view fields (spread the current angle).
    const applyToBoth = () => {
      const ang = angleOf(cam.id);
      applyCamAngle(img, ang);                       // this overlay
      applyCamAngleAll(cam.id);                      // and the live tile card(s)
    };
    const ZOOM_STEP = 0.5;
    const zoomOutBtn = el('button', 'up-overlay-btn');
    const zoomInBtn = el('button', 'up-overlay-btn');
    const syncZoomBtns = () => {
      const z = angleOf(cam.id).zoom;
      zoomOutBtn.disabled = z <= 1;
      zoomInBtn.disabled = z >= MAX_ZOOM;
      frame.classList.toggle('is-zoomed', z > 1);
    };
    zoomOutBtn.type = 'button'; zoomOutBtn.setAttribute('aria-label', t('unifi_zoom_out', 'Zoom out'));
    zoomOutBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M8 11h6"/></svg>';
    zoomOutBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const a = angleOf(cam.id);
      setCamAngle(cam.id, { ...a, zoom: a.zoom - ZOOM_STEP });
      applyToBoth(); syncZoomBtns();
    });
    zoomInBtn.type = 'button'; zoomInBtn.setAttribute('aria-label', t('unifi_zoom_in', 'Zoom in'));
    zoomInBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M11 8v6M8 11h6"/></svg>';
    zoomInBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const a = angleOf(cam.id);
      setCamAngle(cam.id, { ...a, zoom: a.zoom + ZOOM_STEP });
      applyToBoth(); syncZoomBtns();
    });
    const rotateBtn = el('button', 'up-overlay-btn');
    rotateBtn.type = 'button'; rotateBtn.setAttribute('aria-label', t('unifi_rotate', 'Rotate'));
    rotateBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v5h-5"/></svg>';
    rotateBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const a = angleOf(cam.id);
      setCamAngle(cam.id, { ...a, rot: ROTATIONS[(ROTATIONS.indexOf(a.rot) + 1) % 4] });
      applyToBoth();
    });
    const flipBtn = el('button', 'up-overlay-btn');
    flipBtn.type = 'button'; flipBtn.setAttribute('aria-label', t('unifi_flip', 'Mirror'));
    flipBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18"/><path d="M17 8l3 4-3 4"/><path d="M7 8l-3 4 3 4"/></svg>';
    flipBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const a = angleOf(cam.id);
      setCamAngle(cam.id, { ...a, flip: !a.flip });
      applyToBoth();
    });
    bar.append(zoomOutBtn, zoomInBtn, rotateBtn, flipBtn);

    // Drag-to-pan while zoomed in — the touch-native way to frame the view. Live
    // preview on the overlay; persisted (and pushed to the tile card) on release.
    let drag = null;
    frame.addEventListener('pointerdown', (e) => {
      const a = angleOf(cam.id);
      if (a.zoom <= 1) return;
      drag = { x: e.clientX, y: e.clientY, panX: a.panX, panY: a.panY, span: a.zoom - 1, moved: false };
      try { frame.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      frame.classList.add('is-panning');
      e.preventDefault();
    });
    const panTo = (e) => {
      const w = frame.clientWidth || 1, h = frame.clientHeight || 1;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      const panX = Math.min(100, Math.max(-100, drag.panX + (dx * 200) / (drag.span * w)));
      const panY = Math.min(100, Math.max(-100, drag.panY + (dy * 200) / (drag.span * h)));
      return { panX, panY };
    };
    frame.addEventListener('pointermove', (e) => {
      if (!drag) return;
      applyCamAngle(img, { ...angleOf(cam.id), ...panTo(e) });
    });
    const endDrag = (e) => {
      if (!drag) return;
      const p = panTo(e);
      const moved = drag.moved;
      drag = null;
      frame.classList.remove('is-panning');
      setCamAngle(cam.id, { ...angleOf(cam.id), ...p });
      applyCamAngle(img, angleOf(cam.id));
      applyCamAngleAll(cam.id);
      if (moved) e.stopPropagation();               // a pan-release is not a close-tap
    };
    frame.addEventListener('pointerup', endDrag);
    frame.addEventListener('pointercancel', endDrag);
    // A tap on the framed image should never close the overlay (close via ✕ or the
    // dark backdrop) — otherwise a pan gesture would dismiss it.
    frame.addEventListener('click', (e) => e.stopPropagation());

    const close = el('button', 'up-overlay-close', '');
    close.type = 'button';
    close.setAttribute('aria-label', t('close', 'Close'));
    close.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    close.addEventListener('click', (e) => { e.stopPropagation(); closeExpand(tile); });
    bar.append(close);
    overlay.append(frame, bar);
    overlay.addEventListener('click', () => closeExpand(tile));
    document.body.appendChild(overlay);
    syncZoomBtns();
    tile.overlay = overlay;
    tile.expandCam = { id: cam.id, name: cam.name, img, loading: false };
    refreshOne(tile.expandCam);
    if (!tile._esc) {
      tile._esc = (e) => { if (e.key === 'Escape') closeExpand(tile); };
      document.addEventListener('keydown', tile._esc);
    }
  }

  function closeExpand(tile) {
    if (tile.overlay) { tile.overlay.remove(); tile.overlay = null; }
    tile.expandCam = null;
    if (tile._esc) { document.removeEventListener('keydown', tile._esc); tile._esc = null; }
  }

  // ── Visibility ────────────────────────────────────────────────────────────────
  function observeVisibility(tile) {
    const section = tile.mount.closest('.dashboard-widget') || tile.mount.parentElement;
    if (!section) return;
    if (tile._mo && tile.section === section) { tile._evaluate && tile._evaluate(); return; }  // already observing
    tile.section = section;
    if (tile._mo) tile._mo.disconnect();
    const evaluate = () => {
      const hidden = section.getAttribute('data-dashboard-hidden') === 'true';
      const onScreen = section.offsetParent !== null && section.clientWidth > 0;
      tile.onScreen = !hidden && onScreen;
      applyTileState(tile);
    };
    tile._mo = new MutationObserver(evaluate);
    tile._mo.observe(section, { attributes: true, attributeFilter: ['data-dashboard-hidden', 'style', 'class'] });
    tile._evaluate = evaluate;
    evaluate();
  }

  function instanceIdOf(section) {
    const item = section.closest('.grid-stack-item');
    return (item && item.getAttribute('gs-id')) || 'unifi';
  }

  // ── Scanning ──────────────────────────────────────────────────────────────────
  function scan() {
    if (typeof document === 'undefined') return;
    document.querySelectorAll('[data-dashboard-widget="unifi"]').forEach((section) => {
      const mount = section.querySelector('.unifi-widget-mount');
      if (!mount) return;
      const id = instanceIdOf(section);
      const existing = tiles.get(id);
      if (existing) {
        existing.mount = mount;
        if (!mount.firstChild) render(existing);     // grid just re-mounted
        observeVisibility(existing);
        return;
      }
      const tile = { id, mount, cams: [], state: null, onScreen: false, pulling: false, timer: null, statePoll: null };
      tiles.set(id, tile);
      observeVisibility(tile);
      loadState(tile);
    });
    // Free a tile whose widget was removed from the dashboard.
    tiles.forEach((tile, id) => {
      if (tile.section && !document.contains(tile.section)) {
        stopPulling(tile);
        closeExpand(tile);
        if (tile._mo) tile._mo.disconnect();
        tiles.delete(id);
      }
    });
    evalPerfPause();
  }

  // ── Settings card ─────────────────────────────────────────────────────────────
  let camCache = null;   // cameras from the last successful connect, for the picker

  function settingsMount() { return document.getElementById('settings-unifi-hub'); }

  function initSettings() {
    const host = settingsMount();
    if (!host) return;
    const u = window.getUnifiSettings ? window.getUnifiSettings() : { host: '', username: '', cameras: [], passwordSet: false };
    host.replaceChildren(buildSettingsCard(u));
  }

  // Push the just-saved layout to any live tile without waiting for a settings poll.
  function notifyLayout() {
    try { if (window.UnifiProtect && window.UnifiProtect.applyLayout) window.UnifiProtect.applyLayout(); } catch (e) { /* ignore */ }
  }

  // A labelled segmented control: [ Auto | 1 | 2 | … ]. onPick gets the raw value.
  function buildSegment(labelText, options, current, onPick) {
    const row = el('div', 'sh-set-row up-seg-row');
    row.appendChild(el('span', 'sh-set-label', labelText));
    const seg = el('div', 'up-seg');
    const btns = [];
    options.forEach((o) => {
      const b = el('button', 'up-seg-btn', o.label);
      b.type = 'button';
      if (String(o.value) === String(current)) b.classList.add('is-active');
      b.addEventListener('click', () => {
        btns.forEach((x) => x.classList.remove('is-active'));
        b.classList.add('is-active');
        onPick(o.value);
      });
      btns.push(b);
      seg.appendChild(b);
    });
    row.appendChild(seg);
    return row;
  }

  function buildLayoutSection(u) {
    const wrap = el('div', 'up-layout');
    wrap.appendChild(el('div', 'sh-set-picker-title', t('unifi_layout', 'Layout')));
    wrap.appendChild(buildSegment(
      t('unifi_columns', 'Columns'),
      [{ value: 0, label: t('unifi_auto', 'Auto') }, { value: 1, label: '1' }, { value: 2, label: '2' }, { value: 3, label: '3' }, { value: 4, label: '4' }],
      Number(u.columns) || 0,
      (v) => { if (window.setUnifiSettings) window.setUnifiSettings({ columns: v }); notifyLayout(); }
    ));
    wrap.appendChild(buildSegment(
      t('unifi_fit', 'Image'),
      [{ value: 'cover', label: t('unifi_fit_fill', 'Fill') }, { value: 'contain', label: t('unifi_fit_fit', 'Fit') }],
      u.fit === 'contain' ? 'contain' : 'cover',
      (v) => { if (window.setUnifiSettings) window.setUnifiSettings({ fit: v }); notifyLayout(); }
    ));
    wrap.appendChild(buildSegment(
      t('unifi_aspect', 'Aspect'),
      [{ value: '16:9', label: '16:9' }, { value: '4:3', label: '4:3' }, { value: '1:1', label: '1:1' }],
      ASPECT_CSS[u.aspect] ? u.aspect : '16:9',
      (v) => { if (window.setUnifiSettings) window.setUnifiSettings({ aspect: v }); notifyLayout(); }
    ));
    wrap.appendChild(buildSegment(
      t('unifi_refresh', 'Update rate'),
      [{ value: 1500, label: '1.5s' }, { value: 3000, label: '3s' }, { value: 5000, label: '5s' }, { value: 10000, label: '10s' }],
      Number(u.refreshMs) || DEFAULT_REFRESH_MS,
      (v) => { if (window.setUnifiSettings) window.setUnifiSettings({ refreshMs: v }); notifyLayout(); }
    ));
    const hint = el('div', 'sh-set-hint', t('unifi_angle_hint', 'Tip: tap a camera to enlarge it, then rotate or mirror the view.'));
    wrap.appendChild(hint);
    return wrap;
  }

  // Camera notifications: a master toggle + per-kind checkboxes + a cooldown. All
  // persisted in settings.unifi.notify; the server opens its updates WebSocket only
  // while a tile is on screen AND this is enabled. Toasts additionally follow the
  // global Notifiche switch (noted in the hint).
  const NOTIFY_KINDS = [
    ['person', 'unifi_kind_person', 'Person'], ['vehicle', 'unifi_kind_vehicle', 'Vehicle'],
    ['package', 'unifi_kind_package', 'Package'], ['animal', 'unifi_kind_animal', 'Animal'],
    ['motion', 'unifi_kind_motion', 'Motion'], ['ring', 'unifi_kind_ring', 'Doorbell'],
  ];

  function buildNotifySection(u) {
    const src = (u.notify && typeof u.notify === 'object') ? u.notify : {};
    const srcTypes = (src.types && typeof src.types === 'object') ? src.types : {};
    const cur = { enabled: src.enabled === true, types: {}, cooldownSec: Number(src.cooldownSec) || 45 };
    NOTIFY_KINDS.forEach(([k]) => { cur.types[k] = srcTypes[k] === true; });
    const save = () => { if (window.setUnifiSettings) window.setUnifiSettings({ notify: { enabled: cur.enabled, types: { ...cur.types }, cooldownSec: cur.cooldownSec } }); };

    const wrap = el('div', 'up-layout up-notify');
    wrap.appendChild(el('div', 'sh-set-picker-title', t('unifi_notify', 'Notifications')));

    const body = el('div', 'up-notify-body');
    const syncDisabled = () => body.classList.toggle('is-disabled', !cur.enabled);

    const enRow = el('label', 'sh-set-check up-notify-master');
    const enCb = el('input'); enCb.type = 'checkbox'; enCb.checked = cur.enabled;
    enRow.append(enCb, el('span', 'sh-set-check-name', t('unifi_notify_enable', 'Notify me on camera activity')));
    enCb.addEventListener('change', () => { cur.enabled = enCb.checked; syncDisabled(); save(); });
    wrap.appendChild(enRow);

    NOTIFY_KINDS.forEach(([k, key, fb]) => {
      const row = el('label', 'sh-set-check');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = cur.types[k];
      row.append(cb, el('span', 'sh-set-check-name', t(key, fb)));
      cb.addEventListener('change', () => { cur.types[k] = cb.checked; save(); });
      body.appendChild(row);
    });
    body.appendChild(buildSegment(
      t('unifi_notify_cooldown', 'Min. gap'),
      [{ value: 15, label: '15s' }, { value: 30, label: '30s' }, { value: 45, label: '45s' }, { value: 60, label: '1m' }, { value: 120, label: '2m' }],
      cur.cooldownSec,
      (v) => { cur.cooldownSec = Number(v) || 45; save(); }
    ));
    syncDisabled();
    wrap.appendChild(body);
    wrap.appendChild(el('div', 'sh-set-hint', t('unifi_notify_hint', 'Needs a camera with smart detections. Pop-ups also follow the global Notifications switch.')));
    return wrap;
  }

  function buildSettingsCard(u) {
    const card = el('div', 'sh-set-card');
    card.appendChild(el('div', 'sh-set-desc', t('unifi_settings_desc', 'Show your UniFi Protect cameras on the dashboard. Use a local Protect account (Viewer role, no 2-factor).')));

    const hostRow = el('label', 'sh-set-row');
    hostRow.appendChild(el('span', 'sh-set-label', t('unifi_host', 'Console address')));
    const hostIn = el('input', 'sh-set-input'); hostIn.type = 'text'; hostIn.placeholder = '192.168.1.1'; hostIn.value = u.host || '';
    hostRow.appendChild(hostIn);
    card.appendChild(hostRow);

    const userRow = el('label', 'sh-set-row');
    userRow.appendChild(el('span', 'sh-set-label', t('unifi_username', 'Username')));
    const userIn = el('input', 'sh-set-input'); userIn.type = 'text'; userIn.autocomplete = 'off'; userIn.value = u.username || '';
    userRow.appendChild(userIn);
    card.appendChild(userRow);

    const passRow = el('label', 'sh-set-row');
    passRow.appendChild(el('span', 'sh-set-label', t('unifi_password', 'Password')));
    const passIn = el('input', 'sh-set-input'); passIn.type = 'password'; passIn.autocomplete = 'off';
    passIn.placeholder = u.passwordSet ? '••••••••  ' + t('settings_ha_token_saved', 'Saved') : '';
    passRow.appendChild(passIn);
    card.appendChild(passRow);
    card.appendChild(el('div', 'sh-set-help', t('unifi_help', 'Enter the console’s local IP or hostname. A dedicated local account with the Viewer role and 2-factor turned off works best.')));

    const actions = el('div', 'sh-set-actions');
    const connect = el('button', 'ui-btn ui-btn--primary', t('settings_ha_connect', 'Connect'));
    connect.type = 'button';
    const status = el('span', 'sh-set-status');
    actions.append(connect, status);
    card.appendChild(actions);

    const picker = el('div', 'sh-set-picker');
    card.appendChild(picker);

    // How the cameras are laid out on the tile — independent of the console
    // connection, so it's always available (defaults match the current look).
    card.appendChild(buildLayoutSection(u));
    card.appendChild(buildNotifySection(u));

    connect.addEventListener('click', async () => {
      connect.disabled = true; status.className = 'sh-set-status'; status.textContent = t('settings_ha_connecting', 'Connecting…');
      const payload = { host: hostIn.value.trim(), username: userIn.value.trim() };
      if (passIn.value) payload.password = passIn.value;
      const r = await api('/api/unifiprotect/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      connect.disabled = false;
      if (r && r.ok) {
        const patch = { host: hostIn.value.trim(), username: userIn.value.trim() };
        if (passIn.value) patch.password = passIn.value;
        if (window.setUnifiSettings) window.setUnifiSettings(patch);
        passIn.value = ''; passIn.placeholder = '••••••••  ' + t('settings_ha_token_saved', 'Saved');
        status.className = 'sh-set-status ok';
        status.textContent = t('settings_ha_ok', 'Connected') + ' · ' + (r.count || 0) + ' ' + t('unifi_cameras_word', 'cameras');
        camCache = Array.isArray(r.cameras) ? r.cameras : [];
        renderPicker(picker);
      } else {
        status.className = 'sh-set-status err'; status.textContent = t('settings_ha_fail', 'Connection failed');
      }
    });

    if (u.host && u.passwordSet) renderPicker(picker);
    else picker.appendChild(el('div', 'sh-set-hint', t('unifi_connect_first', 'Connect to pick which cameras to show.')));

    return card;
  }

  async function fetchCamerasForPicker() {
    // Always try a fresh list first so a camera added on the console since the last
    // connect shows up in the picker; fall back to the last connect result only if
    // /state isn't warmed yet (or momentarily fails).
    const d = await api('/api/unifiprotect/state');
    const list = (d && Array.isArray(d.cameras)) ? d.cameras : [];
    if (list.length) { camCache = list; return list; }
    return (camCache && camCache.length) ? camCache : list;
  }

  const ARROW_UP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 14l6-6 6 6"/></svg>';
  const ARROW_DOWN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 10l6 6 6-6"/></svg>';

  async function renderPicker(host) {
    host.replaceChildren(el('div', 'sh-set-hint', t('settings_ha_connecting', 'Connecting…')));
    const items = await fetchCamerasForPicker();
    if (!settingsMount()) return;                 // Settings closed while awaiting
    host.replaceChildren();
    host.appendChild(el('div', 'sh-set-picker-title', t('unifi_pick', 'Cameras to show')));
    if (!items.length) { host.appendChild(el('div', 'sh-set-hint', t('unifi_no_cameras', 'No cameras found'))); return; }

    const u = window.getUnifiSettings ? window.getUnifiSettings() : { cameras: [], order: [] };
    // Empty selection means "show all" — reflect that as every box checked.
    const chosen = new Set((u.cameras && u.cameras.length) ? u.cameras : items.map((c) => c.id));
    // Display order: apply the saved order (new cameras fall to the end); copy so
    // the reorder buttons can mutate it without touching the source list.
    let ordered = orderCameras(items, Array.isArray(u.order) ? u.order : []).slice();
    const naturalIds = items.map((c) => c.id).join(',');

    host.appendChild(el('div', 'sh-set-hint', t('unifi_reorder_hint', 'Use the arrows to change the order cameras appear in.')));
    const listWrap = el('div', 'sh-set-list');
    host.appendChild(listWrap);

    function persistSelection() {
      // If every camera is checked, save an empty list (the "show all" default) so
      // newly-added cameras appear too. Keep at least one camera selected.
      const sel = ordered.filter((x) => chosen.has(x.id)).map((x) => x.id);
      const value = (sel.length === items.length) ? [] : sel;
      if (window.setUnifiSettings) window.setUnifiSettings({ cameras: value });
    }
    function persistOrder() {
      const ids = ordered.map((x) => x.id);
      // Natural (console) order → save empty so new cameras keep flowing to the end.
      const value = ids.join(',') === naturalIds ? [] : ids;
      if (window.setUnifiSettings) window.setUnifiSettings({ order: value });
      notifyLayout();
    }
    function move(i, delta) {
      const j = i + delta;
      if (j < 0 || j >= ordered.length) return;
      const tmp = ordered[i]; ordered[i] = ordered[j]; ordered[j] = tmp;
      renderRows();
      persistOrder();
    }
    function renderRows() {
      listWrap.replaceChildren();
      ordered.forEach((c, i) => {
        const row = el('div', 'sh-set-check up-reorder-row');
        // Only the name half is a <label> so tapping the reorder arrows never
        // toggles the checkbox.
        const nameLabel = el('label', 'up-reorder-name');
        const cb = el('input'); cb.type = 'checkbox'; cb.checked = chosen.has(c.id);
        cb.addEventListener('change', () => {
          if (cb.checked) chosen.add(c.id); else chosen.delete(c.id);
          // A Cameras tile with zero cameras is meaningless, and empty = "show all",
          // so unchecking the last box would flip to showing EVERY camera. Keep one.
          if (chosen.size === 0) { chosen.add(c.id); cb.checked = true; return; }
          persistSelection();
        });
        nameLabel.append(cb, el('span', 'sh-set-check-name', c.name));
        if (c.connected === false) nameLabel.append(el('span', 'sh-set-check-type', t('unifi_offline', 'offline')));
        const moves = el('div', 'up-reorder-moves');
        const up = el('button', 'up-move-btn'); up.type = 'button'; up.innerHTML = ARROW_UP;
        up.setAttribute('aria-label', t('unifi_move_up', 'Move up')); up.disabled = i === 0;
        up.addEventListener('click', () => move(i, -1));
        const down = el('button', 'up-move-btn'); down.type = 'button'; down.innerHTML = ARROW_DOWN;
        down.setAttribute('aria-label', t('unifi_move_down', 'Move down')); down.disabled = i === ordered.length - 1;
        down.addEventListener('click', () => move(i, 1));
        moves.append(up, down);
        row.append(nameLabel, moves);
        listWrap.appendChild(row);
      });
    }
    renderRows();
  }

  // Open the Settings modal on the Cameras category (settings.js globals).
  function openUnifiSettings() {
    try {
      const overlay = document.getElementById('settings-overlay');
      if (overlay && overlay.hidden && typeof toggleSettings === 'function') toggleSettings();
      if (typeof settingsSetCategory === 'function') settingsSetCategory('unifi');
    } catch (e) { /* ignore */ }
  }

  // ── Boot ──────────────────────────────────────────────────────────────────────
  function renderWidgets() { tiles.forEach((tile) => { if (tile.state) render(tile); }); }

  function init() {
    let queued = false;
    const obs = new MutationObserver(() => {
      if (queued) return; queued = true;
      requestAnimationFrame(() => { queued = false; scan(); });
    });
    obs.observe(document.body, { childList: true, subtree: true });
    new MutationObserver(evalPerfPause).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    scan();
    evalPerfPause();
  }

  // Flash a transient "person / vehicle / …" badge on a camera card when the server
  // reports a detection for it (SSE `unifi_event`). Purely visual; auto-clears.
  // NOTIFY_KINDS (the settings checkboxes) is the single kind→label source; the
  // toast in main.js goes through kindLabel too, so a new detection kind needs
  // exactly one client-side entry.
  const NOTIFY_LABELS = Object.fromEntries(NOTIFY_KINDS.map(([k, key, fb]) => [k, [key, fb]]));
  function kindLabel(kind) {
    const lbl = NOTIFY_LABELS[kind];
    return lbl ? t(lbl[0], lbl[1]) : String(kind || '');
  }
  function flashCamNotify(cam, kind) {
    if (!cam || !cam.card) return;
    let chip = cam.card.querySelector('.up-cam-alert');
    if (!chip) { chip = el('div', 'up-cam-alert'); cam.card.appendChild(chip); }
    chip.textContent = kindLabel(kind);
    cam.card.classList.add('up-cam--alert');
    if (cam._alertTimer) clearTimeout(cam._alertTimer);
    cam._alertTimer = setTimeout(() => {
      if (cam.card) cam.card.classList.remove('up-cam--alert');
      if (chip && chip.parentNode) chip.remove();
      cam._alertTimer = null;
    }, 6000);
  }

  // A camera detection arrived over SSE → flash the matching card on every tile that
  // shows that camera (a camera can be mirrored across pages).
  function onNotification(d) {
    if (!d || !d.camId) return;
    tiles.forEach((tile) => {
      const cam = (tile.cams || []).find((c) => c.id === d.camId);
      if (cam) flashCamNotify(cam, String(d.kind || ''));
    });
  }

  window.UnifiProtect = { initSettings, renderWidgets, applyLayout: applyLayoutAll, onNotification, kindLabel };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
