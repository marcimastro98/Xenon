// The steps of the tour and what each points at: the list, the element a step finds on this page,
// the steps that have one, the words of a card, and the side buttons held open while the tour runs.

(() => {
  'use strict';

  // Four stops, no welcome or goodbye card: the person asked Bit for the tour, and
  // vendor data puts the drop-off after about four steps (Chameleon, Intercom).
  // Pages are taught by the gesture hint at the first touch, and the way back to
  // this tour is said on the last stop. Each step spotlights the first of its
  // `targets` that is on screen; a step whose targets are all hidden is skipped,
  // so a hidden button or a collapsed rail never leaves a spotlight on empty
  // space. `path` names the Settings category a body points to; it is filled
  // from the live labels so the text can't drift.
  const STEPS = [
    { targets: ['.topbtn-xenon'], titleKey: 'onb_ai_title', bodyKey: 'onb_ai_body', path: 'settings_cat_bit' },
    { targets: ['.qbtn-search'], titleKey: 'onb_search_title', bodyKey: 'onb_search_body' },
    { targets: ['#layout-edit-toggle'], titleKey: 'onb_layout_title', bodyKey: 'onb_layout_body' },
    { targets: ['.qbtn-settings'], titleKey: 'onb_settings_title', bodyKey: 'onb_settings_body', path: 'settings_cat_general' },
  ];

  const CARD_W = 340;     // layout px, clamped to the viewport in position()

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

  // The element a step spotlights, or null. On a phone the topbar buttons are
  // hidden and the thumb dock stands in for them.
  function targetOf(step) {
    for (const sel of step.targets) {
      const el = document.querySelector(sel);
      if (el && isShown(el)) return el;
      const stand = document.querySelector('.ph-dock [data-ph-for="' + sel + '"]');
      if (stand && isShown(stand)) return stand;
    }
    return null;
  }

  function resolveSteps() {
    return STEPS.filter((s) => targetOf(s));
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

  window.OnboardingSteps = { CARD_W, tr, zoom, targetOf, resolveSteps, bodyText, holdRails };
})();
