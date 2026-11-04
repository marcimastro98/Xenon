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
//   3. Count a few uses on our own hub, anonymously (`xusage`, see below).
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
    countUse('download.click');
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
    usageClick(t);

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

  // ── Anonymous feature counts (the hub's POST /usage) ─────────────────────
  //
  // Which parts of the site get used, as counters on our own hub, for every
  // visitor and not only those GA4 sees. What is sent is an id from the list
  // below and a number; nothing else. No identifier, nothing written on the
  // device: the only split is free or supporter, read (never written) from the
  // Maker's sign-in on this same site. The hub keeps the same list
  // (xenon-supporter-hub src/usage-features.js) and drops any other id;
  // server/test/site-usage.test.mjs keeps the two in step.
  //
  // Batched, and sent with sendBeacon when the page is hidden or closed, or a
  // minute after the first count. Like the download beacon, a failure is
  // invisible to the page.
  const USAGE_URL = 'https://xenon-supporter-hub.xenonedge.workers.dev/usage';
  const HOME_SECTIONS = ['screens', 'widgets', 'games', 'work', 'bit', 'catalog', 'support', 'faq', 'install'];
  const SITE_FEATURES = ['demo.click', 'demo.open', 'maker.click', 'catalog.entry', 'support.click', 'download.click']
    .concat(HOME_SECTIONS.map(function (s) { return 'home.' + s; }));
  const USAGE_FLUSH_MS = 60000;
  const usageQueue = {};
  let usageTimer = null;

  // A supporter when the Maker on this site holds a live supporter session.
  // Read only; a trial or a Sparks-only sign-in counts as free, as on the hub.
  function usageTier() {
    try {
      const s = JSON.parse(localStorage.getItem('xenon.maker.session') || 'null');
      const live = s && typeof s.token === 'string' && typeof s.exp === 'number' && s.exp * 1000 > Date.now();
      return live && s.trial !== true && s.sparks !== true ? 'supporter' : 'free';
    } catch (_) {
      return 'free';
    }
  }

  function flushUsage() {
    if (usageTimer) clearTimeout(usageTimer);
    usageTimer = null;
    const events = [];
    for (const f in usageQueue) {
      if (usageQueue[f] > 0) events.push({ f: f, n: Math.min(500, usageQueue[f]) });
    }
    if (!events.length) return;
    try {
      // A string body goes as text/plain: no preflight, nothing to read back.
      const body = JSON.stringify({ surface: 'site', tier: usageTier(), events: events });
      const sent = navigator.sendBeacon ? navigator.sendBeacon(USAGE_URL, body) : false;
      if (!sent) fetch(USAGE_URL, { method: 'POST', body: body, mode: 'no-cors', keepalive: true }).catch(function () {});
      for (let i = 0; i < events.length; i++) delete usageQueue[events[i].f];
    } catch (_) { /* best-effort, never fatal */ }
  }

  function countUse(id) {
    if (SITE_FEATURES.indexOf(id) < 0) return;
    usageQueue[id] = (usageQueue[id] || 0) + 1;
    if (!usageTimer) usageTimer = setTimeout(flushUsage, USAGE_FLUSH_MS);
  }
  // For page scripts that count a use of their own (the catalog's detail view).
  window.xusage = countUse;

  window.addEventListener('pagehide', flushUsage);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flushUsage();
  });

  // Where a click leads, by the link's own address: the demo, the Maker,
  // Support. Every page, whatever else the click is tagged with.
  function usageClick(target) {
    const a = target.closest('a[href]');
    if (!a) return;
    let url;
    try { url = new URL(a.href, location.href); } catch (_) { return; }
    if (/buymeacoffee\.com$/i.test(url.hostname) || /\/go\/support$/.test(url.pathname)) countUse('support.click');
    else if (url.origin !== location.origin) return;
    else if (/\/demo(\/|\/index\.html)?$/.test(url.pathname)) countUse('demo.click');
    else if (/\/maker(\/|\/index\.html)?$/.test(url.pathname)) countUse('maker.click');
  }

  // The demo opened as a page of its own, not inside the Maker's preview frame.
  function countDemoOpen() {
    let framed = true;
    try { framed = window.top !== window; } catch (_) { /* cross-origin parent: framed */ }
    if (!framed && /\/demo(\/|\/index\.html)?$/.test(location.pathname)) countUse('demo.open');
  }

  // The home page (any language) and its sections, each counted once per page
  // view when a good part of it has been on screen.
  function isHome() {
    const p = location.pathname.replace(/index\.html$/, '');
    if (/^\/([a-z]{2}(-[a-z]{2})?\/)?$/i.test(p)) return true;
    // The GitHub Pages copy lives under the repository's own folder.
    return /\.github\.io$/i.test(location.hostname) && /^\/[^/]+\/([a-z]{2}(-[a-z]{2})?\/)?$/i.test(p);
  }
  function watchSections() {
    if (!isHome() || typeof IntersectionObserver !== 'function') return;
    const seen = {};
    const io = new IntersectionObserver(function (entries) {
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const id = e.target.id;
        // Half of a short section, or half a screen of a tall one.
        const enough = e.intersectionRatio >= 0.5 || e.intersectionRect.height >= window.innerHeight * 0.5;
        if (!e.isIntersecting || !enough || seen[id]) continue;
        seen[id] = true;
        countUse('home.' + id);
        io.unobserve(e.target);
      }
    }, { threshold: [0, 0.25, 0.5, 0.75, 1] });
    const nodes = document.querySelectorAll('section[id]');
    for (let i = 0; i < nodes.length; i++) {
      if (HOME_SECTIONS.indexOf(nodes[i].id) >= 0) io.observe(nodes[i]);
    }
  }

  function startUsage() {
    countDemoOpen();
    watchSections();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startUsage);
  else startUsage();
})();
