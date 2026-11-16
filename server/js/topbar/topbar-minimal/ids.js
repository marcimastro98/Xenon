// The ids of the island's segments and of the chrome's buttons, the element a button id names, and
// the island's order as the settings keep it.

(() => {
  'use strict';

  // The reorderable island segments, in their default display order. A new id
  // must also be added to the canonical list in normalizeTopbarClock (client
  // settings/normalize-topbar.js AND its server/topbar/settings-normalize.js twin) and labelled in TOPBAR_ISLAND_LABELS,
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
    mini: '#topbar-mini-slot',
    layout: '#layout-edit-toggle',
    settings: '.qbtn-settings',
    apps: '.qbtn-apps',
    favorites: '#app-favorites',
  };

  // Element for a chrome-button id, or null when that button is not in this
  // document (embed views, a future build, a phone). Looked up live: the button
  // may have been moved into the other container.
  // A widget's own button (`sdk:<pkg>`, js/widget-sdk/sdk-topbar-button.js) is found by
  // its data-tb-id.
  const SDK_ACTION_RE = /^sdk:[a-z0-9][a-z0-9-]{1,40}$/;

  function actionEl(id) {
    const sel = ACTION_SELECTORS[id];
    if (sel) return document.querySelector(sel);
    return typeof id === 'string' && SDK_ACTION_RE.test(id) ? document.querySelector('[data-tb-id="' + id + '"]') : null;
  }

  // Read the configured island item list (order + hidden), defaulting to the
  // canonical order all-visible when settings aren't available yet.
  function readIslandItems() {
    const cfg = (typeof hubSettings !== 'undefined' && hubSettings && hubSettings.topbarClock) || null;
    if (cfg && Array.isArray(cfg.items) && cfg.items.length) return cfg.items;
    return ISLAND_SEG_IDS.map(id => ({ id, hidden: false }));
  }

  window.TopbarMinimalIds = { ISLAND_SEG_IDS, ACTION_SELECTORS, actionEl, readIslandItems };
})();
