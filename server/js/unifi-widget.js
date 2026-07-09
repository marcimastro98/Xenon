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

  const REFRESH_MS = 1500;        // snapshot cadence per camera while visible
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
    tile.timer = setInterval(() => tick(tile), REFRESH_MS);
    if (!tile.statePoll) tile.statePoll = setInterval(() => loadState(tile), STATE_POLL_MS);
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
    const grid = el('div', 'up-grid');
    grid.style.setProperty('--up-count', String(cameras.length));
    tile.cams = cameras.map((c) => {
      const card = el('button', 'up-cam');
      card.type = 'button';
      card.title = c.name;
      const img = el('img', 'up-cam-img');
      img.alt = c.name;
      img.decoding = 'async';
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

  // ── Expand one camera to a full-viewport overlay (portal to <body>). ───────────
  function openExpand(tile, cam) {
    if (tile.overlay) closeExpand(tile);
    const overlay = el('div', 'up-overlay');
    const img = el('img', 'up-overlay-img');
    img.alt = cam.name;
    const bar = el('div', 'up-overlay-bar');
    bar.append(el('span', 'up-overlay-name', cam.name));
    const close = el('button', 'up-overlay-close', '');
    close.type = 'button';
    close.setAttribute('aria-label', t('close', 'Close'));
    close.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    close.addEventListener('click', (e) => { e.stopPropagation(); closeExpand(tile); });
    bar.append(close);
    overlay.append(img, bar);
    overlay.addEventListener('click', () => closeExpand(tile));
    document.body.appendChild(overlay);
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

  async function renderPicker(host) {
    host.replaceChildren(el('div', 'sh-set-hint', t('settings_ha_connecting', 'Connecting…')));
    const items = await fetchCamerasForPicker();
    if (!settingsMount()) return;                 // Settings closed while awaiting
    host.replaceChildren();
    host.appendChild(el('div', 'sh-set-picker-title', t('unifi_pick', 'Cameras to show')));
    if (!items.length) { host.appendChild(el('div', 'sh-set-hint', t('unifi_no_cameras', 'No cameras found'))); return; }

    const u = window.getUnifiSettings ? window.getUnifiSettings() : { cameras: [] };
    // Empty selection means "show all" — reflect that as every box checked.
    const chosen = new Set((u.cameras && u.cameras.length) ? u.cameras : items.map((c) => c.id));

    const listWrap = el('div', 'sh-set-list');
    host.appendChild(listWrap);
    items.forEach((c) => {
      const row = el('label', 'sh-set-check');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = chosen.has(c.id);
      cb.addEventListener('change', () => {
        if (cb.checked) chosen.add(c.id); else chosen.delete(c.id);
        // A Cameras tile with zero cameras is meaningless — and because an empty
        // list is the "show all" default, unchecking the last box would flip the
        // tile to showing EVERY camera, the opposite of intent. So keep at least one
        // selected: revert this uncheck. To show no cameras, hide the tile instead.
        if (chosen.size === 0) { chosen.add(c.id); cb.checked = true; return; }
        // Persist in the camera list's own order. If every camera is checked, save
        // an empty list (the "show all" default) so newly-added cameras appear too.
        const ordered = items.filter((x) => chosen.has(x.id)).map((x) => x.id);
        const value = (ordered.length === items.length) ? [] : ordered;
        if (window.setUnifiSettings) window.setUnifiSettings({ cameras: value });
      });
      row.append(cb, el('span', 'sh-set-check-name', c.name));
      if (c.connected === false) row.append(el('span', 'sh-set-check-type', t('unifi_offline', 'offline')));
      listWrap.appendChild(row);
    });
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

  window.UnifiProtect = { initSettings, renderWidgets };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
