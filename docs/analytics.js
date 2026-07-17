// Shared GA4 event helper for the Xenon site (xenon-app.com).
//
// Two jobs:
//   1. Expose a safe `xtrack(name, params)` that never throws and quietly does
//      nothing when gtag is missing (adblocker, consent tools, offline). Analytics
//      must never break the page.
//   2. Auto-wire the events we care about without touching every link:
//        - one delegated click listener classifies download / Discord / coffee /
//          GitHub outbound clicks, and reads explicit `data-track` opt-ins;
//        - any element with `data-track-view` fires once on load (page-level events
//          like submit_start / create_start).
//
// The measurement id lives in each page's inline gtag snippet; this file only
// forwards events to whatever gtag the page already configured.
(function () {
  'use strict';

  function track(name, params) {
    if (!name) return;
    try {
      if (typeof window.gtag === 'function') window.gtag('event', name, params || {});
    } catch (_) { /* analytics is best-effort, never fatal */ }
  }
  window.xtrack = track;

  // Collect data-track-* attributes into a params object:
  //   data-track-location="hero" -> { location: 'hero' }
  function paramsFrom(elm) {
    const out = {};
    const attrs = elm.attributes;
    for (let i = 0; i < attrs.length; i++) {
      const a = attrs[i];
      if (a.name.indexOf('data-track-') === 0) {
        out[a.name.slice('data-track-'.length).replace(/-/g, '_')] = a.value;
      }
    }
    return out;
  }

  // One capture-phase listener for the whole page. Explicit data-track wins; if a
  // click has none, we still classify the outbound links that always matter.
  document.addEventListener('click', function (e) {
    const t = e.target;
    if (!t || !t.closest) return;

    const tagged = t.closest('[data-track]');
    if (tagged) { track(tagged.getAttribute('data-track'), paramsFrom(tagged)); return; }

    const a = t.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (/Xenon-Setup-x64\.exe/i.test(href)) {
      track('download_click', { location: 'auto', link_url: href });
    } else if (a.hasAttribute('data-discord') || /discord\.(gg|com)/i.test(href)) {
      track('discord_join', { link_url: href });
    } else if (/buymeacoffee\.com|ko-?fi\.com|paypal\.(me|com)/i.test(href)) {
      track('supporter_coffee', { link_url: href });
    } else if (/github\.com/i.test(href)) {
      track('github_view', { link_url: href });
    }
  }, true);

  // Page-level events: <body data-track-view="submit_start">
  function fireViews() {
    const nodes = document.querySelectorAll('[data-track-view]');
    for (let i = 0; i < nodes.length; i++) track(nodes[i].getAttribute('data-track-view'), {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fireViews);
  else fireViews();
})();
