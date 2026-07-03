'use strict';
// "Browser" dashboard widget — an interactive web page rendered inside a tile,
// now with a Chrome-style tab strip so one tile can hold several pages.
//
// The server runs a headless Edge (via CDP) and streams JPEG frames over a single
// loopback WebSocket (/embedded-browser/ws); we draw them onto a <canvas> and send
// pointer/keyboard input back. To keep it cheap, only the ACTIVE tab of a visible
// tile streams: background tabs keep their page alive (so switching back is instant
// and preserves scroll/login) but with the screencast off, so they emit no frames
// and cost almost nothing. A hidden/off-screen tile stops streaming immediately and,
// if it stays hidden, closes every tab's page so the headless Edge can shut down.
//
// Structure: a GROUP is the visible tile (one per grid instance, keyed by the
// .grid-stack-item gs-id) and owns the shared DOM — toolbar, tab strip and stage.
// Each TAB owns its own page (a distinct server tile id `${gsId}::${seq}`), its own
// canvas and its own URL/loaded state; all tab canvases live stacked in the stage,
// only the active one shown. The server treats each tab id as an independent tile,
// so no server change is needed.
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
    clear: ICON('<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13h10l1-13"/>'),
    plus: ICON('<path d="M12 5v14M5 12h14"/>'),
    close: ICON('<path d="M6 6l12 12M18 6L6 18"/>'),
    star: ICON('<path d="M12 3l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8L3.5 9.2l5.9-.9L12 3z"/>'),
  };

  const MAX_TABS = 6;
  const MAX_FAVORITES = 16;

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

  // Pretty label for a tab from its URL (hostname without a leading www).
  function tabLabel(url) {
    const s = String(url || '').trim();
    if (!s) return t('browser_new_tab', 'New tab');
    try { return new URL(/^https?:/i.test(s) ? s : 'https://' + s).hostname.replace(/^www\./, ''); }
    catch (e) { return s.replace(/^https?:\/\//, '').split('/')[0] || s; }
  }

  const groups = new Map();    // gsId -> group state (the visible tile)
  const tabsById = new Map();  // server tile id -> tab state
  let relay = null;            // shared WebSocket to the server relay
  let available = null;        // null = unknown, true/false once probed
  let perfPaused = false;      // true → suspend streaming (game/performance mode, if opted in)
  const CLOSE_DELAY_MS = 30000;

  // A group streams only while it's on screen AND not suspended by game/performance
  // mode. Re-evaluated whenever either input changes.
  function applyGroupState(group) {
    const want = group.onScreen && !perfPaused;
    if (want && !group.visible) showGroup(group);
    else if (!want && group.visible) hideGroup(group);
  }

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
    groups.forEach((group) => applyGroupState(group));
  }

  // ── Relay socket ────────────────────────────────────────────────────────────
  function ensureRelay() {
    if (relay && (relay.readyState === 0 || relay.readyState === 1)) return;
    try {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      relay = new WebSocket(proto + '//' + location.host + '/embedded-browser/ws');
    } catch (e) { relay = null; return; }
    relay.addEventListener('open', () => {
      // Re-open the active tab of any group that should currently be streaming.
      groups.forEach((group) => {
        group.tabs.forEach((tab) => { tab.opened = false; tab.streaming = false; });
        if (group.visible) openActive(group);
      });
    });
    relay.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (!m || !m.tile) return;
      const tab = tabsById.get(m.tile);
      if (!tab) return;
      if (m.type === 'frame') drawFrame(tab, m.data, m.meta);
      else if (m.type === 'nav' || m.type === 'opened') { if (m.url) setTabUrl(tab, m.url); }
      else if (m.type === 'error') handleTabError(tab, m.error);
      else if (m.type === 'cleared') { if (typeof showHubToast === 'function') showHubToast(t('browser_clear', 'Browser'), t('browser_cleared', 'Site data cleared — the page has been reloaded.'), ''); }
    });
    const drop = () => { tabsById.forEach((tab) => { tab.opened = false; tab.streaming = false; }); };
    relay.addEventListener('close', drop);
    relay.addEventListener('error', drop);
  }

  function relaySend(obj) {
    ensureRelay();
    if (!relay || relay.readyState !== 1) return false;
    try { relay.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
  }

  // ── Metrics ───────────────────────────────────────────────────────────────────
  function groupMetrics(group) {
    const rect = group.stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return { w: Math.max(64, Math.round(rect.width)), h: Math.max(64, Math.round(rect.height)), dpr };
  }

  // ── Tab lifecycle ──────────────────────────────────────────────────────────────
  function activeTab(group) { return group.tabs[group.active] || null; }

  function openTab(group, tab) {
    if (!tab || !tab.url) return;
    const mtr = groupMetrics(group);
    if (relaySend({ type: 'open', tile: tab.tileId, url: tab.url, w: mtr.w, h: mtr.h, dpr: mtr.dpr })) {
      tab.opened = true; tab.streaming = true;
      showLoading(group);   // spinner until the first frame lands (also covers a stale reopened frame)
    }
  }

  // Open (or resume) the active tab of a group.
  function openActive(group) {
    const tab = activeTab(group);
    if (!tab) return;
    if (!tab.url) { showEmpty(group); return; }
    if (!tab.opened) openTab(group, tab);
    else if (!tab.streaming) { if (relaySend({ type: 'screencast', tile: tab.tileId, on: true })) tab.streaming = true; }
  }

  // Loading indicator: a spinner + text shown while the active tab has no frame yet.
  function showLoading(group) {
    const el = group.loadingEl;
    if (!el) return;
    el.classList.remove('is-error');
    const spin = document.createElement('div');
    spin.className = 'browser-spinner'; spin.setAttribute('aria-hidden', 'true');
    const txt = document.createElement('span');
    txt.className = 'browser-loading-text'; txt.textContent = t('browser_loading', 'Loading…');
    el.replaceChildren(spin, txt);
    el.hidden = false;
  }

  // Empty-tab hint: a freshly added tab with no address yet.
  function showEmpty(group) {
    const el = group.loadingEl;
    if (!el) return;
    el.classList.remove('is-error');
    el.textContent = t('browser_new_tab_hint', 'Enter an address to get started.');
    el.hidden = false;
    if (group.urlInput) { group.urlInput.value = ''; try { group.urlInput.focus(); } catch (e) { /* ignore */ } }
  }

  function showGroup(group) {
    group.visible = true;
    if (group.closeTimer) { clearTimeout(group.closeTimer); group.closeTimer = null; }
    openActive(group);
  }

  function hideGroup(group) {
    group.visible = false;
    group.tabs.forEach((tab) => {
      if (tab.retryTimer) { clearTimeout(tab.retryTimer); tab.retryTimer = null; }
      if (tab.streaming) { relaySend({ type: 'screencast', tile: tab.tileId, on: false }); tab.streaming = false; }
    });
    // Grace period for quick page flips before freeing the headless pages.
    if (group.closeTimer) clearTimeout(group.closeTimer);
    group.closeTimer = setTimeout(() => {
      group.closeTimer = null;
      if (group.visible) return;
      group.tabs.forEach((tab) => { if (tab.opened) { relaySend({ type: 'close', tile: tab.tileId }); tab.opened = false; tab.loaded = false; } });
    }, CLOSE_DELAY_MS);
  }

  function navigateActive(group, rawUrl) {
    const tab = activeTab(group);
    if (!tab) return;
    const url = String(rawUrl || '').trim();
    if (!url) return;
    tab.url = url;
    tab.launchRetries = 0;               // fresh navigation → fresh retry budget
    if (tab.retryTimer) { clearTimeout(tab.retryTimer); tab.retryTimer = null; }
    saveTabs(group);                     // persist
    renderTabStrip(group);               // label may change immediately
    showLoading(group);                  // show progress immediately on a new address
    if (!tab.opened) openTab(group, tab);
    else relaySend({ type: 'navigate', tile: tab.tileId, url });
  }

  function drawFrame(tab, b64, meta) {
    if (!b64 || !tab.canvas) return;
    tab.meta = meta || tab.meta;
    let bytes;
    try { const bin = atob(b64); bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); }
    catch (e) { return; }
    const blob = new Blob([bytes], { type: 'image/jpeg' });
    createImageBitmap(blob).then((bmp) => {
      if (tab.canvas.width !== bmp.width || tab.canvas.height !== bmp.height) {
        tab.canvas.width = bmp.width; tab.canvas.height = bmp.height;
      }
      const ctx = tab.ctx || (tab.ctx = tab.canvas.getContext('2d'));
      ctx.drawImage(bmp, 0, 0);
      bmp.close && bmp.close();
      tab.loaded = true;
      tab.launchRetries = 0;             // a live frame means the browser is healthy again
      // Only the active tab's frame clears the group's loading overlay.
      const group = tab.group;
      if (group && activeTab(group) === tab && group.loadingEl) { group.loadingEl.hidden = true; group.loadingEl.classList.remove('is-error'); }
    }).catch(() => {});
  }

  const MAX_LAUNCH_RETRIES = 2;

  function isLaunchError(code) {
    return /timeout|connect|launch|exited|closed|port|socket|failed/i.test(String(code || ''));
  }

  // Errors self-heal: a launch failure (usually a headless Edge still shutting down
  // from a previous run) is retried silently a couple of times before we surface
  // anything. Only a persistent failure shows a short, plain message.
  function handleTabError(tab, code) {
    const group = tab.group;
    if (isLaunchError(code) && group && group.visible && tab.url && activeTab(group) === tab) {
      tab.launchRetries = (tab.launchRetries || 0) + 1;
      if (tab.launchRetries <= MAX_LAUNCH_RETRIES) {
        showLoading(group);
        if (tab.retryTimer) clearTimeout(tab.retryTimer);
        tab.retryTimer = setTimeout(() => {
          tab.retryTimer = null;
          tab.opened = false; tab.streaming = false;
          if (group.visible && tab.url && activeTab(group) === tab) openTab(group, tab);
        }, 1500);
        return;
      }
    }
    if (group && activeTab(group) === tab) showTabError(group, code);
  }

  function friendlyError(code) {
    const c = String(code || '');
    if (c === 'blocked_scheme') return t('browser_blocked_scheme', 'Only http:// and https:// addresses are allowed.');
    if (c === 'edge_not_found') return t('browser_unavailable', 'Microsoft Edge isn’t installed — it’s required for the Browser widget.');
    if (isLaunchError(c)) return t('browser_err_launch', 'Couldn’t open this page right now. Please try again in a moment.');
    return '';   // no_tile / bad_url / empty_url / unknown → stay quiet
  }

  function showTabError(group, code) {
    const msg = friendlyError(code);
    if (!msg || !group.loadingEl) return;
    group.loadingEl.textContent = msg;
    group.loadingEl.classList.add('is-error');
    group.loadingEl.hidden = false;
  }

  function setTabUrl(tab, url) {
    tab.url = url;
    const group = tab.group;
    if (group) {
      if (activeTab(group) === tab && group.urlInput && document.activeElement !== group.urlInput) group.urlInput.value = url;
      renderTabStrip(group);
    }
  }

  // ── Persistence (per-instance tab list) ────────────────────────────────────────
  // Stored as { tabs: [{ url }], active }. Back-compatible with the old single-URL
  // shape { url }, which becomes a one-tab list on first read.
  function getTabsConfig(id) {
    let raw;
    try { raw = hubSettings.browserTiles && hubSettings.browserTiles[id]; } catch (e) { raw = null; }
    if (raw && Array.isArray(raw.tabs)) {
      const tabs = raw.tabs.map((tb) => ({ url: (tb && typeof tb.url === 'string') ? tb.url : '' }));
      if (!tabs.length) tabs.push({ url: '' });
      const active = Math.max(0, Math.min(tabs.length - 1, Number(raw.active) || 0));
      return { tabs: tabs.slice(0, MAX_TABS), active };
    }
    const legacyUrl = (raw && typeof raw.url === 'string') ? raw.url : '';
    return { tabs: [{ url: legacyUrl }], active: 0 };
  }
  function saveTabs(group) {
    try {
      if (!hubSettings.browserTiles) hubSettings.browserTiles = {};
      hubSettings.browserTiles[group.id] = { tabs: group.tabs.map((tb) => ({ url: tb.url || '' })), active: group.active };
      if (typeof saveHubSettings === 'function') saveHubSettings({ server: true });
    } catch (e) { /* ignore */ }
  }

  // ── Favorites (global quick-access bar, shared by every Browser tile) ──────────
  // Stored as hubSettings.browserFavorites = [{ label, url }]. Kept global on
  // purpose: a favorite defined in one Browser tile is available in all of them.
  function getFavorites() {
    let raw;
    try { raw = hubSettings.browserFavorites; } catch (e) { raw = null; }
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((f) => f && typeof f === 'object' && typeof f.url === 'string' && f.url.trim())
      .slice(0, MAX_FAVORITES)
      .map((f) => ({ label: String(f.label || '').slice(0, 40), url: String(f.url).slice(0, 2048) }));
  }
  function saveFavorites(list) {
    try {
      hubSettings.browserFavorites = list.slice(0, MAX_FAVORITES)
        .map((f) => ({ label: String(f.label || '').slice(0, 40), url: String(f.url || '').slice(0, 2048) }));
      if (typeof saveHubSettings === 'function') saveHubSettings({ server: true });
    } catch (e) { /* ignore */ }
    // The list is global — refresh the bar on every open tile, not just this one.
    groups.forEach((group) => renderFavorites(group));
  }
  function addFavorite(label, url) {
    const u = String(url || '').trim();
    if (!u) return;
    const list = getFavorites();
    if (list.length >= MAX_FAVORITES) {
      if (typeof showHubToast === 'function') showHubToast(t('browser_favorites', 'Favorites'), t('browser_fav_full', 'Maximum number of favorites reached.'), '');
      return;
    }
    list.push({ label: String(label || '').trim().slice(0, 40) || favLabelFromUrl(u), url: u });
    saveFavorites(list);
  }
  function removeFavorite(index) {
    const list = getFavorites();
    if (index < 0 || index >= list.length) return;
    list.splice(index, 1);
    saveFavorites(list);
  }

  // A short display label for a favorite that has none — the URL's hostname.
  function favLabelFromUrl(url) { return tabLabel(url); }

  // Render (or hide) a group's favorites bar. Shown only when there is at least one
  // favorite or the inline add-editor is open, so an unused bar never eats space on
  // a small tile.
  function renderFavorites(group) {
    const row = group.favRow;
    if (!row) return;
    const list = getFavorites();
    const editing = group.favEditor && !group.favEditor.hidden;
    if (!list.length && !editing) { group.favList.replaceChildren(); row.hidden = true; return; }
    row.hidden = false;
    const frag = document.createDocumentFragment();
    list.forEach((fav, i) => {
      const chip = document.createElement('div');
      chip.className = 'browser-fav';
      chip.setAttribute('role', 'button'); chip.tabIndex = 0;
      chip.title = fav.url;
      const label = document.createElement('span');
      label.className = 'browser-fav-label';
      label.textContent = fav.label || favLabelFromUrl(fav.url);
      chip.appendChild(label);
      const del = document.createElement('button');
      del.type = 'button'; del.className = 'browser-fav-del'; del.innerHTML = ICONS.close;
      del.title = t('browser_fav_remove', 'Remove favorite');
      del.addEventListener('click', (e) => { e.stopPropagation(); removeFavorite(i); });
      chip.appendChild(del);
      const go = () => navigateActive(group, fav.url);
      chip.addEventListener('click', go);
      // Only the chip itself navigates on Enter/Space — not a bubbled keypress from
      // the × delete button (which would otherwise navigate and swallow the delete).
      chip.addEventListener('keydown', (e) => { if (e.target === chip && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); go(); } });
      frag.appendChild(chip);
    });
    group.favList.replaceChildren(frag);
  }

  // Open the inline add-editor, prefilled with the active tab's current page so
  // "save this page" is one tap, while the fields stay editable for a manual entry.
  function openFavEditor(group) {
    const ed = group.favEditor;
    if (!ed) return;
    const tab = activeTab(group);
    const url = (tab && tab.url) || '';
    group.favUrlInput.value = url;
    group.favNameInput.value = url ? favLabelFromUrl(url) : '';
    ed.hidden = false;
    renderFavorites(group);   // ensure the row is visible even with no favorites yet
    try { group.favNameInput.focus(); group.favNameInput.select(); } catch (e) { /* ignore */ }
  }
  function closeFavEditor(group) {
    if (group.favEditor) group.favEditor.hidden = true;
    renderFavorites(group);
  }
  function commitFavEditor(group) {
    const url = group.favUrlInput.value;
    if (!String(url || '').trim()) { try { group.favUrlInput.focus(); } catch (e) { /* ignore */ } return; }
    addFavorite(group.favNameInput.value, url);
    closeFavEditor(group);
  }

  // ── Skeleton + input wiring ───────────────────────────────────────────────────
  function instanceIdOf(section) {
    const item = section.closest('.grid-stack-item');
    return (item && item.getAttribute('gs-id')) || 'browser';
  }

  function mkBtn(cls, icon, titleKey, fb, onClick) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'browser-btn ' + cls;
    b.innerHTML = icon; b.title = t(titleKey, fb);
    b.addEventListener('click', onClick);
    return b;
  }

  function buildSkeleton(mount, id) {
    const wrap = document.createElement('div');
    wrap.className = 'browser-wrap';

    // Tab strip (shown only when there are 2+ tabs).
    const tabStrip = document.createElement('div');
    tabStrip.className = 'browser-tabs'; tabStrip.hidden = true;

    const bar = document.createElement('div');
    bar.className = 'browser-bar';
    const back = mkBtn('browser-back', ICONS.back, 'browser_back', 'Back', () => { const tb = activeTab(group); if (tb) relaySend({ type: 'history', tile: tb.tileId, dir: -1 }); });
    const fwd = mkBtn('browser-fwd', ICONS.forward, 'browser_forward', 'Forward', () => { const tb = activeTab(group); if (tb) relaySend({ type: 'history', tile: tb.tileId, dir: 1 }); });
    const reload = mkBtn('browser-reload', ICONS.reload, 'browser_reload', 'Reload', () => { const tb = activeTab(group); if (tb) relaySend({ type: 'reload', tile: tb.tileId }); });
    const input = document.createElement('input');
    input.type = 'text'; input.className = 'browser-url'; input.spellcheck = false;
    input.setAttribute('data-i18n-placeholder', 'browser_url_placeholder');
    input.placeholder = t('browser_url_placeholder', 'Enter an address…');
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); navigateActive(group, input.value); input.blur(); } });
    const go = mkBtn('browser-go', ICONS.go, 'browser_reload', 'Go', () => navigateActive(group, input.value));
    // Clear the active tab's site data (cookies/storage) and reload — the recovery
    // for a site stuck in a broken cached state. Destructive-ish (it signs you out of
    // that site), so it arms on the first tap and acts only on a second tap.
    let clearArmed = null;
    const disarmClear = () => { if (clearArmed) { clearTimeout(clearArmed); clearArmed = null; } clearBtn.classList.remove('is-armed'); clearBtn.title = t('browser_clear', 'Clear site data'); };
    const clearBtn = mkBtn('browser-clear', ICONS.clear, 'browser_clear', 'Clear site data', () => {
      const tb = activeTab(group);
      if (!tb || !tb.opened) return;
      if (clearArmed) { disarmClear(); showLoading(group); relaySend({ type: 'clearData', tile: tb.tileId }); }
      else { clearBtn.classList.add('is-armed'); clearBtn.title = t('browser_clear_confirm', 'Tap again to clear this site’s data'); clearArmed = setTimeout(disarmClear, 3000); }
    });
    const favBtn = mkBtn('browser-favbtn', ICONS.star, 'browser_fav_add', 'Add to favorites', () => openFavEditor(group));
    const newTab = mkBtn('browser-newtab', ICONS.plus, 'browser_new_tab', 'New tab', () => addTab(group, '', true));
    const expand = mkBtn('browser-expand', ICONS.expand, 'browser_expand', 'Expand', () => toggleExpand(group));
    bar.append(back, fwd, reload, input, go, clearBtn, favBtn, newTab, expand);

    // Favorites quick-access bar (global list). Chips navigate the active tab; the
    // inline editor (toggled by the toolbar star) adds a new label+address entry.
    const favRow = document.createElement('div');
    favRow.className = 'browser-favorites'; favRow.hidden = true;
    const favList = document.createElement('div');
    favList.className = 'browser-fav-list';
    const favEditor = document.createElement('div');
    favEditor.className = 'browser-fav-editor'; favEditor.hidden = true;
    const favName = document.createElement('input');
    favName.type = 'text'; favName.className = 'browser-fav-input browser-fav-name'; favName.spellcheck = false;
    favName.placeholder = t('browser_fav_name', 'Name');
    const favUrl = document.createElement('input');
    favUrl.type = 'text'; favUrl.className = 'browser-fav-input browser-fav-url'; favUrl.spellcheck = false;
    favUrl.placeholder = t('browser_fav_url', 'Address');
    const favSave = mkBtn('browser-fav-save', ICONS.go, 'browser_fav_save', 'Save', () => commitFavEditor(group));
    const favCancel = mkBtn('browser-fav-cancel', ICONS.close, 'browser_fav_cancel', 'Cancel', () => closeFavEditor(group));
    const favKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); commitFavEditor(group); } else if (e.key === 'Escape') { e.preventDefault(); closeFavEditor(group); } };
    favName.addEventListener('keydown', favKey);
    favUrl.addEventListener('keydown', favKey);
    favEditor.append(favName, favUrl, favSave, favCancel);
    favRow.append(favList, favEditor);

    const stage = document.createElement('div');
    stage.className = 'browser-stage';
    const loading = document.createElement('div');
    loading.className = 'browser-loading'; loading.textContent = t('browser_loading', 'Loading…'); loading.hidden = true;
    stage.append(loading);

    wrap.append(tabStrip, bar, favRow, stage);
    mount.replaceChildren(wrap);

    const group = {
      id, mount, wrap, bar, stage, tabStrip, urlInput: input, expandBtn: expand, loadingEl: loading,
      favRow, favList, favEditor, favNameInput: favName, favUrlInput: favUrl,
      tabs: [], active: 0, seq: 0, visible: false, onScreen: false, expanded: false, closeTimer: null, moveQueued: false,
    };
    groups.set(id, group);

    // Materialise the persisted tabs.
    const cfg = getTabsConfig(id);
    cfg.tabs.forEach((tb) => createTab(group, tb.url));
    group.active = Math.max(0, Math.min(group.tabs.length - 1, cfg.active));
    renderTabStrip(group);
    renderFavorites(group);
    layoutActiveCanvas(group);
    if (group.urlInput) group.urlInput.value = (activeTab(group) && activeTab(group).url) || '';

    wireResize(group);
    observeVisibility(group, mount);
    return group;
  }

  // Create a tab object + its canvas (added to the stage, hidden unless active).
  function createTab(group, url) {
    const tileId = group.id + '::' + (group.seq++);
    const canvas = document.createElement('canvas');
    canvas.className = 'browser-canvas'; canvas.tabIndex = 0; canvas.hidden = true;
    group.stage.appendChild(canvas);
    const tab = { tileId, group, canvas, ctx: null, meta: null, url: url || '', opened: false, streaming: false, loaded: false, launchRetries: 0, retryTimer: null, lastW: 0, lastH: 0 };
    tabsById.set(tileId, tab);
    group.tabs.push(tab);
    wireInput(group, tab);
    return tab;
  }

  // Add a new tab (optionally activating it). Enforces the tab cap.
  function addTab(group, url, activate) {
    if (group.tabs.length >= MAX_TABS) {
      if (typeof showHubToast === 'function') showHubToast(t('browser_new_tab', 'Browser'), t('browser_tabs_full', 'Maximum number of tabs reached.'), '');
      return null;
    }
    const tab = createTab(group, url || '');
    if (activate) group.active = group.tabs.length - 1;
    renderTabStrip(group);
    saveTabs(group);
    if (activate) activateTab(group, group.active);
    return tab;
  }

  // Close a tab (never the last one); frees its page and activates a neighbour.
  function closeTab(group, tab) {
    if (group.tabs.length <= 1) return;
    const idx = group.tabs.indexOf(tab);
    if (idx < 0) return;
    if (tab.retryTimer) { clearTimeout(tab.retryTimer); tab.retryTimer = null; }
    if (tab.opened) relaySend({ type: 'close', tile: tab.tileId });
    tabsById.delete(tab.tileId);
    if (tab.canvas && tab.canvas.parentNode) tab.canvas.parentNode.removeChild(tab.canvas);
    group.tabs.splice(idx, 1);
    if (group.active >= group.tabs.length) group.active = group.tabs.length - 1;
    else if (idx < group.active) group.active -= 1;
    renderTabStrip(group);
    saveTabs(group);
    activateTab(group, group.active);
  }

  // Switch the active tab: hide/stop the old one, show/open the new one.
  function activateTab(group, index) {
    index = Math.max(0, Math.min(group.tabs.length - 1, index));
    const prev = activeTab(group);
    group.active = index;
    const next = activeTab(group);
    if (prev && prev !== next && prev.streaming) { relaySend({ type: 'screencast', tile: prev.tileId, on: false }); prev.streaming = false; }
    group.tabs.forEach((tb) => { tb.canvas.hidden = (tb !== next); });
    layoutActiveCanvas(group);
    if (group.urlInput && document.activeElement !== group.urlInput) group.urlInput.value = (next && next.url) || '';
    renderTabStrip(group);
    // Reset the loading overlay to reflect the newly active tab.
    if (group.loadingEl) { group.loadingEl.hidden = true; group.loadingEl.classList.remove('is-error'); }
    if (group.visible) {
      openActive(group);
      // Re-assert size for the tab we're switching to (it may have been resized while inactive).
      const m = groupMetrics(group);
      if (next && next.opened) relaySend({ type: 'resize', tile: next.tileId, w: m.w, h: m.h, dpr: m.dpr });
    } else if (next && !next.url) {
      showEmpty(group);
    }
    saveTabs(group);   // persist the active-tab change
  }

  function layoutActiveCanvas(group) {
    group.tabs.forEach((tb, i) => { tb.canvas.hidden = (i !== group.active); });
  }

  // Render the tab strip (hidden when only one tab exists).
  function renderTabStrip(group) {
    const strip = group.tabStrip;
    if (!strip) return;
    if (group.tabs.length < 2) { strip.hidden = true; strip.replaceChildren(); return; }
    strip.hidden = false;
    const frag = document.createDocumentFragment();
    group.tabs.forEach((tab, i) => {
      const el = document.createElement('div');
      el.className = 'browser-tab' + (i === group.active ? ' is-active' : '');
      el.setAttribute('role', 'button'); el.tabIndex = 0;
      const label = document.createElement('span');
      label.className = 'browser-tab-label'; label.textContent = tabLabel(tab.url);
      el.title = tab.url || tabLabel(tab.url);
      el.appendChild(label);
      const close = document.createElement('button');
      close.type = 'button'; close.className = 'browser-tab-close'; close.innerHTML = ICONS.close;
      close.title = t('browser_close_tab', 'Close tab');
      close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(group, tab); });
      el.appendChild(close);
      el.addEventListener('click', () => { if (group.tabs[group.active] !== tab) activateTab(group, group.tabs.indexOf(tab)); });
      frag.appendChild(el);
    });
    strip.replaceChildren(frag);
  }

  function wireInput(group, tab) {
    const canvas = tab.canvas;
    const sendMouse = (subtype, e) => {
      if (!tab.streaming) return;
      const pt = mapPointerToPage(e.clientX, e.clientY, canvas.getBoundingClientRect(), tab.meta, tab.lastW, tab.lastH);
      const button = e.button === 1 ? 'middle' : e.button === 2 ? 'right' : 'left';
      relaySend({ type: 'input', tile: tab.tileId, event: { kind: 'mouse', subtype, x: pt.x, y: pt.y, button, buttons: e.buttons, clickCount: subtype === 'released' || subtype === 'pressed' ? (e.detail || 1) : 0, modifiers: cdpModifiers(e) } });
    };
    canvas.addEventListener('pointerdown', (e) => { canvas.focus(); canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId); sendMouse('pressed', e); e.preventDefault(); });
    canvas.addEventListener('pointerup', (e) => { sendMouse('released', e); });
    canvas.addEventListener('pointermove', (e) => {
      if (!tab.streaming || group.moveQueued) return;     // throttle to one move per frame
      group.moveQueued = true;
      requestAnimationFrame(() => { group.moveQueued = false; });
      sendMouse('moved', e);
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', (e) => {
      if (!tab.streaming) return;
      const pt = mapPointerToPage(e.clientX, e.clientY, canvas.getBoundingClientRect(), tab.meta, tab.lastW, tab.lastH);
      relaySend({ type: 'input', tile: tab.tileId, event: { kind: 'wheel', x: pt.x, y: pt.y, deltaX: e.deltaX, deltaY: e.deltaY, modifiers: cdpModifiers(e) } });
      e.preventDefault();
    }, { passive: false });
    canvas.addEventListener('keydown', (e) => {
      if (!tab.streaming) return;
      relaySend({ type: 'input', tile: tab.tileId, event: { kind: 'key', subtype: 'down', key: e.key, code: e.code, keyCode: e.keyCode, modifiers: cdpModifiers(e) } });
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
        relaySend({ type: 'input', tile: tab.tileId, event: { kind: 'key', subtype: 'char', text: e.key, key: e.key, modifiers: cdpModifiers(e) } });
      }
      // Keep page-driving keys inside the canvas (don't scroll/redirect the dashboard).
      if (['Tab', 'Backspace', ' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(e.key)) e.preventDefault();
    });
    canvas.addEventListener('keyup', (e) => {
      if (!tab.streaming) return;
      relaySend({ type: 'input', tile: tab.tileId, event: { kind: 'key', subtype: 'up', key: e.key, code: e.code, keyCode: e.keyCode, modifiers: cdpModifiers(e) } });
    });
  }

  // Resize → tell the server to re-render the active tab at the new size (rAF-debounced).
  function wireResize(group) {
    let roQueued = false;
    const ro = new ResizeObserver(() => {
      if (roQueued) return; roQueued = true;
      requestAnimationFrame(() => {
        roQueued = false;
        const m = groupMetrics(group);
        const tab = activeTab(group);
        if (tab) { tab.lastW = m.w; tab.lastH = m.h; }
        if (tab && tab.opened) relaySend({ type: 'resize', tile: tab.tileId, w: m.w, h: m.h, dpr: m.dpr });
      });
    });
    ro.observe(group.stage);
    group._ro = ro;
  }

  // Visibility = section not explicitly hidden AND actually occupying screen space.
  // Primary signal is an IntersectionObserver, because a Browser tile's visibility is
  // very often controlled by an ancestor (a tab group's inactive container is
  // display:none; the pager transforms off-screen pages away) that never mutates the
  // section's own attributes — a MutationObserver on the section alone would miss it.
  function observeVisibility(group, mount) {
    const section = mount.closest('.dashboard-widget') || mount.parentElement;
    if (!section) return;
    group.section = section;
    const evaluate = () => {
      const hidden = section.getAttribute('data-dashboard-hidden') === 'true';
      const onScreen = group._io
        ? group._intersecting
        : (section.offsetParent !== null && section.clientWidth > 0);
      group.onScreen = !hidden && onScreen;
      applyGroupState(group);
    };
    group._evaluate = evaluate;
    if (typeof IntersectionObserver === 'function') {
      group._intersecting = section.offsetParent !== null && section.clientWidth > 0;
      const io = new IntersectionObserver((entries) => {
        for (const e of entries) group._intersecting = e.isIntersecting;
        evaluate();
      }, { threshold: 0.01 });
      io.observe(section);
      group._io = io;
    }
    const mo = new MutationObserver(evaluate);
    mo.observe(section, { attributes: true, attributeFilter: ['data-dashboard-hidden', 'style', 'class'] });
    group._mo = mo;
    evaluate();
  }

  // ── Expand to a true full-viewport overlay ────────────────────────────────────
  // Portal the wrap to <body> pinned at inset:0 (same approach the lock screen uses);
  // the GridStack item's stacking context + the Xeneon Edge's root zoom would trap a
  // position:fixed child otherwise. Native OS fullscreen is layered on as a bonus.
  function toggleExpand(group) {
    if (!group) return;
    if (group.expanded) collapse(group); else expand(group);
  }
  function expand(group) {
    if (group.expanded) return;
    group.expanded = true;
    document.body.appendChild(group.wrap);
    group.wrap.classList.add('browser-overlay');
    group.expandBtn.innerHTML = ICONS.collapse; group.expandBtn.title = t('browser_collapse', 'Collapse');
    if (group.wrap.requestFullscreen) {
      group.wrap.requestFullscreen().catch(() => {});
      if (!group._fsHandler) {
        group._fsHandler = () => { if (!document.fullscreenElement && group.expanded) collapse(group); };
        document.addEventListener('fullscreenchange', group._fsHandler);
      }
    }
  }
  function collapse(group) {
    if (!group.expanded) return;
    group.expanded = false;
    group.wrap.classList.remove('browser-overlay');
    group.expandBtn.innerHTML = ICONS.expand; group.expandBtn.title = t('browser_expand', 'Expand');
    if (group._fsHandler) { document.removeEventListener('fullscreenchange', group._fsHandler); group._fsHandler = null; }
    if (document.fullscreenElement) { try { document.exitFullscreen(); } catch (e) { /* ignore */ } }
    if (group.mount) group.mount.appendChild(group.wrap);
  }

  // ── Scanning ──────────────────────────────────────────────────────────────────
  function scan() {
    if (typeof document === 'undefined') return;
    if (available === false) { showUnavailable(); return; }
    document.querySelectorAll('[data-dashboard-widget="browser"]').forEach((section) => {
      const mount = section.querySelector('.browser-widget-mount');
      if (!mount) return;
      const id = instanceIdOf(section);
      const existing = groups.get(id);
      // While expanded the wrap is portaled to <body>, so it's intentionally not
      // inside its mount — don't mistake that for a missing tile and rebuild it.
      if (existing && existing.expanded) { existing.mount = mount; return; }
      if (existing && existing.wrap && mount.contains(existing.wrap)) { existing._evaluate && existing._evaluate(); return; }
      buildSkeleton(mount, id);
    });
    // Release any group whose widget was deleted from the dashboard so its headless
    // pages are freed instead of lingering until reload.
    groups.forEach((group, id) => {
      if (group.section && !document.contains(group.section)) {
        if (group.closeTimer) { clearTimeout(group.closeTimer); group.closeTimer = null; }
        // Disconnect every observer bound to the removed section, otherwise each
        // dashboard rebuild (layout edit, duplication, page churn) orphans three
        // observers whose callbacks retain this group's closure forever.
        if (group._ro) { group._ro.disconnect(); group._ro = null; }
        if (group._io) { group._io.disconnect(); group._io = null; }
        if (group._mo) { group._mo.disconnect(); group._mo = null; }
        group.tabs.forEach((tab) => { if (tab.opened) relaySend({ type: 'close', tile: tab.tileId }); tabsById.delete(tab.tileId); });
        groups.delete(id);
      }
    });
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
    }).catch(() => { available = true; scan(); });
  }

  function init() {
    probeAvailability();
    let queued = false;
    const obs = new MutationObserver(() => {
      if (queued) return; queued = true;
      requestAnimationFrame(() => { queued = false; scan(); });
    });
    obs.observe(document.body, { childList: true, subtree: true });
    new MutationObserver(evalPerfPause).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    evalPerfPause();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // Force every open tile to re-open its active tab. Used after a server-side Edge
  // relaunch (e.g. the ad-blocker toggle tears Edge down): the old CDP pages are
  // gone, so reset each tab's opened/streaming flags and re-open the visible groups'
  // active tab, which relaunches the headless Edge with the new arguments.
  function restart() {
    tabsById.forEach((tab) => { tab.opened = false; tab.streaming = false; });
    groups.forEach((group) => { if (group.visible) { showLoading(group); openActive(group); } });
  }

  // Expose pure helpers for tests / debugging, plus restart() for settings.js.
  window.BrowserTile = { mapPointerToPage, cdpModifiers, tabLabel, restart };
})();
