// First-run guided tour. A lightweight coachmark walkthrough that spotlights the
// real topbar/dashboard controls one at a time, so a new user discovers Bit, the
// chat, search, the layout editor, pages and Settings (with the Store) without
// reading a manual. Shown ONCE — the finished/skipped version is persisted in
// settings (server-backed, so a WebView storage wipe can't make it reappear) —
// and can be replayed any time from Settings → General.
(function () {
  'use strict';

  // Bump when the tour gains steps worth re-showing to existing users. The
  // auto-start only fires when the user's saved seenVersion is BELOW this.
  const ONBOARDING_VERSION = 1;

  // Each step spotlights the first of its `targets` that is on screen (or shows a
  // centered card when it has none). A step whose targets are all hidden is
  // skipped, so a hidden button, a collapsed rail or a single-page layout never
  // leaves a spotlight on empty space. `path` names the Settings category a body
  // points to; it is filled from the live labels so the text can't drift.
  const STEPS = [
    { targets: null, titleKey: 'onb_welcome_title', bodyKey: 'onb_welcome_body' },
    { targets: ['.topbtn-xenon'], titleKey: 'onb_ai_title', bodyKey: 'onb_ai_body', path: 'settings_cat_bit' },
    { targets: ['.chat-panel', '#media-panel'], titleKey: 'onb_chat_title', bodyKey: 'onb_chat_body' },
    { targets: ['.qbtn-search'], titleKey: 'onb_search_title', bodyKey: 'onb_search_body' },
    { targets: ['#layout-edit-toggle'], titleKey: 'onb_layout_title', bodyKey: 'onb_layout_body' },
    { targets: ['#pager-dots', '.ph-dock.has-pages .ph-pages'], titleKey: 'onb_pager_title', bodyKey: 'onb_pager_body' },
    { targets: ['.qbtn-settings'], titleKey: 'onb_settings_title', bodyKey: 'onb_settings_body' },
    { targets: null, titleKey: 'onb_done_title', bodyKey: 'onb_done_body', path: 'settings_cat_general' },
  ];

  let overlay = null;     // root .onb-overlay (portaled to body)
  let spot = null;        // .onb-spotlight cutout
  let card = null;        // .onb-card tooltip
  let steps = [];         // STEPS resolved to those whose target exists
  let index = 0;
  let active = false;
  let onResize = null;
  let onRailMoved = null;

  // Translate via the global t() with a literal fallback (t returns the key when
  // it has no translation, so we never render a raw key to the user).
  function tr(key, fallback) {
    if (typeof t !== 'function') return fallback;
    const v = t(key);
    return (v && v !== key) ? v : fallback;
  }

  // <html> CSS zoom (Xeneon Edge fractional-DPR comp) magnifies inline px on a
  // body-portaled fixed element, while getBoundingClientRect is in visual space —
  // divide rects by the zoom to get layout px (mirrors deck.js). 1 on desktop.
  function zoom() {
    return (window.__pageZoom && window.__pageZoom > 0) ? window.__pageZoom : 1;
  }

  // A button tucked into a rail the user collapsed is off screen on purpose; an
  // auto-hidden rail is not, because the tour holds the rails out while it runs.
  // A tile on another dashboard page sits beside the viewport, so it is not
  // shown; a rail is, even while it is still sliding in.
  function isShown(el) {
    if (el.closest('.edge-rail.is-collapsed')) return false;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    return !!el.closest('.edge-rail') || (r.right > 0 && r.left / zoom() < window.innerWidth);
  }

  // The element a step spotlights, or null. A tile that is a tab of a group is
  // spotlit as the whole group, tabs included, which is what the user sees. On a
  // phone the topbar buttons are hidden and the thumb dock stands in for them.
  function targetOf(step) {
    if (!step.targets) return null;
    for (const sel of step.targets) {
      const el = document.querySelector(sel);
      if (el && isShown(el)) return el.closest('.tabgroup') || el;
      const stand = document.querySelector('.ph-dock [data-ph-for="' + sel + '"]');
      if (stand && isShown(stand)) return stand;
    }
    return null;
  }

  function resolveSteps() {
    return STEPS.filter(s => !s.targets || targetOf(s));
  }

  function bodyText(step) {
    const text = tr(step.bodyKey, '');
    if (!step.path) return text;
    return text.replace('{path}', tr('ui_settings', 'Settings') + ' → ' + tr(step.path, ''));
  }

  // The minimal top bar keeps the Bit, Search, Layout and Settings buttons in
  // side rails that slide off when idle or stay closed by choice. Keep them out
  // and open for the whole tour; letting go restores both as they were.
  function holdRails(hold) {
    const tm = window.TopbarMinimal;
    if (!tm) return;
    try {
      if (typeof tm.holdRails === 'function') tm.holdRails(hold);
      if (typeof tm.peekRails === 'function') tm.peekRails(hold);
    } catch { /* the tour must never break the bar */ }
  }

  function build() {
    overlay = document.createElement('div');
    overlay.className = 'onb-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', tr('onb_aria', 'Tutorial'));

    spot = document.createElement('div');
    spot.className = 'onb-spotlight';
    overlay.appendChild(spot);

    card = document.createElement('div');
    card.className = 'onb-card';
    overlay.appendChild(card);

    // A tap on the dimmed surround advances — but never on the card itself.
    overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target === spot) next(); });
    document.addEventListener('keydown', onKey, true);
    onResize = () => position();
    window.addEventListener('resize', onResize);
    // A rail sliding back in moves the button under the spotlight: follow it.
    onRailMoved = (e) => { if (e.target.classList && e.target.classList.contains('edge-rail')) position(); };
    document.addEventListener('transitionend', onRailMoved);

    document.body.appendChild(overlay);
  }

  function onKey(e) {
    if (!active) return;
    if (e.key === 'Escape') { e.preventDefault(); finish(); }
    else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
  }

  function renderCard() {
    const step = steps[index];
    const total = steps.length;
    card.textContent = '';

    const dots = document.createElement('div');
    dots.className = 'onb-dots';
    for (let i = 0; i < total; i++) {
      const d = document.createElement('span');
      d.className = 'onb-dot' + (i === index ? ' active' : '');
      dots.appendChild(d);
    }

    const title = document.createElement('h3');
    title.className = 'onb-title';
    title.textContent = tr(step.titleKey, '');

    const body = document.createElement('p');
    body.className = 'onb-body';
    body.textContent = bodyText(step);

    const actions = document.createElement('div');
    actions.className = 'onb-actions';

    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'onb-btn onb-skip';
    skip.textContent = tr('onb_skip', 'Salta');
    skip.addEventListener('click', finish);

    const right = document.createElement('div');
    right.className = 'onb-actions-right';
    if (index > 0) {
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'onb-btn onb-back';
      back.textContent = tr('onb_back', 'Indietro');
      back.addEventListener('click', prev);
      right.appendChild(back);
    }
    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'onb-btn onb-next';
    nextBtn.textContent = index === total - 1 ? tr('onb_done', 'Inizia') : tr('onb_next', 'Avanti');
    nextBtn.addEventListener('click', next);
    right.appendChild(nextBtn);

    actions.append(skip, right);
    card.append(dots, title, body, actions);
  }

  // Place the spotlight over the current target and the card beside it. Centered
  // (no target) steps hide the spotlight and pin the card to the middle.
  function position() {
    const step = steps[index];
    const z = zoom();
    const vw = window.innerWidth, vh = window.innerHeight;
    const margin = 14;

    // Fix the card width in the SAME (layout) units used to position and clamp it.
    // The CSS width uses `vw`, which on the Xeneon Edge ignores the page zoom and so
    // disagrees with window.innerWidth — leaving the card wider than the space the
    // clamp works in and pushing a button off the right edge. Driving width from
    // window.innerWidth (layout px, like the Deck menu does) makes it impossible to
    // overflow: cw is guaranteed ≤ vw − 2·margin, so the clamp always fits it.
    const wantW = step.targets ? 340 : 380;
    card.style.maxWidth = 'none';
    card.style.width = Math.max(160, Math.min(wantW, vw - margin * 2)) + 'px';

    if (!step.targets) {
      spot.style.opacity = '0';
      spot.style.width = spot.style.height = '0px';
      card.classList.add('onb-card-center');
      overlay.classList.add('onb-dim'); // no spotlight here — dim the page behind the card
      card.style.left = card.style.top = '';
      return;
    }

    overlay.classList.remove('onb-dim'); // spotlight box-shadow does the dimming
    const el = targetOf(step);
    if (!el) { spot.style.opacity = '0'; card.classList.add('onb-card-center'); overlay.classList.add('onb-dim'); return; }
    // On a phone the dashboard scrolls, and the tile may sit below the fold.
    const seen = el.getBoundingClientRect();
    if (seen.top < 0 || seen.bottom / z > vh) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    const pad = 8;
    const left = r.left / z - pad, top = r.top / z - pad;
    const w = r.width / z + pad * 2, h = r.height / z + pad * 2;
    spot.style.opacity = '1';
    spot.style.left = Math.round(left) + 'px';
    spot.style.top = Math.round(top) + 'px';
    spot.style.width = Math.round(w) + 'px';
    spot.style.height = Math.round(h) + 'px';

    card.classList.remove('onb-card-center');
    // Measure the card off-screen first so we can flip it into the available space.
    card.style.left = '-9999px'; card.style.top = '-9999px';
    const cw = card.offsetWidth || 320, ch = card.offsetHeight || 160;
    const spotBottom = top + h, spotCenterX = left + w / 2;

    // Prefer below the target, else above, else beside it (a tall tile); if it
    // fits nowhere (a big tile on the short Xeneon Edge), centre it. ALWAYS
    // hard-clamp inside the viewport last, so the action buttons can never be
    // cut off at the edge.
    let cTop;
    let cLeft = spotCenterX - cw / 2;                 // centre under the target
    if (spotBottom + 12 + ch <= vh - margin) cTop = spotBottom + 12;
    else if (top - 12 - ch >= margin) cTop = top - ch - 12;
    else {
      cTop = top + h / 2 - ch / 2;
      if (left + w + 12 + cw <= vw - margin) cLeft = left + w + 12;
      else if (left - 12 - cw >= margin) cLeft = left - cw - 12;
      else cTop = (vh - ch) / 2;
    }
    cTop = Math.max(margin, Math.min(cTop, vh - ch - margin));
    cLeft = Math.max(margin, Math.min(cLeft, vw - cw - margin));
    card.style.left = Math.round(cLeft) + 'px';
    card.style.top = Math.round(cTop) + 'px';
  }

  function show() {
    renderCard();
    // Let the card lay out before measuring for placement.
    requestAnimationFrame(() => requestAnimationFrame(position));
  }

  function next() {
    if (index >= steps.length - 1) { finish(); return; }
    index++;
    show();
  }

  function prev() {
    if (index <= 0) return;
    index--;
    show();
  }

  function teardown() {
    active = false;
    document.removeEventListener('keydown', onKey, true);
    if (onResize) window.removeEventListener('resize', onResize);
    if (onRailMoved) document.removeEventListener('transitionend', onRailMoved);
    onResize = onRailMoved = null;
    holdRails(false);
    if (overlay) { overlay.remove(); overlay = null; }
    spot = card = null;
  }

  // Persist "this version has been seen" so the tour never auto-starts again.
  // Idempotent; replay (which doesn't change the version) calls it harmlessly.
  function markSeen() {
    if (typeof window.setOnboardingSeen === 'function') {
      try { window.setOnboardingSeen(ONBOARDING_VERSION); } catch { /* best-effort */ }
    }
  }

  // Record completion and close.
  function finish() {
    markSeen();
    teardown();
  }

  function start() {
    if (active) return;
    holdRails(true);
    steps = resolveSteps();
    if (!steps.length) { holdRails(false); return; }
    index = 0;
    active = true;
    build();
    show();
  }

  // Auto-start once on first run. Called after settings hydrate so the persisted
  // seenVersion is authoritative. Defers until any greeting splash has cleared.
  // Runs in BOTH the iCUE/Edge embedded host (the device's primary surface) and a
  // standalone browser tab — seenVersion is server-backed, so dismissing it in one
  // surface stops it auto-starting in the other.
  function maybeStart() {
    if (typeof isLayerPage === 'function' && isLayerPage()) return;   // the tour runs on the main dashboard
    const seen = (typeof window.getOnboardingSeen === 'function') ? window.getOnboardingSeen() : 0;
    if (seen >= ONBOARDING_VERSION) return;
    const greetingUp = () => !!document.querySelector('.greeting-splash');
    let waited = 0;
    const tick = () => {
      if (active) return;
      if (greetingUp() && waited < 8000) { waited += 400; setTimeout(tick, 400); return; }
      start();
      // Mark seen as soon as it auto-starts, so a reload mid-tour (or closing the
      // page) never re-triggers it. Replaying from Settings is always available.
      if (active) markSeen();
    };
    setTimeout(tick, 1200);
  }

  window.Onboarding = { start, maybeStart, isActive: () => active, version: ONBOARDING_VERSION };
})();
