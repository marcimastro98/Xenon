// Topbar minimal mode — an alternative dashboard chrome (Settings → Dynamic Island).
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

  // Auto-hide: after AUTO_HIDE_MS with no rail interaction the two edge rails
  // tuck away (class is-auto-hidden), leaving the dashboard clean but keeping the
  // slim handle peeking so there's a visible arrow to reopen them; a tap on that
  // handle — or anywhere in the screen-edge strip — brings them back and restarts
  // the countdown. Opt-out via Settings → Dynamic Island (topbarRailsAutoHide=false),
  // which keeps them always on screen. Transient visual state only — it never
  // touches the persisted per-rail collapsed choice (topbarRails).
  const AUTO_HIDE_MS = 10000;
  let autoHideTimer = null;
  let railsHidden = false;
  let autoHideBound = false;
  // When a tap on the peeking handle only summons the auto-hidden rails, swallow
  // the handle's own click so it doesn't ALSO flip the persisted collapsed state
  // (which would re-hide the rail the very tap just revealed). Auto-disarmed so a
  // reveal via the edge strip (no handle click follows) can't suppress a later tap.
  let suppressHandleToggle = false;
  let suppressToggleTimer = null;

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

  // The reorderable island segments, in their default display order. A new id
  // must also be added to the canonical list in normalizeTopbarClock (client
  // settings.js AND its server.js twin) and labelled in TOPBAR_ISLAND_LABELS,
  // or it is dropped on the next settings save.
  const ISLAND_SEG_IDS = ['time', 'date', 'weather', 'vitals', 'dots', 'badges', 'claude'];

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
    const clockBadges = clock.querySelector('.clock-sdkbadges'); // SDK badge chips (js/sdk-badges.js)
    const clockClaude = clock.querySelector('.clock-claude'); // Claude Code marker (js/claude-widget.js)
    if (!clockFace || !clockMeta || !clockDate || !clockWeather) return null;
    els = {
      topbar, quickbar, clock, topActions, pagerDots,
      clockFace, clockMeta, statusDot, clockDate, metaSep, clockWeather, clockVitals, clockBadges, clockClaude,
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
      case 'badges': return els.clockBadges;
      case 'claude': return els.clockClaude;
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

  // Apply the user's segment visibility in BOTH chromes and its order onto the
  // flattened Minimal pill. Full keeps its classic two-row composition, but an
  // eye toggle still removes that contribution there too. The first VISIBLE
  // Minimal segment gets
  // `island-seg-lead` so it carries no left hairline divider (CSS :first-child
  // can't see flex order, and a segment display:none'd by the vitals feature must
  // not count as the lead). Idempotent — safe to call on every settings apply.
  function applyIslandLayout() {
    if (!els && !captureTopbarEls()) return;
    const items = readIslandItems();
    let leadDone = false;
    items.forEach((it, index) => {
      const el = islandSegEl(it && it.id);
      if (!el) return;
      const hidden = it.hidden === true;
      el.classList.toggle('topbar-item-hidden', hidden);
      if (!active || !ui || !ui.pill) {
        el.style.removeProperty('order');
        el.classList.remove('island-seg', 'island-seg-lead', 'island-seg-hidden');
        return;
      }
      el.classList.add('island-seg');
      el.style.order = String(index);
      el.classList.toggle('island-seg-hidden', hidden);
      const effectivelyHidden = hidden || el.hidden === true; // el.hidden: vitals off
      if (!effectivelyHidden && !leadDone) { el.classList.add('island-seg-lead'); leadDone = true; }
      else el.classList.remove('island-seg-lead');
    });
    // The middle dot is punctuation between date and weather, not an
    // independently configurable item. Never leave it floating when either
    // neighbour has been hidden in the Full bar.
    const itemById = new Map(items.map((item) => [item.id, item]));
    if (els.metaSep) {
      const hideSep = itemById.get('date')?.hidden === true || itemById.get('weather')?.hidden === true;
      els.metaSep.classList.toggle('topbar-item-hidden', hideSep);
    }
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
      // The preceding pointerdown already revealed auto-hidden rails; this click
      // must not then collapse them. One tap = reveal, no toggle.
      if (suppressHandleToggle) { suppressHandleToggle = false; return; }
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

  // ── Auto-hide (idle → slide off; edge touch → reveal) ────────────────────────
  function autoHideEnabled() {
    return (typeof hubSettings === 'undefined' || !hubSettings) || hubSettings.topbarRailsAutoHide !== false;
  }

  function clearAutoHideTimer() {
    if (autoHideTimer) { clearTimeout(autoHideTimer); autoHideTimer = null; }
  }

  function setRailsHidden(hidden) {
    if (!ui) return;
    railsHidden = hidden;
    ui.left.rail.classList.toggle('is-auto-hidden', hidden);
    ui.right.rail.classList.toggle('is-auto-hidden', hidden);
  }

  // Start (or restart) the idle countdown. No-op when disabled/inactive.
  function armAutoHide() {
    clearAutoHideTimer();
    if (!active || !autoHideEnabled()) return;
    autoHideTimer = setTimeout(() => { autoHideTimer = null; setRailsHidden(true); }, AUTO_HIDE_MS);
  }

  // A rail was touched (or summoned): reveal both and restart the countdown.
  function wakeRails() {
    if (railsHidden) {
      setRailsHidden(false);
      // This same gesture may land a click on the handle it woke — mark it so the
      // handle's click reveals only, without toggling the collapsed state. Clears
      // itself right after the click would fire, so it never leaks to a later tap.
      suppressHandleToggle = true;
      if (suppressToggleTimer) clearTimeout(suppressToggleTimer);
      suppressToggleTimer = setTimeout(() => { suppressHandleToggle = false; suppressToggleTimer = null; }, 400);
    }
    armAutoHide();
  }

  // Reveal the rails when the user touches within an edge strip (they've slid off
  // there). Capture phase so it fires even though the rail itself is off-screen.
  function onEdgePointerDown(e) {
    if (!active || !railsHidden) return;
    const w = window.innerWidth || document.documentElement.clientWidth || 0;
    if (!w) return;
    const zone = Math.max(28, w * 0.03);   // a touch-friendly edge strip, not a wide band
    const x = e.clientX;
    if (x <= zone || x >= w - zone) wakeRails();
  }

  // Bound once against the singleton rails + document; all handlers early-return
  // when inactive, so they stay inert (not removed) while the full bar is shown.
  function bindAutoHide() {
    if (autoHideBound || !ui) return;
    autoHideBound = true;
    document.addEventListener('pointerdown', onEdgePointerDown, true);
    [ui.left.rail, ui.right.rail].forEach((rail) => {
      rail.addEventListener('pointerdown', wakeRails, { passive: true });
      rail.addEventListener('pointermove', wakeRails, { passive: true });
    });
  }

  // Reconcile auto-hide with the current setting. Called on enable and on every
  // settings apply. Idempotent: an in-flight countdown is left running (only rail
  // interaction resets it), so a routine settings apply can't keep the rails up
  // forever by re-arming on each pass.
  function configureAutoHide() {
    if (!active) { clearAutoHideTimer(); return; }
    bindAutoHide();
    if (!autoHideEnabled()) { clearAutoHideTimer(); setRailsHidden(false); return; }
    if (!autoHideTimer && !railsHidden) armAutoHide();
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
    configureAutoHide();
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
    // clock-meta ← status-dot · date · sep · weather · vitals · badges
    // (fixed original order — must match index.html)
    [els.statusDot, els.clockDate, els.metaSep, els.clockWeather, els.clockVitals, els.clockBadges, els.clockClaude]
      .forEach(el => { if (el) els.clockMeta.appendChild(el); });
    els.clock.append(els.clockFace, els.clockMeta);
    // Topbar's original child order: quickbar · clock · top-actions, with the
    // pager dots back at the end of top-actions (their true home).
    els.topbar.append(els.quickbar, els.clock, els.topActions);
    els.topActions.appendChild(els.pagerDots);
    document.body.classList.remove('topbar-minimal');
    clearIslandTags();
    active = false;
    applyIslandLayout();
    // Stop the idle countdown and clear the transient hidden state, so switching
    // back to minimal later starts from fully-visible rails.
    clearAutoHideTimer();
    setRailsHidden(false);
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
      // Geometry is read ONCE, from a single rendered grid, and every tile is then
      // placed from its GridStack coords rather than its own DOM rect. Pager pages
      // sit side by side at the same size and vertical origin, so one measurement
      // answers for all of them. Two measured reasons, beyond being less work:
      //   - A rect read inside a parked page (.is-parked → content-visibility:
      //     hidden) forces Chromium to render the very subtree the parking exists
      //     to skip, which is the "Rendering was performed in a subtree hidden by
      //     content-visibility" console flood.
      //   - Interleaving per-tile reads with the --island-clear writes below
      //     invalidated layout between them, so each read re-ran it: the 35-56ms
      //     "Forced reflow while executing JavaScript" violations.
      // Grid coords stay correct for off-screen pages, so paging still never
      // reveals an overlap — that is why this must not simply skip parked pages.
      const grids = Array.from(document.querySelectorAll('.pager-page .grid-stack'));
      const ref = grids.find(g => !g.closest('.pager-page.is-parked')) || grids[0];
      if (!ref) { clearIslandTags(); return; }
      const g = ref.getBoundingClientRect();
      if (!g.height || !g.width) { clearIslandTags(); return; }
      const clearance = Math.max(0, Math.ceil(pill.bottom - g.top) + 12);
      if (!clearance) { clearIslandTags(); return; }
      // The pill is fixed to the viewport; express its span in page-local pixels so
      // the same test applies to pages scrolled off to either side.
      const cols = (window.DashboardGrid && window.DashboardGrid.GRID_COLUMNS) || 24;
      const colWidth = g.width / cols;
      const pillLeft = pill.left - g.left;
      const pillRight = pill.right - g.left;
      const want = new Map(); // item element -> clearance px string
      grids.forEach(grid => {
        grid.querySelectorAll(':scope > .grid-stack-item').forEach(item => {
          const n = item.gridstackNode;
          if (!n) return;                                // not mounted yet
          if ((n.y || 0) !== 0) return;                  // top row only
          const left = (n.x || 0) * colWidth;
          const right = left + (n.w || 0) * colWidth;
          // Must genuinely sit under the pill (≥12px horizontal overlap) — with
          // the fine 24-column grid more than one tile can straddle it.
          const overlap = Math.min(right, pillRight) - Math.max(left, pillLeft);
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
  // cover the tiles' move/resize handles (see TopbarMinimal.css).
  //
  // Two chromes, one enable path — the difference is only the island pill:
  //   'minimal'                      → edge rails + the clock island
  //   'none' (dashboardLayout.topbarHidden) → edge rails, NO island, no bar
  // "None" used to tear the rails down as well, which left the dashboard with no
  // reachable quick actions at all and made the floating Layout button the only
  // way back in. The rails ARE the chrome; only the island is what "none" drops.
  // body.topbar-noisland is what suppresses the pill (TopbarMinimal.css) and what
  // tells the island's other tenants — the SDK island and the toast morph — that
  // there is no capsule to take over.
  function apply() {
    if (document.body.dataset.panel) return;
    const settings = (typeof hubSettings !== 'undefined' && hubSettings) ? hubSettings : null;
    const barHidden = !!(settings && settings.dashboardLayout && settings.dashboardLayout.topbarHidden === true);
    const wantRails = !!(settings && (settings.topbarStyle === 'minimal' || barHidden));
    document.body.classList.toggle('topbar-noisland', wantRails && barHidden);
    if (wantRails) enable(); else disable();
    applyIslandLayout();
    // Pick up an auto-hide setting change even when already active (enable() would
    // have early-returned). Self-guards when inactive.
    configureAutoHide();
  }

  window.TopbarMinimal = { apply, reflowIsland, applyIslandLayout };
})();
