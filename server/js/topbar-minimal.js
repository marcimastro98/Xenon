// Topbar minimal mode — an alternative dashboard chrome (Settings → Aspetto).
// Instead of the full glass bar, the quick actions dock into two collapsible
// vertical rails hugging the screen edges (left: Lock/Focus/Xenon, right:
// Layout/Settings/App + favorites) and the clock/date/weather/page-dots merge
// into one compact "island" pill at top centre.
//
// The original topbar elements are REPARENTED, never cloned: every id, i18n
// hook and inline handler keeps working (clock ticks, weather chip, pager dots
// re-render, favorites refresh) no matter which chrome is active. Disabling
// puts each element back in its original slot. Embed views (?panel=…) keep
// their own compact bar and are never touched.
(function () {
  'use strict';

  // Rail collapsed state (true = closed) lives in the SERVER-synced hubSettings,
  // not browser-local storage: the Xeneon Edge kiosk must remember the choice
  // across launches and any WebView storage reset. Both sides default closed, so
  // the rails never open on their own — only a rail the user opened stays open.
  let active = false;
  let els = null;   // reparented topbar elements, captured once
  let ui = null;    // built-once minimal chrome: { pill, left, right }

  function readRailState() {
    const s = (typeof hubSettings !== 'undefined' && hubSettings && hubSettings.topbarRails) || null;
    // No stored value → both collapsed (closed), matching the settings default.
    return { left: !s || s.left !== false, right: !s || s.right !== false };
  }

  function writeRailState(state) {
    if (typeof hubSettings === 'undefined' || !hubSettings) return;
    const next = { left: !!state.left, right: !!state.right };
    if (typeof normalizeSettings === 'function') {
      hubSettings = normalizeSettings({ ...hubSettings, topbarRails: next });
    } else {
      hubSettings.topbarRails = next;
    }
    if (typeof saveHubSettings === 'function') saveHubSettings({ server: true });
  }

  // The five reorderable island segments, in their default display order.
  const ISLAND_SEG_IDS = ['time', 'date', 'weather', 'vitals', 'dots'];

  function captureTopbarEls() {
    if (els) return els;
    const topbar = document.querySelector('.topbar');
    const quickbar = document.getElementById('quickbar');
    const clock = topbar ? topbar.querySelector('.clock') : null;
    const topActions = topbar ? topbar.querySelector('.top-actions') : null;
    const pagerDots = document.getElementById('pager-dots');
    if (!topbar || !quickbar || !clock || !topActions || !pagerDots) return null;
    // Leaf segments flattened into the island pill so each can be reordered/hidden.
    const clockFace = clock.querySelector('.clock-face');
    const clockMeta = clock.querySelector('.clock-meta');
    const statusDot = clock.querySelector('.status-dot-inline');
    const clockDate = clock.querySelector('.clock-date');
    const metaSep = clock.querySelector('.clock-meta-sep');
    const clockWeather = clock.querySelector('.clock-weather');
    const clockVitals = clock.querySelector('.clock-vitals'); // optional (vitals opt-in)
    if (!clockFace || !clockMeta || !clockDate || !clockWeather) return null;
    els = {
      topbar, quickbar, clock, topActions, pagerDots,
      clockFace, clockMeta, statusDot, clockDate, metaSep, clockWeather, clockVitals,
    };
    return els;
  }

  // Map an island segment id to its element (vitals may be absent).
  function islandSegEl(id) {
    switch (id) {
      case 'time': return els.clockFace;
      case 'date': return els.clockDate;
      case 'weather': return els.clockWeather;
      case 'vitals': return els.clockVitals;
      case 'dots': return els.pagerDots;
      default: return null;
    }
  }

  // Read the configured island item list (order + hidden), defaulting to the
  // canonical order all-visible when settings aren't available yet.
  function readIslandItems() {
    const cfg = (typeof hubSettings !== 'undefined' && hubSettings && hubSettings.topbarClock) || null;
    if (cfg && Array.isArray(cfg.items) && cfg.items.length) return cfg.items;
    return ISLAND_SEG_IDS.map(id => ({ id, hidden: false }));
  }

  // Apply the user's segment order + visibility onto the flattened pill children.
  // Order is pure CSS `order`; visibility a class; the first VISIBLE segment gets
  // `island-seg-lead` so it carries no left hairline divider (CSS :first-child
  // can't see flex order, and a segment display:none'd by the vitals feature must
  // not count as the lead). Idempotent — safe to call on every settings apply.
  function applyIslandLayout() {
    if (!active || !ui || !ui.pill) return;
    const items = readIslandItems();
    let leadDone = false;
    items.forEach((it, index) => {
      const el = islandSegEl(it && it.id);
      if (!el) return;
      el.classList.add('island-seg');
      el.style.order = String(index);
      const hidden = it.hidden === true;
      el.classList.toggle('island-seg-hidden', hidden);
      const effectivelyHidden = hidden || el.hidden === true; // el.hidden: vitals off
      if (!effectivelyHidden && !leadDone) { el.classList.add('island-seg-lead'); leadDone = true; }
      else el.classList.remove('island-seg-lead');
    });
  }

  function buildRail(side) {
    const rail = document.createElement('div');
    rail.className = 'edge-rail edge-rail-' + side;
    const body = document.createElement('div');
    body.className = 'edge-rail-body';
    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'edge-rail-handle';
    handle.setAttribute('data-i18n-title', 'topbar_rail_toggle');
    handle.title = (typeof t === 'function') ? t('topbar_rail_toggle') : '';
    handle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    handle.addEventListener('click', () => {
      const state = readRailState();
      state[side] = !rail.classList.contains('is-collapsed');
      writeRailState(state);
      syncRail(rail, handle, state[side]);
    });
    rail.append(body, handle);
    return { rail, body, handle };
  }

  function syncRail(rail, handle, collapsed) {
    rail.classList.toggle('is-collapsed', collapsed);
    handle.setAttribute('aria-expanded', String(!collapsed));
  }

  function ensureUi() {
    if (ui) return ui;
    const pill = document.createElement('div');
    pill.id = 'topbar-mini';
    pill.className = 'topbar-mini';
    els.topbar.insertAdjacentElement('afterend', pill);
    const left = buildRail('left');
    const right = buildRail('right');
    document.body.append(left.rail, right.rail);
    const state = readRailState();
    syncRail(left.rail, left.handle, state.left);
    syncRail(right.rail, right.handle, state.right);
    ui = { pill, left, right };
    return ui;
  }

  function enable() {
    if (active || !captureTopbarEls()) return;
    ensureUi();
    ui.left.body.appendChild(els.quickbar);
    ui.right.body.appendChild(els.topActions);
    // Flatten the clock's leaf segments straight into the pill (the pill is the
    // flex row), so each can be reordered/hidden on its own. status-dot and the
    // middle separator aren't island segments — they stay inside the detached
    // clock-meta and are reunited on disable().
    ISLAND_SEG_IDS.forEach(id => {
      const el = islandSegEl(id);
      if (el) ui.pill.appendChild(el);
    });
    document.body.classList.add('topbar-minimal');
    active = true;
    applyIslandLayout();
  }

  function disable() {
    if (!active) return;
    // Strip the island layout styling off each segment, then rebuild the clock's
    // original nested structure exactly before restoring it to the topbar.
    ISLAND_SEG_IDS.forEach(id => {
      const el = islandSegEl(id);
      if (!el) return;
      el.style.removeProperty('order');
      el.classList.remove('island-seg', 'island-seg-lead', 'island-seg-hidden');
    });
    // clock-meta ← status-dot · date · sep · weather · vitals (fixed original order)
    [els.statusDot, els.clockDate, els.metaSep, els.clockWeather, els.clockVitals]
      .forEach(el => { if (el) els.clockMeta.appendChild(el); });
    els.clock.append(els.clockFace, els.clockMeta);
    // Topbar's original child order: quickbar · clock · top-actions, with the
    // pager dots back at the end of top-actions (their true home).
    els.topbar.append(els.quickbar, els.clock, els.topActions);
    els.topActions.appendChild(els.pagerDots);
    document.body.classList.remove('topbar-minimal');
    clearIslandTags();
    active = false;
  }

  function clearIslandTags() {
    document.querySelectorAll('.grid-stack-item.island-clear').forEach(item => {
      item.classList.remove('island-clear');
      item.style.removeProperty('--island-clear');
    });
  }

  // The grid keeps the full viewport height in minimal mode, so tiles can sit
  // level with the floating clock island. Every tile whose TOP ROW actually
  // intersects the pill's span gets its content inset down (--island-clear) so
  // its header clears the clock — tiles beside the pill keep the whole band.
  // Grid-local coords keep this correct for off-screen pages, so paging never
  // reveals an overlap. Called at the tail of fitGridHeights and from the grid
  // change/dragstop throttle, so the preview tracks live edits.
  function reflowIsland() {
    if (!active || !ui || !ui.pill) { clearIslandTags(); return; }
    try {
      const pill = ui.pill.getBoundingClientRect();
      if (!pill.height) { clearIslandTags(); return; }
      const want = new Map(); // item element -> clearance px string
      document.querySelectorAll('.pager-page .grid-stack').forEach(grid => {
        const g = grid.getBoundingClientRect();
        if (!g.height) return;
        const clearance = Math.max(0, Math.ceil(pill.bottom - g.top) + 12);
        if (!clearance) return;
        grid.querySelectorAll(':scope > .grid-stack-item').forEach(item => {
          const r = item.getBoundingClientRect();
          if (!r.height) return;
          if (r.top - g.top > 6) return;                 // top row only
          // Must genuinely sit under the pill (≥12px horizontal overlap) — with
          // the fine 24-column grid more than one tile can straddle it.
          const overlap = Math.min(r.right, pill.right) - Math.max(r.left, pill.left);
          if (overlap < 12) return;
          want.set(item, clearance + 'px');
        });
      });
      // Reconcile idempotently: fitGridHeights re-runs on every interaction, so
      // only touch tiles whose state actually changes — re-tagging an already
      // correct tile would restart layout work and make it bob on every touch.
      document.querySelectorAll('.grid-stack-item.island-clear').forEach(item => {
        if (!want.has(item)) {
          item.classList.remove('island-clear');
          item.style.removeProperty('--island-clear');
        }
      });
      want.forEach((clearance, item) => {
        if (item.style.getPropertyValue('--island-clear') !== clearance) {
          item.style.setProperty('--island-clear', clearance);
        }
        if (!item.classList.contains('island-clear')) item.classList.add('island-clear');
      });
    } catch (e) { /* never break the fit pass */ }
  }

  // Idempotent; safe to call from every settings/layout apply pass. The minimal
  // chrome reflects the user's choice in every state — including while editing
  // the layout, so the editor previews the bar you actually run: the grid keeps
  // its run-time position and the layout dock floats over the top instead of
  // pushing tiles down, and the edge rails are hidden while editing so they don't
  // cover the tiles' move/resize handles (see TopbarMinimal.css). Only "Nascondi
  // barra" (layout editor) overrides it: that hides the bar entirely.
  function apply() {
    if (document.body.dataset.panel) return;
    const settings = (typeof hubSettings !== 'undefined' && hubSettings) ? hubSettings : null;
    const barHidden = !!(settings && settings.dashboardLayout && settings.dashboardLayout.topbarHidden === true);
    const wantMinimal = !!(settings && settings.topbarStyle === 'minimal' && !barHidden);
    if (wantMinimal) enable(); else disable();
  }

  window.TopbarMinimal = { apply, reflowIsland, applyIslandLayout };
})();
