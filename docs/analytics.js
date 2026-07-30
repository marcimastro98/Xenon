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

  // A download press, counted on our own hub as well as in GA4.
  //
  // GA4 alone was never enough for this one number: it is sampled, a day or two
  // behind, and blocked outright by a share of a dev-leaning audience that
  // nobody can measure. The hub counter is exact and immediate, and it is the
  // only step of the funnel neither of the other sources can see — Cloudflare
  // knows the page was viewed, GitHub knows a download finished, and the press
  // in between is where a download page either works or does not.
  //
  // Deliberately a BEACON and not a redirect through the hub: the links keep
  // pointing straight at GitHub, so a Worker outage costs a statistic and never
  // the download itself. It is fire-and-forget in every sense — no response is
  // read, nothing is awaited, and a failure is invisible to the page. The hub
  // stores one counter per (day, source); there is no identifier in it.
  const HUB = 'https://xenon-supporter-hub.xenonedge.workers.dev/go/download';
  function countDownload(location) {
    try {
      const url = HUB + '?b=1&s=' + encodeURIComponent(String(location || 'site').slice(0, 24));
      // sendBeacon survives the navigation a download click starts, which a
      // plain fetch does not reliably do.
      if (navigator.sendBeacon && navigator.sendBeacon(url)) return;
      fetch(url, { mode: 'no-cors', keepalive: true }).catch(function () {});
    } catch (_) { /* best-effort, never fatal */ }
  }

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
    if (tagged) {
      const params = paramsFrom(tagged);
      track(tagged.getAttribute('data-track'), params);
      // The site's download buttons all carry data-track="download_click" plus a
      // data-track-location, so this covers every one of them without a second
      // list of selectors to keep in step.
      if (tagged.getAttribute('data-track') === 'download_click') countDownload(params.location);
      return;
    }

    const a = t.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (/Xenon-Setup-x64\.exe/i.test(href)) {
      track('download_click', { location: 'auto', link_url: href });
      countDownload('auto');
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
