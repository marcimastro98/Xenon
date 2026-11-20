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
  const { t, tabLabel, showLoading, showEmpty } = window.BrowserTileSays;
  const ICON = (p) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
  const ICONS = {
    back: ICON('<path d="M15 18l-6-6 6-6"/>'),
    forward: ICON('<path d="M9 18l6-6-6-6"/>'),
    reload: ICON('<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>'),
    go: ICON('<path d="M5 12h14M13 6l6 6-6 6"/>'),
    expand: ICON('<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>'),
    collapse: ICON('<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>'),
    hideBar: ICON('<path d="M4 6h16"/><path d="M18 15l-6-6-6 6"/>'),   // hide the top chrome (chevron up onto a line)
    showBar: ICON('<path d="M6 9l6 6 6-6"/>'),                        // reveal it again (chevron down)
    clear: ICON('<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13h10l1-13"/>'),
    plus: ICON('<path d="M12 5v14M5 12h14"/>'),
    close: ICON('<path d="M6 6l12 12M18 6L6 18"/>'),
    star: ICON('<path d="M12 3l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8L3.5 9.2l5.9-.9L12 3z"/>'),
  };

  const { MAX_TABS, getTabsConfig, saveTabs } = window.BrowserTileStore;

  const {
    cdpModifiers, mapPointerToPage, RESIZE_RETRY_MS, RESIZE_MAX_RETRIES, frameMatchesSize,
    groupMetrics, instanceIdOf, pickRevealTarget,
  } = window.BrowserTileMeasures;

  const groups = new Map();    // gsId -> group state (the visible tile)
  const tabsById = new Map();  // server tile id -> tab state
  const tileState = {
    relay: null,            // shared WebSocket to the server relay
    available: null,        // null = unknown, true/false once probed
    perfPaused: false,      // true → suspend streaming (game/performance mode, if opted in)
    // Whether the server said it can install a browser for us. Undefined until
    // /embedded-browser/available answers.
    canInstallBrowser: false,
  };
  const CLOSE_DELAY_MS = 30000;

  // ── Verified resize ───────────────────────────────────────────────────────────

  // A group streams only while it's on screen AND not suspended by game/performance
  // mode. Re-evaluated whenever either input changes.
  // `perfOverride` is the user asking for this tile anyway (typing an address or
  // tapping "Show anyway"): a paused tile that ignored the address bar looked broken
  // with nothing saying why. It lasts until performance mode ends.
  function applyGroupState(group) {
    const paused = tileState.perfPaused && !group.perfOverride;
    const want = group.onScreen && !paused;
    if (want && !group.visible) showGroup(group);
    else if (!want && group.visible) hideGroup(group);
    if (group.onScreen && paused) showPaused(group);
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
    if (pause === tileState.perfPaused) return;
    tileState.perfPaused = pause;
    if (!pause) groups.forEach((group) => { group.perfOverride = false; });
    groups.forEach((group) => applyGroupState(group));
  }

  // ── Relay socket ────────────────────────────────────────────────────────────
  // Frames arrive as binary WebSocket messages ([u16BE header length][JSON
  // header][JPEG bytes]) — requested via {binary:true} on 'open'. No base64 layer
  // on the wire and no per-frame atob loop on the main thread; the JSON 'frame'
  // branch below stays as the fallback against an older server.
  const HEADER_DECODER = typeof TextDecoder === 'function' ? new TextDecoder() : null;
  function handleBinaryFrame(buf) {
    let header, bytes;
    try {
      const hlen = new DataView(buf).getUint16(0);
      header = JSON.parse(HEADER_DECODER.decode(new Uint8Array(buf, 2, hlen)));
      bytes = new Uint8Array(buf, 2 + hlen);
    } catch (e) { return; }
    if (!header || header.type !== 'frame' || !header.tile) return;
    const tab = tabsById.get(header.tile);
    if (tab) drawFrame(tab, bytes, header.meta);
  }

  function ensureRelay() {
    if (tileState.relay && (tileState.relay.readyState === 0 || tileState.relay.readyState === 1)) return;
    try {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      tileState.relay = new WebSocket(proto + '//' + location.host + '/embedded-browser/ws');
      tileState.relay.binaryType = 'arraybuffer';
    } catch (e) { tileState.relay = null; return; }
    tileState.relay.addEventListener('open', () => {
      // Re-open the active tab of any group that should currently be streaming.
      groups.forEach((group) => {
        group.tabs.forEach((tab) => { tab.opened = false; tab.streaming = false; });
        if (group.visible) openActive(group);
      });
    });
    tileState.relay.addEventListener('message', (ev) => {
      if (ev.data instanceof ArrayBuffer) { handleBinaryFrame(ev.data); return; }
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (!m || !m.tile) return;
      const tab = tabsById.get(m.tile);
      if (!tab) return;
      if (m.type === 'frame') drawFrame(tab, m.data, m.meta);
      else if (m.type === 'nav' || m.type === 'opened') { if (m.url) setTabUrl(tab, m.url); }
      else if (m.type === 'error') handleTabError(tab, m.error);
      else if (m.type === 'cleared') { if (typeof showHubToast === 'function') showHubToast(t('browser_clear', 'Browser'), t('browser_cleared', 'Site data cleared: the page has been reloaded.'), ''); }
    });
    const drop = () => { tabsById.forEach((tab) => { tab.opened = false; tab.streaming = false; }); };
    tileState.relay.addEventListener('close', drop);
    tileState.relay.addEventListener('error', drop);
  }

  function relaySend(obj) {
    ensureRelay();
    if (!tileState.relay || tileState.relay.readyState !== 1) return false;
    try { tileState.relay.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
  }

  // ── Metrics ───────────────────────────────────────────────────────────────────
  // Push the group's current stage size to its active tab and arm the watchdog.
  // `retry` marks a self-healing re-ask so a fresh user-driven resize (which is
  // always a new intent) restarts the retry budget instead of exhausting it.
  function pushResize(group, retry) {
    const tab = activeTab(group);
    if (!tab || !tab.opened) return;
    const m = groupMetrics(group);
    tab.lastW = m.w; tab.lastH = m.h;
    // A dropped send needs no watchdog: the relay's own reconnect handler re-opens
    // the active tab, which measures the stage again.
    if (!relaySend({ type: 'resize', tile: tab.tileId, w: m.w, h: m.h, dpr: m.dpr })) return;
    if (!retry) tab.resizeTries = 0;
    clearResizeWatchdog(tab);
    tab.resizeTimer = setTimeout(() => {
      tab.resizeTimer = null;
      const g = tab.group;
      if (!g || !g.visible || !tab.opened || activeTab(g) !== tab) return;
      if (frameMatchesSize(tab.meta, tab.lastW, tab.lastH)) return;
      if (tab.resizeTries >= RESIZE_MAX_RETRIES) return;   // give up quietly rather than loop
      tab.resizeTries++;
      pushResize(g, true);
    }, RESIZE_RETRY_MS);
  }

  function clearResizeWatchdog(tab) {
    if (tab && tab.resizeTimer) { clearTimeout(tab.resizeTimer); tab.resizeTimer = null; }
  }

  // Called for every decoded frame of the active tab. Deliberately compares against
  // the CACHED last-requested size rather than measuring the stage: this sits on the
  // per-frame path, where a getBoundingClientRect() would force a layout read at the
  // stream's frame rate.
  function verifyFrameSize(group, tab) {
    if (frameMatchesSize(tab.meta, tab.lastW, tab.lastH)) {
      tab.resizeTries = 0;
      clearResizeWatchdog(tab);
      return;
    }
    if (tab.resizeTimer) return;                          // a re-ask is already in flight
    if (tab.resizeTries >= RESIZE_MAX_RETRIES) return;
    tab.resizeTries++;
    pushResize(group, true);
  }

  const {
    activeTab, openTab, openActive, showPaused, showGroup, hideGroup,
  } = window.BrowserTileTabLife({ CLOSE_DELAY_MS, applyGroupState, relaySend, clearResizeWatchdog });

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
    // Typing an address is the user asking for this page now, performance mode or
    // not. When resuming opens the tab it opens on the new address already.
    if (tileState.perfPaused && !group.perfOverride) {
      const wasOpened = tab.opened;
      group.perfOverride = true;
      applyGroupState(group);
      if (!wasOpened && tab.opened) return;
    }
    if (tab.opened) { relaySend({ type: 'navigate', tile: tab.tileId, url }); return; }
    // A hidden group's stage measures 0, so opening here would launch the page at
    // the 64px floor and leave it there until the resize watchdog caught up.
    // showGroup()'s openActive opens it at the real size the moment the tile comes
    // into view — the same deferral switchTab() already makes.
    if (group.visible) openTab(group, tab);
  }

  const {
    drawFrame, handleTabError, setTabUrl,
  } = window.BrowserTileFrames({ verifyFrameSize, activeTab, openTab, renderTabStrip });

  // ── Persistence (per-instance tab list) ────────────────────────────────────────

  const {
    renderFavorites, openFavEditor, closeFavEditor, commitFavEditor,
  } = window.BrowserTileFavorites({ ICONS, groups, activeTab, navigateActive });

  // ── Skeleton + input wiring ───────────────────────────────────────────────────
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
    // Hide the whole chrome (tab strip + address bar + favorites) so a maximized
    // video fills the tile. A small floating button over the stage brings it back.
    const hideBar = mkBtn('browser-hidebar', ICONS.hideBar, 'browser_hide_ui', 'Hide toolbar', () => setChromeHidden(group, true));
    const expand = mkBtn('browser-expand', ICONS.expand, 'browser_expand', 'Expand', () => toggleExpand(group));
    bar.append(back, fwd, reload, input, go, clearBtn, favBtn, newTab, hideBar, expand);

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
    // With the toolbar hidden the tile is a page on its own: a local web
    // interface, a Home Assistant dashboard, a video (GitHub #149). It keeps the
    // three things such a page still needs, in one small group over its corner:
    // reload, full screen, and the way back to the toolbar. Back, Forward and
    // the address stay away until the toolbar is back.
    const floatReload = mkBtn('browser-float-reload', ICONS.reload, 'browser_reload', 'Reload', () => { const tb = activeTab(group); if (tb) relaySend({ type: 'reload', tile: tb.tileId }); });
    const floatExpand = mkBtn('browser-float-expand', ICONS.expand, 'browser_expand', 'Expand', () => toggleExpand(group));
    const reveal = mkBtn('browser-reveal', ICONS.showBar, 'browser_show_ui', 'Show toolbar', () => setChromeHidden(group, false));
    const float = document.createElement('div');
    float.className = 'browser-float';
    float.setAttribute('role', 'toolbar');
    float.hidden = true;
    float.append(floatReload, floatExpand, reveal);
    stage.append(loading, float);

    wrap.append(tabStrip, bar, favRow, stage);
    mount.replaceChildren(wrap);

    const group = {
      id, mount, wrap, bar, stage, tabStrip, urlInput: input, expandBtn: expand, loadingEl: loading, floatBar: float, floatExpandBtn: floatExpand,
      favRow, favList, favEditor, favNameInput: favName, favUrlInput: favUrl,
      tabs: [], active: 0, seq: 0, visible: false, onScreen: false, expanded: false, chromeHidden: false, closeTimer: null, moveQueued: false,
    };
    groups.set(id, group);

    // Materialise the persisted tabs. When the tile sits in a tab group, its
    // grid item is the group's — that gs-id is the LEGACY key old saves used.
    const item = mount.closest('.grid-stack-item');
    const gsId = item && item.getAttribute('gs-id');
    const cfg = getTabsConfig(id, gsId !== id ? gsId : null);
    cfg.tabs.forEach((tb) => createTab(group, tb.url));
    group.active = Math.max(0, Math.min(group.tabs.length - 1, cfg.active));
    group.chromeHidden = !!cfg.chromeHidden;
    applyChromeHidden(group);   // reflect the persisted state without re-saving on every rebuild
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
    const tab = { tileId, group, canvas, ctx: null, meta: null, url: url || '', opened: false, streaming: false, loaded: false, launchRetries: 0, retryTimer: null, lastW: 0, lastH: 0, resizeTimer: null, resizeTries: 0, _touchId: null, _decoding: false, _pendingFrame: null };
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
    clearResizeWatchdog(tab);
    if (tab.opened) relaySend({ type: 'close', tile: tab.tileId });
    tabsById.delete(tab.tileId);
    if (tab.canvas && tab.canvas.parentNode) tab.canvas.parentNode.removeChild(tab.canvas);
    tab.canvas = null;   // makes decodeFrame's mid-flight teardown guard effective
    tab._pendingFrame = null;
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
    if (group.loadingEl) { group.loadingEl.hidden = true; group.loadingEl.classList.remove('is-error', 'is-paused'); }
    if (group.visible) {
      openActive(group);
      // Re-assert size for the tab we're switching to (it may have been resized while inactive).
      pushResize(group, false);
    } else if (next && !next.url) {
      showEmpty(group);
    } else if (group.onScreen) {
      applyGroupState(group);   // on screen but not streaming = paused: say so again
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
    // Touch pointers are forwarded as REAL touch events (CDP dispatchTouchEvent),
    // so the page scrolls natively under a finger — drag pans with fling inertia,
    // a tap becomes a click via Chromium's own gesture recognizer. Mouse pointers
    // keep the mouse path. Single-touch only: a second finger is ignored rather
    // than confusing the gesture recognizer with interleaved one-point streams.
    const sendTouch = (subtype, e) => {
      if (!tab.streaming) return;
      const pt = mapPointerToPage(e.clientX, e.clientY, canvas.getBoundingClientRect(), tab.meta, tab.lastW, tab.lastH);
      relaySend({ type: 'input', tile: tab.tileId, event: { kind: 'touch', subtype, x: pt.x, y: pt.y, modifiers: cdpModifiers(e) } });
    };
    canvas.addEventListener('pointerdown', (e) => {
      canvas.focus();
      canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
      if (e.pointerType === 'touch') {
        if (tab._touchId != null) return;         // secondary finger — ignore
        tab._touchId = e.pointerId;
        sendTouch('start', e);
      } else sendMouse('pressed', e);
      e.preventDefault();
    });
    canvas.addEventListener('pointerup', (e) => {
      if (e.pointerType === 'touch') {
        if (e.pointerId !== tab._touchId) return;
        tab._touchId = null;
        sendTouch('end', e);
      } else sendMouse('released', e);
    });
    canvas.addEventListener('pointercancel', (e) => {
      if (e.pointerType === 'touch' && e.pointerId === tab._touchId) {
        tab._touchId = null;
        sendTouch('cancel', e);
      }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!tab.streaming || group.moveQueued) return;     // throttle to one move per frame
      group.moveQueued = true;
      requestAnimationFrame(() => { group.moveQueued = false; });
      if (e.pointerType === 'touch') { if (e.pointerId === tab._touchId) sendTouch('move', e); }
      else sendMouse('moved', e);
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

  const {
    wireResize, observeVisibility, applyChromeHidden, setChromeHidden, toggleExpand, expand,
  } = window.BrowserTileView({ ICONS, applyGroupState, pushResize });

  // ── Scanning ──────────────────────────────────────────────────────────────────
  function scan() {
    if (typeof document === 'undefined') return;
    if (tileState.available === false) { showUnavailable(); return; }
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
        group.tabs.forEach((tab) => {
          if (tab.retryTimer) { clearTimeout(tab.retryTimer); tab.retryTimer = null; }
          clearResizeWatchdog(tab);
          if (tab.opened) relaySend({ type: 'close', tile: tab.tileId });
          tabsById.delete(tab.tileId);
        });
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

      const p = document.createElement('p');
      // Naming Edge off Windows was telling a Linux user to install a browser
      // this widget does not need: it drives ANY Chromium over the DevTools
      // protocol. The message now says what is actually required.
      p.textContent = window.XenonPlatform && window.XenonPlatform !== 'win32'
        ? t('browser_unavailable_chromium', 'The Browser widget needs a Chromium-based browser (Chromium, Chrome, Brave or Edge). None was found.')
        : t('browser_unavailable', 'Microsoft Edge isn’t installed: it’s required for the Browser widget.');
      div.appendChild(p);

      if (tileState.canInstallBrowser) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'browser-unavailable-install';
        btn.textContent = t('browser_install_chromium', 'Install Chromium');
        btn.addEventListener('click', () => {
          btn.disabled = true;
          btn.textContent = t('browser_installing', 'Installing…');
          fetch('/embedded-browser/install', { method: 'POST' })
            .then((r) => r.json())
            .then((d) => {
              if (d && d.ok) { probeAvailability(); return; }
              btn.disabled = false;
              btn.textContent = t('browser_install_failed', 'Installation did not finish: try again');
            })
            .catch(() => {
              btn.disabled = false;
              btn.textContent = t('browser_install_failed', 'Installation did not finish: try again');
            });
        });
        div.appendChild(btn);
      }

      mount.replaceChildren(div);
    });
  }

  function probeAvailability() {
    fetch('/embedded-browser/available').then((r) => r.json()).then((d) => {
      tileState.available = !!(d && d.available);
      tileState.canInstallBrowser = !!(d && d.canInstall);
      // The previous answer may still be painted, and it may now be wrong —
      // drop it so an install that just succeeded is not hidden behind the
      // "no browser found" card it replaced.
      document.querySelectorAll('.browser-unavailable').forEach((el) => el.remove());
      scan();
    }).catch(() => { tileState.available = true; scan(); });
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

  // Re-read state that another surface may have changed and reflect it on an
  // already-mounted group. A group reads its config only when it first mounts, so a
  // live settings sync (settings.js hydrate) would otherwise leave the toolbar — and
  // the shared favorites bar — out of step with the screen the change was made on
  // (same class as the weather/notes cross-surface bugs, GitHub #72). The favorites
  // list is global (hubSettings.browserFavorites) so a favorite added on one screen
  // is persisted and synced, but the OTHER screen's bar never re-rendered until the
  // tile remounted — re-render it here.
  //
  // We also adopt an address set on another surface, but ONLY for a tab that is
  // still empty here. A tab reads its URL only at mount, so a tile already open
  // when the address was set elsewhere (e.g. typed on the XENON) stayed blank —
  // openActive short-circuits on an empty url and never opens the stream, so the
  // page shows on the surface that set it and nowhere else (GitHub #72). Filling
  // only EMPTY tabs keeps the original guard intact: a tab that already has a live
  // page is never yanked out from under the user, and a URL *changed* elsewhere is
  // still left to that surface's own tile.
  function reconcileFromSettings() {
    groups.forEach((group, id) => {
      const cfg = getTabsConfig(id);
      if (!!cfg.chromeHidden !== !!group.chromeHidden) {
        group.chromeHidden = !!cfg.chromeHidden;
        applyChromeHidden(group);
        pushResize(group, false);   // same stage change as a local toggle (#116)
      }
      let adopted = false;
      for (let i = 0; i < group.tabs.length; i++) {
        const tab = group.tabs[i];
        const synced = cfg.tabs[i];
        if (tab && !tab.url && synced && synced.url) {
          tab.url = synced.url;
          adopted = true;
          if (activeTab(group) === tab && group.urlInput && document.activeElement !== group.urlInput) {
            group.urlInput.value = tab.url;
          }
        }
      }
      if (adopted) {
        renderTabStrip(group);              // labels follow the newly-adopted address
        if (group.visible) openActive(group); // open the now-addressed active tab live
      }
      renderFavorites(group);   // adopt favorites added/removed on another surface
    });
  }

  // ── SDK entry point ───────────────────────────────────────────────
  // An SDK widget granted the `browser` category asks the tile to show a page
  // through here. The widget never sees that page: it names an address and the
  // tile does the loading, exactly as `openUrl` hands one to the Windows shell.
  // Nothing about the widget sandbox changes — `frame-src 'none'` and
  // `connect-src 'none'` still stand, which is why this indirection exists at
  // all. It lives in this module because the tile owns the CDP relay, and the
  // relay must keep having exactly one caller.
  // The tile is a real Chromium with a persistent cookie jar, so a widget-named
  // navigation is network access — the one thing the SDK sandbox (connect-src
  // 'none' + the /sdk/fetch host allowlist) exists to withhold. A loopback or
  // LAN address is the dangerous half: a top-level navigation stamps
  // `Sec-Fetch-Site: none`, which the server's CSRF gate used to accept, so
  // `/notes?save=` and friends were reachable from a sandboxed widget. Mirrors
  // isForbiddenProxyHost/isPrivateNetworkHost in server/widget-sdk/proxy-request.js; the check is
  // repeated in custom-widget.js so the user is never prompted to approve an
  // address that would be refused here anyway.
  function sdkBlockedHost(host) {
    if (!host) return true;
    if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') return true;
    if (host === '[::1]' || host === '::1') return true;
    if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    if (host.endsWith('.local')) return true;
    return !host.includes('.');   // a bare name is an intranet host
  }

  // Bring a Browser tile into view when none is visible. Refusing made the feature useless
  // in a common layout: the widget asking and its Browser as two tabs of one tile can never
  // be visible together. A tile is still never navigated out of sight: the tile the widget
  // replaces is the one the user is then looking at.
  //
  // A perf/game-mode pause is left alone. That is a deliberate global stop with the
  // user in a game, and stealing the screen back for a widget is not a repair.
  function revealBrowserTile() {
    if (tileState.perfPaused) return null;
    const pager = typeof window !== 'undefined' ? window.DashboardPager : null;
    const candidates = [];
    groups.forEach((group) => {
      const section = group.section;
      if (!section || !section.isConnected) return;
      const onPage = (pager && typeof pager.isOnCurrentPage === 'function')
        ? pager.isOnCurrentPage(section) : true;
      candidates.push({ group, onPage });
    });
    const pick = pickRevealTarget(candidates);
    if (!pick) return null;
    if (!pick.onPage && pager && typeof pager.goToPage === 'function') {
      const page = pick.group.section.closest('.pager-page');
      const pageId = page && page.dataset ? page.dataset.page : '';
      if (pageId) pager.goToPage(pageId);
    }
    activateGroupTab(pick.group);
    return pick.group;
  }

  // Make this tile the active tab of its tab group, if it is in one. `fromUser` is
  // false: a manual pick locks the tab by disabling the media-driven auto-switch,
  // and a widget asking for a page is not the user changing that preference.
  function activateGroupTab(group) {
    const TG = typeof window !== 'undefined' ? window.DashboardTabGroups : null;
    if (!TG || typeof TG.setGroupActive !== 'function' || typeof TG.widgetGroupOf !== 'function') return;
    if (typeof getDashboardLayout !== 'function') return;
    let layout = null;
    try { layout = getDashboardLayout(); } catch (e) { return; }
    const map = layout && layout.groups;
    if (!map) return;
    const gid = TG.widgetGroupOf(map, group.id);
    if (!gid || !map[gid] || map[gid].active === group.id) return;
    TG.setGroupActive(gid, group.id, false);
  }

  function openFromSdk(rawUrl, opts) {
    // http(s) only. The relay refuses other schemes too ('blocked_scheme'), but
    // stopping a file:/javascript: address here means it never reaches Chromium.
    let parsed = null;
    try { parsed = new URL(String(rawUrl || '').trim()); } catch (e) { return { ok: false, error: 'bad_url' }; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, error: 'bad_url' };
    if (sdkBlockedHost(parsed.hostname.toLowerCase())) return { ok: false, error: 'blocked_host' };
    // A tile the user can actually see, first. When there is none, bring one into
    // view instead of refusing — never navigate one that stays out of sight.
    let target = null;
    groups.forEach((group) => { if (!target && group.visible) target = group; });
    // Only a tap moves the dashboard: a widget opening its page as it loads took the
    // user to the Browser tile's page at every start (Discord, Nov 2026).
    if (!target && opts && opts.reveal === false) return { ok: false, error: groups.size ? 'not_visible' : 'no_browser_tile' };
    if (!target) target = revealBrowserTile();
    if (!target) return { ok: false, error: 'no_browser_tile' };
    navigateActive(target, parsed.href);
    // Opt-in, and deliberately not silent: expand() paints the tile over the
    // whole dashboard, which on the Xeneon Edge is the whole screen. The user
    // granted "open pages in the Browser tile" and can leave with Escape or the
    // collapse button. Native fullscreen needs a user gesture and is allowed to
    // fail — the overlay alone already fills the surface.
    if (opts && opts.expand === true) expand(target);
    return { ok: true };
  }

  // Expose pure helpers for tests / debugging, plus restart()/reconcile for settings.js.
  window.BrowserTile = { mapPointerToPage, cdpModifiers, tabLabel, restart, reconcileFromSettings, openFromSdk, sdkBlockedHost, pickRevealTarget };
})();
