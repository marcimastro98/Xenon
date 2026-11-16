// What the Twitch tile knows: its tiles on screen, how often it asks the hub, its tabs, and what it
// publishes to widgets.
'use strict';

(() => {
  const el = makeEl;                 // shared DOM factory from utils.js

  // Only tiles actually placed on a dashboard page count — a widget that was
  // never added sits in the #widget-pool, outside any .pager-page, and must not
  // poll anything.
  function tiles() { return Array.from(document.querySelectorAll('[data-dashboard-widget="twitchwatch"]')).filter(n => n.closest('.pager-page, .layer-slot')); }

  const POLL_MS = 60000;

  const TABS = ['followed', 'top', 'search'];

  function publish(stream, payload) {
    try {
      if (window.CustomWidget && typeof CustomWidget.publishStream === 'function') {
        CustomWidget.publishStream(stream, payload);
      }
    } catch { /* the SDK host is optional — never let it break the tile */ }
  }

  window.TwitchwatchWidgetKnown = { el, tiles, POLL_MS, TABS, publish };
})();
