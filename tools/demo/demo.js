'use strict';
// The demo's UI layer, loaded LAST — after js/main.js, so the fake EventSource
// created by initDataStream() is already registered and the grid has mounted.
// Everything data-shaped lives in demo/boot.js; this file only adds what a
// visitor sees: the badge, the conversion prompts, the "not in the demo" marks,
// and the catalog hand-off.
(function () {
  const tr = (k, fb) => (typeof window.t === 'function' && window.t(k) !== k) ? window.t(k) : fb;
  const track = (name, params) => { try { if (typeof window.xtrack === 'function') window.xtrack(name, params || {}); } catch { /* analytics is best-effort */ } };

  // ── Badge ─────────────────────────────────────────────────────────────────
  // Mounted on <html>, not <body>: edge-preview.js letterboxes and CSS-scales
  // <body> into a 2560x720 stage, so anything inside it gets squashed with the
  // dashboard. Same trick that file uses for its own chip (which owns the
  // bottom-RIGHT corner, hence bottom-left here).
  function mountBadge() {
    if (document.getElementById('demo-badge')) return;
    const bar = document.createElement('div');
    bar.id = 'demo-badge';

    const dot = document.createElement('span');
    dot.className = 'db-dot';

    const txt = document.createElement('span');
    txt.className = 'db-txt';
    txt.textContent = tr('demo_badge', 'Live demo — simulated data');

    const cta = document.createElement('a');
    cta.className = 'db-cta';
    cta.href = 'https://xenon-app.com/#install';
    cta.target = '_blank';
    cta.rel = 'noopener';
    cta.textContent = tr('demo_cta', 'Get Xenon free');
    // No JS needed: docs/analytics.js delegates on [data-track] in the capture
    // phase and turns data-track-* into event params.
    cta.setAttribute('data-track', 'demo_download_click');
    cta.setAttribute('data-track-location', 'badge');

    const min = document.createElement('button');
    min.type = 'button';
    min.className = 'db-min';
    min.setAttribute('aria-label', tr('demo_minimize', 'Minimize'));
    min.textContent = '–';
    min.addEventListener('click', () => {
      const collapsed = bar.classList.toggle('is-min');
      min.textContent = collapsed ? '+' : '–';
      // sessionStorage, not localStorage: a fresh visit should see it again.
      try { sessionStorage.setItem('xenon.demo.badge', collapsed ? '0' : '1'); } catch { /* private mode */ }
    });

    bar.appendChild(dot); bar.appendChild(txt); bar.appendChild(cta); bar.appendChild(min);
    document.documentElement.appendChild(bar);
    try {
      if (sessionStorage.getItem('xenon.demo.badge') === '0') { bar.classList.add('is-min'); min.textContent = '+'; }
    } catch { /* private mode */ }
  }

  // ── Conversion prompt ─────────────────────────────────────────────────────
  // The badge alone is wallpaper. This fires at the highest-intent moment there
  // is: the visitor has just tried to do something real and been told it needs
  // the app. Once per session, dismissible, never blocking.
  let promptShown = false;
  function showConvertPrompt(reason) {
    if (promptShown) return;
    try { if (sessionStorage.getItem('xenon.demo.prompt') === '1') return; } catch { /* private mode */ }
    promptShown = true;
    try { sessionStorage.setItem('xenon.demo.prompt', '1'); } catch { /* private mode */ }

    const sheet = document.createElement('div');
    sheet.id = 'demo-convert';

    const p = document.createElement('p');
    p.textContent = tr('demo_convert_msg', 'Everything you just touched runs locally on your own PC. Xenon is free and open source.');
    const row = document.createElement('div');
    row.className = 'dc-row';

    const go = document.createElement('a');
    go.className = 'dc-go';
    go.href = 'https://xenon-app.com/#install';
    go.target = '_blank'; go.rel = 'noopener';
    go.textContent = tr('demo_cta', 'Get Xenon free');
    go.setAttribute('data-track', 'demo_download_click');
    go.setAttribute('data-track-location', 'sheet');

    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'dc-no';
    no.textContent = tr('demo_dismiss', 'Keep looking around');
    no.addEventListener('click', () => sheet.remove());

    row.appendChild(go); row.appendChild(no);
    sheet.appendChild(p); sheet.appendChild(row);
    document.documentElement.appendChild(sheet);
    track('demo_convert_prompt', { reason: reason || 'time' });
  }

  // A blocked write is the trigger; 90 seconds of browsing is the fallback.
  window.addEventListener('xenon:demo-blocked', () => showConvertPrompt('blocked'));
  setTimeout(() => showConvertPrompt('time'), 90000);

  // ── "Not available in the demo" ───────────────────────────────────────────
  // Tiles whose whole content streams from a real PC would otherwise render as a
  // dead black rectangle. A MutationObserver on the grid re-applies the mark, so
  // it survives page switches, tile duplication and layout edits without any
  // per-widget knowledge — and without patching a single source file.
  const UNAVAILABLE = {
    browser: ['demo_na_browser', 'The Browser tile streams a real Chromium from your PC.'],
    secondscreen: ['demo_na_screen', 'This mirrors a display on your PC.'],
    remote: ['demo_na_remote', 'Remote control needs Sunshine and Tailscale on your PC.'],
    search: ['demo_na_search', 'Local file search reads your own drives.'],
    disk: ['demo_na_disk', 'Disk insights map your real drives.'],
  };

  function markUnavailable() {
    Object.keys(UNAVAILABLE).forEach((key) => {
      document.querySelectorAll('[data-dashboard-widget="' + key + '"]').forEach((tile) => {
        if (tile.querySelector(':scope > .demo-na')) return;
        const veil = document.createElement('div');
        veil.className = 'demo-na';
        const inner = document.createElement('div');
        inner.className = 'demo-na-in';
        const h = document.createElement('b');
        h.textContent = tr('demo_na_title', 'Runs on your PC');
        const p = document.createElement('span');
        p.textContent = tr(UNAVAILABLE[key][0], UNAVAILABLE[key][1]);
        inner.appendChild(h); inner.appendChild(p);
        veil.appendChild(inner);
        // The tile is the positioning context the veil needs; only set it when
        // the tile has not already established one.
        if (getComputedStyle(tile).position === 'static') tile.style.position = 'relative';
        tile.appendChild(veil);
      });
    });
  }

  let markQueued = false;
  function queueMark() {
    if (markQueued) return;
    markQueued = true;
    requestAnimationFrame(() => { markQueued = false; markUnavailable(); });
  }

  // ── Catalog hand-off ──────────────────────────────────────────────────────
  // boot.js parked and stripped the fragment before anything could react to it.
  // The apply itself goes through the app's OWN import dialog, so the visitor
  // sees the real preview/permission flow (a selling point in itself) and the
  // demo contains zero apply code that could diverge from the product.
  async function ingestPreset() {
    const parked = window.__XENON_DEMO_PRESET__;
    if (!parked || !window.PresetShare || !PresetShare.openImport) return;
    let code = '';
    let meta = { source: 'import' };
    if (parked.mode === 'preset') {
      code = parked.value;
    } else {
      const id = parked.value;
      if (!/^[a-z0-9][a-z0-9_-]{0,60}$/.test(id)) return;
      try {
        const r = await fetch('../community/codes/' + id + '.txt', { cache: 'no-store' });
        if (r.ok) code = (await r.text()).trim();
      } catch { /* fall through to the catalog entry's inline code */ }
      if (!code) {
        try {
          const cat = await (await fetch('../community/catalog.json', { cache: 'no-store' })).json();
          const entry = (cat.entries || []).find((e) => e && e.id === id);
          if (entry && entry.code) code = String(entry.code).trim();
          if (entry) meta = { source: 'catalog', sourceId: id, sourceVersion: entry.version || '', perfWarning: entry.perfWarning === true };
        } catch { /* no code: the app's own invalid-import toast explains it */ }
      } else {
        meta = { source: 'catalog', sourceId: id };
      }
    }
    track('demo_preset_open', { item_id: parked.value, ok: !!code });
    if (!code) return;
    PresetShare.openImport(code, meta);
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function start() {
    mountBadge();
    markUnavailable();
    const grid = document.getElementById('dashboard') || document.body;
    new MutationObserver(queueMark).observe(grid, { childList: true, subtree: true });
    track('demo_start', { entry: window.__XENON_DEMO_PRESET__ ? 'catalog' : 'direct' });
    // Let the grid mount and any greeting claim its slot before a dialog opens
    // on top of it.
    setTimeout(() => { ingestPreset().catch(() => {}); }, 400);
  }

  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
})();
