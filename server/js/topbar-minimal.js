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

  // Auto-hide: after the delay in autoHideMs() with no rail interaction the two edge rails
  // tuck away (class is-auto-hidden), leaving the dashboard clean but keeping the
  // slim handle peeking so there's a visible arrow to reopen them; a tap on that
  // handle — or anywhere in the screen-edge strip — brings them back and restarts
  // the countdown. Opt-out via Settings → Top bar (topbarRailsAutoHide=false),
  // which keeps them always on screen. Transient visual state only — it never
  // touches the persisted per-rail collapsed choice (topbarRails).
  // Settings → Top bar → Side rails sets it (topbarLook.railDelay, seconds).
  const AUTO_HIDE_DEFAULT_S = 10;
  function autoHideMs() {
    const look = typeof hubSettings !== 'undefined' && hubSettings ? hubSettings.topbarLook : null;
    const s = look && Number.isFinite(look.railDelay) ? look.railDelay : AUTO_HIDE_DEFAULT_S;
    return s * 1000;
  }
  let autoHideTimer = null;
  let railsHeld = false;   // Settings → Top bar is open: the rails stay out (js/settings-bar-preview.js)
  // Per side, because a touch only ever means ONE side. A rail that is tucked away
  // because it was collapsed and one tucked away by the idle timer are drawn
  // identically (the 22px handle), so a touch that woke BOTH of them slid open
  // whichever side the user had left open, whichever handle they had tapped:
  // "I tap the right one and the left one opens, and the other way round".
  const railsHidden = { left: false, right: false };
  let autoHideBound = false;
  // When a tap on a peeking handle only summons a rail that is OPEN but tucked
  // away, swallow the handle's own click so it doesn't ALSO flip the persisted
  // collapsed state (which would re-hide the rail the very tap just revealed). A
  // rail that is COLLAPSED gets no such shield: revealing it changes nothing on
  // screen, so the tap has to be the one that opens it. Per side, and auto-disarmed
  // so a reveal via the edge strip (no handle click follows) can't suppress a
  // later tap.
  const suppressHandleToggle = { left: false, right: false };
  const suppressToggleTimer = { left: null, right: null };

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
  const ISLAND_SEG_IDS = ['time', 'date', 'weather', 'media', 'vitals', 'dots', 'badges', 'claude', 'codex', 'perf'];

  // The chrome BUTTONS, keyed the same way and carried by the same settings
  // object (topbarClock.actions). Selector per id, resolved against the whole
  // document rather than a container, because a button that has been moved to the
  // other side is no longer where its markup put it. Unlike the island segments
  // these are NOT required: an id whose element is missing is skipped, and must
  // never fail the capture — captureTopbarEls returning null disables Minimal
  // entirely, which is far too big a consequence for one absent button.
  const ACTION_SELECTORS = {
    lock: '.qbtn-lock',
    ambient: '#ambient-topbtn',
    xenon: '.topbtn-xenon',
    search: '.qbtn-search',
    mail: '#bit-mail-btn',
    mini: '#topbar-mini-slot',
    layout: '#layout-edit-toggle',
    settings: '.qbtn-settings',
    apps: '.qbtn-apps',
    favorites: '#app-favorites',
  };
  const ACTION_IDS = Object.keys(ACTION_SELECTORS);

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
    const clockMedia = clock.querySelector('.clock-media'); // now playing (js/topbar-media.js)
    const clockVitals = clock.querySelector('.clock-vitals'); // optional (vitals opt-in)
    const clockBadges = clock.querySelector('.clock-sdkbadges'); // SDK badge chips (js/sdk-badges.js)
    const clockClaude = clock.querySelector('.clock-claude'); // Claude Code marker (js/claude-widget.js)
    const clockCodex = clock.querySelector('.clock-codex'); // OpenAI Codex marker (js/codex-widget.js)
    const clockPerf = clock.querySelector('.clock-perf'); // Performance Mode marker (js/perf-marker.js)
    if (!clockFace || !clockMeta || !clockDate || !clockWeather) return null;
    els = {
      topbar, quickbar, clock, topActions, pagerDots,
      clockFace, clockMeta, statusDot, clockDate, metaSep, clockWeather, clockMedia, clockVitals, clockBadges, clockClaude, clockCodex, clockPerf,
    };
    return els;
  }

  // Map an island segment id to its element (vitals may be absent).
  function islandSegEl(id) {
    switch (id) {
      case 'time': return els.clockFace;
      case 'date': return els.clockDate;
      case 'weather': return els.clockWeather;
      case 'media': return els.clockMedia;
      case 'vitals': return els.clockVitals;
      case 'dots': return els.pagerDots;
      case 'badges': return els.clockBadges;
      case 'claude': return els.clockClaude;
      case 'codex': return els.clockCodex;
      case 'perf': return els.clockPerf;
      default: return null;
    }
  }

  // Element for a chrome-button id, or null when that button is not in this
  // document (embed views, a future build, a phone). Looked up live: the button
  // may have been moved into the other container.
  // A widget's own button (`sdk:<pkg>`, js/sdk-topbar-button.js) is found by
  // its data-tb-id.
  const SDK_ACTION_RE = /^sdk:[a-z0-9][a-z0-9-]{1,40}$/;
  function actionEl(id) {
    const sel = ACTION_SELECTORS[id];
    if (sel) return document.querySelector(sel);
    return typeof id === 'string' && SDK_ACTION_RE.test(id) ? document.querySelector('[data-tb-id="' + id + '"]') : null;
  }

  // Read the configured button list. Absent settings mean "canonical order, all
  // visible", which matches the settings default — including the SDK mini slot,
  // which is empty rather than hidden until a package draws in it.
  function readActionItems() {
    const cfg = (typeof hubSettings !== 'undefined' && hubSettings && hubSettings.topbarClock) || null;
    if (cfg && Array.isArray(cfg.actions) && cfg.actions.length) return cfg.actions;
    return ACTION_IDS.map(id => ({
      id,
      hidden: false,
      side: (id === 'layout' || id === 'settings' || id === 'apps' || id === 'favorites') ? 'right' : 'left',
    }));
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
    // Music takeover (Settings → Dynamic Island → Musica → "occupa tutta
    // l'isola"): while a track is actually PLAYING, the player gets the whole
    // capsule and every other segment is masked off. It ends the moment playback
    // pauses, stops or the player closes, and the bar's normal contents come
    // straight back. This is an effective-off mask, never a write: the user's own
    // show/hide choices are untouched throughout (same shape as the safe-mode
    // masks in js/custom-widget.js). A media segment the user hid stays hidden
    // and never takes anything over.
    const mediaItem = items.find((it) => it && it.id === 'media');
    // …except on a phone, where the media segment is not on screen to receive
    // it: the compact bar hides it because a now-playing strip does not fit
    // beside a clock at 390px, and the same track is one tile away. Left
    // unguarded the mask still ran, so a phone with music playing showed a
    // topbar with EVERY segment masked for a beneficiary that was display:none
    // — measured at 390px, the whole clock area collapsed to the 6px status dot
    // and the time, the weather and the date simply vanished while a song was
    // on. A mask with no beneficiary is not a takeover, it is an empty bar.
    const phone = !!(window.PhoneView && typeof PhoneView.mode === 'function' && PhoneView.mode() === 'phone');
    const musicOnly = !!(mediaItem && mediaItem.hidden !== true && !phone
      && window.TopbarMedia && typeof TopbarMedia.takingOver === 'function' && TopbarMedia.takingOver());
    let leadDone = false;
    items.forEach((it, index) => {
      const el = islandSegEl(it && it.id);
      if (!el) return;
      const hidden = it.hidden === true || (musicOnly && it.id !== 'media');
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
      const hideSep = musicOnly
        || itemById.get('date')?.hidden === true
        || itemById.get('weather')?.hidden === true;
      els.metaSep.classList.toggle('topbar-item-hidden', hideSep);
    }
    // The clock is a two-row column (face over meta) centred as ONE block, so a
    // meta row holding nothing but the 6px status dot still pushes the time up —
    // measured at 5.5px off the bar's centre with date, weather and music hidden,
    // which is exactly the "the clock isn't centred" report. The dot is the
    // online indicator and has to stay, so instead the bare row stops taking a
    // row of its own (CSS below) and the face centres on the bar.
    if (els.clock) {
      const metaAlive = [els.clockDate, els.clockWeather, els.clockMedia, els.clockVitals, els.clockBadges, els.clockClaude, els.clockCodex, els.clockPerf]
        .some((el) => el && el.hidden !== true && !el.classList.contains('topbar-item-hidden'));
      els.clock.classList.toggle('clock-meta-bare', !metaAlive);
    }
    applyActionLayout();
  }

  // The chrome buttons: hide, order, and which side they live on. Runs inside
  // applyIslandLayout so there is ONE place that decides where a piece of the
  // chrome is — enable()/disable() move the two containers wholesale and never
  // reorder their children, so a side chosen here survives a chrome switch and
  // nothing else may quietly disagree with it.
  //
  // `.topbar-item-hidden` (Topbar.css) is the same mechanism the island segments
  // use and already works in both chromes, so hiding needs no new CSS. Ordering
  // is `style.order`, which holds in all four combinations: quickbar and
  // .top-actions are flex rows in Full, and both rails are flex columns in
  // Minimal. Moving sides is an appendChild into the other container, which is
  // why "left" means the same thing in each chrome: the quickbar BECOMES the left
  // rail and .top-actions the right one.
  function applyActionLayout() {
    if (!els) return;
    const hosts = { left: els.quickbar, right: els.topActions };
    if (!hosts.left || !hosts.right) return;
    const items = readActionItems();
    items.forEach((it, index) => {
      const el = actionEl(it && it.id);
      if (!el) return;   // absent button: skip it, never fail the whole pass
      el.classList.toggle('topbar-item-hidden', it.hidden === true);
      const host = hosts[it.side === 'right' ? 'right' : 'left'];
      if (host && el.parentElement !== host) host.appendChild(el);
      el.style.order = String(index);
    });
    // A widget button the user has not placed yet goes at the end of the left
    // side; placing it in Settings saves it into the list above.
    let next = items.length;
    for (const el of document.querySelectorAll('.topbtn-sdk[data-tb-id]')) {
      const id = el.getAttribute('data-tb-id');
      if (items.some((it) => it && it.id === id)) continue;
      el.classList.remove('topbar-item-hidden');
      if (el.parentElement !== hosts.left) hosts.left.appendChild(el);
      el.style.order = String(next++);
    }
    // The page dots are the one thing sharing .top-actions that is NOT a button:
    // they are an island segment whose native home happens to be this container.
    // Ordering the buttons gives every one of them an `order`, and an unordered
    // sibling defaults to 0 — which would silently move the dots to the FRONT of
    // the row the moment this feature shipped. In Full they belong last, exactly
    // where the markup puts them; in Minimal they live in the pill and the island
    // layout owns their order, so leave them alone there.
    if (els.pagerDots && !active) els.pagerDots.style.order = String(next);
  }

  // ── Island morph ────────────────────────────────────────────────────────────
  // A change that swaps WHICH segments the capsule holds — today only the music
  // takeover starting or ending on play/pause — is a structural change, and doing
  // it plainly is a hard cut: half the pill's contents vanish or appear at once
  // and the capsule snaps between two widths in a single frame.
  //
  // This is the same trick a real Dynamic Island uses. The pill's CONTENTS fade
  // out, the swap happens while nothing is visible, and the BOX glides from its
  // old size to its new one (measured before and after, then transitioned — the
  // capsule sizes itself to its content, so there is no width to animate without
  // pinning one for the duration) while the new contents fade back in. What the
  // eye follows is one shape changing, not two layouts trading places.
  //
  // Deliberately NOT wired into applyIslandLayout itself: that runs on every
  // settings apply and must stay synchronous and idempotent. Callers ask for the
  // morph when they know they are making a structural change.
  const MORPH_DIM_MS = 110;   // contents fade out; must match TopbarMinimal.css
  const MORPH_BOX_MS = 340;   // box glides; must match TopbarMinimal.css
  let morphOutTimer = 0;
  let morphEndTimer = 0;

  function morphIsland(mutate) {
    const pill = ui && ui.pill;
    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!active || !pill || !document.body.classList.contains('topbar-minimal') || reduced) {
      mutate();
      return;
    }
    clearTimeout(morphOutTimer);
    clearTimeout(morphEndTimer);
    // Opacity does not affect layout, so the "before" box can be measured with
    // the fade already running.
    pill.classList.add('mini-morph-dim');
    const from = pill.getBoundingClientRect();
    morphOutTimer = setTimeout(() => {
      mutate();
      const to = pill.getBoundingClientRect();
      // Nothing actually resized (e.g. the takeover is switched off, so a
      // play/pause only changed a glyph) — don't animate a box that isn't moving.
      if (Math.abs(to.width - from.width) < 2 && Math.abs(to.height - from.height) < 2) {
        // A morph cut short by this one never ran its own cleanup (its end timer was
        // cleared above): hand the capsule back to content sizing here too.
        pill.classList.remove('mini-morph-dim', 'mini-morphing');
        pill.style.removeProperty('width');
        pill.style.removeProperty('height');
        reflowIsland();
        return;
      }
      pill.classList.add('mini-morphing');
      pill.style.width = from.width + 'px';
      pill.style.height = from.height + 'px';
      void pill.offsetWidth; // commit the old box as the transition's start
      pill.classList.remove('mini-morph-dim'); // fade back in as the box travels
      pill.style.width = to.width + 'px';
      pill.style.height = to.height + 'px';
      morphEndTimer = setTimeout(() => {
        // Hand the capsule back to its own content sizing; an inline width left
        // behind would freeze it at whatever the track was called at the time.
        pill.classList.remove('mini-morphing');
        pill.style.removeProperty('width');
        pill.style.removeProperty('height');
        reflowIsland();
      }, MORPH_BOX_MS);
    }, MORPH_DIM_MS);
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
      // The preceding pointerdown already revealed an auto-hidden OPEN rail; this
      // click must not then collapse it. One tap = reveal, no toggle.
      if (suppressHandleToggle[side]) { suppressHandleToggle[side] = false; return; }
      // The rails on screen are the truth for both sides. The stored copy can lag
      // (it is synced between screens), and writing back a stale value for the
      // OTHER side would quietly flip it on the next launch.
      const state = ui
        ? { left: ui.left.rail.classList.contains('is-collapsed'), right: ui.right.rail.classList.contains('is-collapsed') }
        : readRailState();
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
    // Every size change of the pill moves the cutouts it makes in the tiles.
    if (typeof ResizeObserver === 'function') new ResizeObserver(scheduleReflow).observe(pill);
    // A ResizeObserver never sees a transform. The pill recedes and returns by
    // transform alone (notification, Spotlight bulge), so measure again once that
    // settles: a pass that ran while it was scaled down left the cutout too small.
    const settle = (e) => { if (e.target === pill) scheduleReflow(); };
    pill.addEventListener('transitionend', settle);
    pill.addEventListener('animationend', settle);
    return ui;
  }

  // ── Auto-hide (idle → slide off; edge touch → reveal) ────────────────────────
  function autoHideEnabled() {
    return (typeof hubSettings === 'undefined' || !hubSettings) || hubSettings.topbarRailsAutoHide !== false;
  }

  function clearAutoHideTimer() {
    if (autoHideTimer) { clearTimeout(autoHideTimer); autoHideTimer = null; }
  }

  // One side, or both when `side` is left out (the idle timer hides both).
  function setRailsHidden(hidden, side) {
    if (!ui) return;
    (side ? [side] : ['left', 'right']).forEach((sd) => {
      railsHidden[sd] = hidden;
      ui[sd].rail.classList.toggle('is-auto-hidden', hidden);
    });
  }

  // Start (or restart) the idle countdown. No-op when disabled/inactive.
  function armAutoHide() {
    clearAutoHideTimer();
    if (!active || !autoHideEnabled() || railsHeld) return;
    autoHideTimer = setTimeout(() => { autoHideTimer = null; setRailsHidden(true); }, autoHideMs());
  }

  // A rail was touched (or summoned): reveal THAT side and restart the countdown.
  // The other side is left as it was, so a touch on one edge can never open the bar
  // on the opposite one.
  function wakeRail(side) {
    if (railsHidden[side]) {
      setRailsHidden(false, side);
      // This same gesture may land a click on the handle it woke. When the rail is
      // open, that click reveals only: it must not toggle the collapsed state. When
      // it is collapsed the click is what opens it (see the note at the top).
      // Clears itself right after the click would fire, so it never leaks to a
      // later tap.
      suppressHandleToggle[side] = !!ui && !ui[side].rail.classList.contains('is-collapsed');
      if (suppressToggleTimer[side]) clearTimeout(suppressToggleTimer[side]);
      suppressToggleTimer[side] = setTimeout(() => { suppressHandleToggle[side] = false; suppressToggleTimer[side] = null; }, 400);
    }
    armAutoHide();
  }

  // Reveal the rails when the user touches within an edge strip (they've slid off
  // there). Capture phase so it fires even though the rail itself is off-screen.
  function onEdgePointerDown(e) {
    if (!active || !(railsHidden.left || railsHidden.right)) return;
    const w = window.innerWidth || document.documentElement.clientWidth || 0;
    if (!w) return;
    const zone = Math.max(28, w * 0.03);   // a touch-friendly edge strip, not a wide band
    const x = e.clientX;
    if (x <= zone) wakeRail('left');
    else if (x >= w - zone) wakeRail('right');
  }

  // Bound once against the singleton rails + document; all handlers early-return
  // when inactive, so they stay inert (not removed) while the full bar is shown.
  function bindAutoHide() {
    if (autoHideBound || !ui) return;
    autoHideBound = true;
    document.addEventListener('pointerdown', onEdgePointerDown, true);
    ['left', 'right'].forEach((side) => {
      const rail = ui[side].rail;
      rail.addEventListener('pointerdown', () => wakeRail(side), { passive: true });
      rail.addEventListener('pointermove', () => wakeRail(side), { passive: true });
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
    if (!autoHideTimer && !railsHidden.left && !railsHidden.right) armAutoHide();
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
    // clock-meta ← status-dot · date · sep · weather · media · vitals · badges · claude · codex · perf
    // (fixed original order — must match index.html)
    [els.statusDot, els.clockDate, els.metaSep, els.clockWeather, els.clockMedia, els.clockVitals, els.clockBadges, els.clockClaude, els.clockCodex, els.clockPerf]
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

  // ── Island notch ─────────────────────────────────────────────────────────
  // A tile under the island keeps its full height and gets a cutout around the
  // pill (js/island-notch.js has the shape). Three things per tile:
  //   --island-clear  the old whole-content inset, still used while EDITING, where
  //                   the edit bar and handles sit at the tile top;
  //   --island-inset  how far the content starts below the tile top (run mode);
  //   --island-notch  the clip, plus an <svg> hairline along the cutout.
  // A cutout grows out of, and shrinks back into, its own centre, so the tile
  // opens and closes around the island instead of popping.
  const NOTCH_MS = 360;             // must match the transitions in TopbarMinimal.css
  const notchState = new WeakMap(); // item -> { geo, line, key, leaving }

  function notchEdge(item) {
    let svg = item.querySelector(':scope > .island-notch-edge');
    if (!svg) {
      const ns = 'http://www.w3.org/2000/svg';
      svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('class', 'island-notch-edge');
      svg.setAttribute('aria-hidden', 'true');
      svg.appendChild(document.createElementNS(ns, 'path'));
      item.appendChild(svg);
    }
    return svg.firstChild;
  }

  function drawNotch(item, geo, line) {
    const N = window.IslandNotch;
    item.style.setProperty('--island-notch', N.clipPath(geo));
    item.style.setProperty('--island-notch-surface', N.surfaceClipPath(geo));
    const d = N.edgePath(geo, line.width);
    const path = notchEdge(item);
    // CSS `d` animates together with the clip where supported; the attribute is
    // the fallback for engines without it (WebKit), which then simply snap.
    path.setAttribute('d', d);
    path.style.setProperty('d', 'path("' + d + '")');
    path.setAttribute('stroke', line.color);
    path.setAttribute('stroke-width', String(line.width));
  }

  function dropNotch(item) {
    const st = notchState.get(item);
    if (st && st.leaving) clearTimeout(st.leaving);
    notchState.delete(item);
    item.classList.remove('island-clear');
    ['--island-clear', '--island-inset', '--island-notch', '--island-notch-surface', '--island-notch-ms'].forEach(p => item.style.removeProperty(p));
    const svg = item.querySelector(':scope > .island-notch-edge');
    if (svg) svg.remove();
  }

  function motionOk() {
    return !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  // Close a cutout into its centre, then take the tags off once it has.
  function releaseNotch(item) {
    const st = notchState.get(item);
    if (!st || !st.geo || !motionOk() || document.body.classList.contains('layout-editing')) { dropNotch(item); return; }
    if (st.leaving) return;
    st.leaving = setTimeout(() => { if (notchState.get(item) === st) dropNotch(item); }, NOTCH_MS);
    st.key = '';
    item.style.setProperty('--island-notch-ms', NOTCH_MS + 'ms'); // closes on its own clock while the box follows
    item.style.setProperty('--island-inset', st.line.width + 'px');
    drawNotch(item, window.IslandNotch.collapsed(st.geo), st.line);
  }

  function clearIslandTags() {
    document.querySelectorAll('.grid-stack-item.island-clear').forEach(dropNotch);
  }

  // The pill changes size on its own (a badge appears, the clock gains a
  // segment, a notification morphs it): follow it, one pass per frame.
  let notchFrame = 0;
  function scheduleReflow() {
    if (notchFrame) return;
    notchFrame = requestAnimationFrame(() => { notchFrame = 0; reflowIsland(); });
  }

  // An SDK line changing length resizes the capsule, and with it the cutout.
  let watchedTenant = null;
  function watchTenant(el) {
    if (watchedTenant === el || typeof ResizeObserver !== 'function') return;
    watchedTenant = el;
    new ResizeObserver(scheduleReflow).observe(el);
  }

  const boxOf = (r, radius) => ({
    left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height,
    // A pill's radius is far past half its height; clamp it so it can be animated.
    radius: Math.min(Number.isFinite(radius) ? radius : 0, r.height / 2),
  });

  // Where the island lives, in viewport px: the SDK capsule when a widget has
  // taken it, else the pill. The cutouts wrap this box only: a notification
  // (js/toast-island.js) grows out of it and floats OVER the tiles for its few
  // seconds, so the tiles never change shape for one. The capsule is placed from
  // its layout size and anchor, so it is never read mid-transform. The pill IS
  // mid-transform while it returns from receding (a scale), so then its last box
  // at rest stands in until it has settled. A notification grows out of and back
  // into this box; `kind` tells it whether there is a pill to dim first.
  let restBox = null;
  function homeBox() {
    if (!active || !ui) return null;
    const body = document.body;
    const cap = body.classList.contains('xisland-live') ? document.querySelector('.sdk-island') : null;
    if (cap && cap.offsetWidth) {
      watchTenant(cap);
      const w = cap.offsetWidth, h = cap.offsetHeight;
      const top = parseFloat(getComputedStyle(cap).top) || 0;
      const align = body.dataset.topbarAlign;
      const left = align === 'left' ? 12 : align === 'right' ? window.innerWidth - 12 - w : (window.innerWidth - w) / 2;
      return { ...boxOf({ left, right: left + w, top, bottom: top + h, height: h }, parseFloat(getComputedStyle(cap).borderTopLeftRadius)), kind: 'sdk' };
    }
    const cs = getComputedStyle(ui.pill);
    let scaled = false;
    try { scaled = cs.transform !== 'none' && Math.abs(new DOMMatrixReadOnly(cs.transform).a - 1) > 0.001; } catch { /* unparsable: treat as at rest */ }
    if (scaled && restBox) return { ...restBox, kind: 'pill' };
    const box = boxOf(ui.pill.getBoundingClientRect(), parseFloat(cs.borderTopLeftRadius));
    if (!scaled) restBox = box;
    return { ...box, kind: 'pill' };
  }

  // ── Following a change of tenant ─────────────────────────────────────────────
  // An SDK line takes the island's spot and gives it back: the cutouts must
  // change shape with it. Tiles are redrawn every frame meanwhile
  // (body.island-following turns their own transitions off; a tile that is
  // leaving keeps its own, see releaseNotch). The capsule jumps, so the box is
  // moved toward it on a critically damped spring: it starts and stops softly,
  // never overshoots, and keeps its momentum mid-flight.
  const FOLLOW_OMEGA = 18;    // 1/s, settles in about 0.3s
  const FOLLOW_HOLD_MS = 600; // the pill takes ~0.35s to come back; measure after it
  const BOX_KEYS = ['left', 'right', 'bottom', 'height', 'radius'];
  const follow = { raf: 0, last: 0, until: 0, pos: null, vel: null };

  function followStop() {
    follow.pos = follow.vel = null;
    document.body.classList.remove('island-following');
  }

  function followStep(now) {
    follow.raf = 0;
    if (!active || !ui || !follow.pos) { followStop(); return; }
    const dt = Math.min(0.05, Math.max(0.001, (now - follow.last) / 1000));
    follow.last = now;
    const target = homeBox();
    if (!target) { followStop(); return; }
    const e = Math.exp(-FOLLOW_OMEGA * dt);
    let moving = false;
    BOX_KEYS.forEach((k) => {
      const d = follow.pos[k] - target[k];
      const t = (follow.vel[k] + FOLLOW_OMEGA * d) * dt;
      follow.pos[k] = target[k] + (d + t) * e;
      follow.vel[k] = (follow.vel[k] - FOLLOW_OMEGA * t) * e;
      if (Math.abs(follow.pos[k] - target[k]) > 0.25 || Math.abs(follow.vel[k]) > 2) moving = true;
    });
    if (moving || now < follow.until) {
      reflowIsland();
      follow.raf = requestAnimationFrame(followStep);
      return;
    }
    followStop();
    reflowIsland(); // the real box, with the tiles' own transitions back on
  }

  // Call when the island's tenant changes. No-op without motion or a known
  // starting box: the plain reflow then does the job.
  function followIsland() {
    if (!active || !ui) return;
    const start = follow.pos || restBox;
    if (!motionOk() || document.body.classList.contains('layout-editing') || !start) { reflowIsland(); return; }
    follow.until = performance.now() + FOLLOW_HOLD_MS;
    if (!follow.pos) {
      follow.pos = { ...start };
      follow.vel = { left: 0, right: 0, bottom: 0, height: 0, radius: 0 };
      follow.last = performance.now();
      document.body.classList.add('island-following');
    }
    if (!follow.raf) follow.raf = requestAnimationFrame(followStep);
  }

  // The grid keeps the full viewport height in minimal mode, so tiles can sit
  // level with the floating clock island. Every tile whose TOP ROW actually
  // intersects the pill gets the notch above. Grid-local coords keep this
  // correct for off-screen pages, so paging never reveals an overlap. Called at
  // the tail of fitGridHeights, from the grid change/dragstop throttle and on
  // every pill resize.
  function reflowIsland() {
    if (!active || !ui || !ui.pill || !window.IslandNotch) { clearIslandTags(); return; }
    try {
      const pill = follow.pos || homeBox();
      if (!pill || !pill.height) { clearIslandTags(); return; }
      // Geometry is read ONCE, from a single rendered grid, and every tile is then
      // placed from its GridStack coords rather than its own DOM rect. Pager pages
      // sit side by side at the same size and vertical origin, so one measurement
      // answers for all of them. Two measured reasons, beyond being less work:
      //   - A rect read inside a parked page (.is-parked -> content-visibility:
      //     hidden) forces Chromium to render the very subtree the parking exists
      //     to skip, which is the "Rendering was performed in a subtree hidden by
      //     content-visibility" console flood.
      //   - Interleaving per-tile reads with the writes below invalidated layout
      //     between them, so each read re-ran it: the 35-56ms "Forced reflow while
      //     executing JavaScript" violations. Every read happens before any write.
      const grids = Array.from(document.querySelectorAll('.pager-page .grid-stack'));
      const ref = grids.find(g => !g.closest('.pager-page.is-parked')) || grids[0];
      if (!ref) { clearIslandTags(); return; }
      const g = ref.getBoundingClientRect();
      if (!g.height || !g.width) { clearIslandTags(); return; }
      const clearance = Math.max(0, Math.ceil(pill.bottom - g.top) + 12);
      if (!clearance) { clearIslandTags(); return; }
      const cols = (window.DashboardGrid && window.DashboardGrid.GRID_COLUMNS) || 24;
      const colWidth = g.width / cols;
      const N = window.IslandNotch;
      let margin = null;
      const want = new Map(); // item -> { geo, line, inset }
      grids.forEach(grid => {
        grid.querySelectorAll(':scope > .grid-stack-item').forEach(item => {
          const n = item.gridstackNode;
          if (!n || (n.y || 0) !== 0) return;            // mounted, top row only
          const content = item.querySelector(':scope > .grid-stack-item-content');
          const surface = content && content.querySelector(':scope > .panel, :scope > .dashboard-widget');
          if (!surface) return;
          // GridStack's gutter is the same on every tile: read it once.
          if (margin === null) margin = parseFloat(getComputedStyle(content).left) || 0;
          const left = (n.x || 0) * colWidth;
          const cs = getComputedStyle(surface);
          const tile = { width: (n.w || 0) * colWidth, margin, radius: parseFloat(cs.borderTopLeftRadius) || 0 };
          const local = (b) => ({ left: b.left - g.left - left, right: b.right - g.left - left, bottom: b.bottom - g.top, height: b.height, radius: b.radius });
          const geo = N.geometry({ ...tile, pill: local(pill) });
          if (!geo) return;
          const width = Math.max(1, parseFloat(cs.borderLeftWidth) || 1);
          want.set(item, { geo, line: { width, color: cs.borderLeftColor }, inset: geo.inset });
        });
      });
      // Writes. Reconcile idempotently: fitGridHeights re-runs on every
      // interaction, so a tile whose cutout has not changed is not touched.
      document.querySelectorAll('.grid-stack-item.island-clear').forEach(item => {
        if (!want.has(item)) releaseNotch(item);
      });
      const animate = motionOk();
      // While a notification is out the pill is hidden, so a cut around it would
      // wrap nothing: it closes into its centre and the tiles are whole again
      // (body.xtoast-fold, js/toast.js; it lifts as the card heads home). The inset
      // stays, so their content does not move for a notification.
      const folded = document.body.classList.contains('xtoast-fold') && !document.body.classList.contains('layout-editing');
      want.forEach(({ geo, line, inset }, item) => {
        const prev = notchState.get(item);
        const shape = folded ? N.collapsed(geo) : geo;
        const key = N.clipPath(shape) + '|' + inset + '|' + line.width + '|' + line.color + '|' + clearance;
        if (prev && !prev.leaving && prev.key === key && item.classList.contains('island-clear')) return;
        if (prev && prev.leaving) { clearTimeout(prev.leaving); prev.leaving = 0; }
        const fresh = !prev || !item.classList.contains('island-clear');
        item.style.removeProperty('--island-notch-ms');
        item.style.setProperty('--island-clear', clearance + 'px');
        item.style.setProperty('--island-inset', inset + 'px');
        notchState.set(item, { geo, line, key, leaving: 0 });
        item.classList.add('island-clear');
        if (fresh && animate && !follow.pos && !folded) {
          // Start closed at the island's centre and open on the next frame.
          drawNotch(item, N.collapsed(geo), line);
          requestAnimationFrame(() => {
            const st = notchState.get(item);
            if (st && st.key === key) drawNotch(item, geo, line);
          });
        } else {
          drawNotch(item, shape, line);
        }
      });
    } catch (e) {
      // Never break the fit pass, but say so once: a silent failure here leaves
      // the island drawn over a tile with nothing in the console to explain it.
      if (!islandWarned) { islandWarned = true; console.warn('[island] notch reflow failed:', e); }
    }
  }
  let islandWarned = false;

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
    // Never on a phone. The island puts the clock in a centre pill and the quick
    // actions in two rails hugging the screen edges — a layout that assumes room
    // beside the tiles. At 390px the pill is wider than the screen (its left and
    // right ends are simply cut off) and the rails cover the content they sit
    // next to. The phone view has its own compact bar and a thumb dock, so the
    // decision belongs here, where "which chrome" is already decided once.
    const phone = !!(window.PhoneView && window.PhoneView.isActive());
    const wantRails = !phone && !!(settings && (settings.topbarStyle === 'minimal' || barHidden));
    document.body.classList.toggle('topbar-noisland', wantRails && barHidden);
    if (wantRails) enable(); else disable();
    applyIslandLayout();
    // The progress row belongs to Music only, and its ticker is gated on it.
    if (window.TopbarMedia && typeof TopbarMedia.apply === 'function') TopbarMedia.apply();
    // Pick up an auto-hide setting change even when already active (enable() would
    // have early-returned). Self-guards when inactive.
    configureAutoHide();
    // Cards on the island move to the normal stack if the chrome stopped being minimal.
    if (window.XenonToast && typeof window.XenonToast.refresh === 'function') window.XenonToast.refresh();
  }

  // Keep the rails out while the user is styling them; let go and the idle
  // countdown starts over.
  function holdRails(hold) {
    railsHeld = hold === true;
    if (railsHeld) { clearAutoHideTimer(); setRailsHidden(false); } else armAutoHide();
  }

  // The first-run tour points at buttons inside the rails, so it opens collapsed
  // ones while it runs. Visual only: the stored open/closed choice is never
  // written, and letting go puts each rail back exactly as it was on screen.
  let peekedRails = null;
  function peekRails(peek) {
    if (!ui) return;
    const sides = ['left', 'right'];
    if (peek && !peekedRails) {
      peekedRails = { left: ui.left.rail.classList.contains('is-collapsed'), right: ui.right.rail.classList.contains('is-collapsed') };
      sides.forEach((sd) => syncRail(ui[sd].rail, ui[sd].handle, false));
    } else if (!peek && peekedRails) {
      sides.forEach((sd) => syncRail(ui[sd].rail, ui[sd].handle, peekedRails[sd]));
      peekedRails = null;
    }
  }

  window.TopbarMinimal = { apply, reflowIsland, followIsland, applyIslandLayout, morphIsland, homeBox, holdRails, peekRails };
})();
