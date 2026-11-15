'use strict';
// Xeneon Edge preview (browser surfaces only).
//
// Renders the dashboard exactly as it appears on the 2560×720 Edge, scaled to fit
// the browser window, so a layout arranged in a desktop browser matches the real
// device. The whole <body> is forced to a 2560×720 stage and transform-scaled;
// because a transformed ancestor is the containing block for its position:fixed
// descendants, the topbar/ticker/floating buttons/modals scale with it (see
// styles/edge-preview.css). A no-op inside the native app (the window IS the Edge).
//
// Turn it on with ?edge (or #edge) in the URL, the floating chip, or
// window.EdgePreview.toggle(). The choice is per-browser (localStorage), NOT synced
// to the Edge — it's a viewing aid for this browser only.
//
// The preview auto-suspends while the Settings overlay is open (#86): the Edge
// stage is a viewing aid for arranging the *dashboard*, but settings are far easier
// to use at the browser's real size than letterboxed into a 2560×720 frame. The
// preference stays on; only its visual application pauses, and it resumes the moment
// Settings close.
(function () {
  const EDGE_W = 2560;
  const EDGE_H = 720;
  const STORE_KEY = 'xenon.edgePreview';

  // Never in the native shell: it already runs at the Edge's real resolution, and
  // scaling the body there would fight the shell's own zoom handling.
  const isNative = window.__XENON_NATIVE__ === true || window.isTauri === true;

  let on = false;          // the persisted user preference
  let suspended = false;   // temporarily paused (e.g. Settings overlay open)
  let chip = null;
  let idleTimer = null;

  // The stage is visually applied only when the user wants it AND nothing is
  // suspending it. `on` alone drives the checkbox / persistence.
  function effective() { return on && !suspended; }

  function t(key, fallback) {
    try { if (typeof window.t === 'function') { const s = window.t(key); if (s && s !== key) return s; } } catch (e) { /* i18n not ready */ }
    return fallback;
  }

  function fit() {
    if (!effective()) return;
    const vw = window.innerWidth || EDGE_W;
    const vh = window.innerHeight || EDGE_H;
    const scale = Math.min(vw / EDGE_W, vh / EDGE_H);
    const x = Math.max(0, (vw - EDGE_W * scale) / 2);
    const y = Math.max(0, (vh - EDGE_H * scale) / 2);
    const root = document.documentElement;
    root.style.setProperty('--edge-scale', String(scale));
    root.style.setProperty('--edge-x', x + 'px');
    root.style.setProperty('--edge-y', y + 'px');
  }

  // The dashboard grid sizes its rows from a window `resize` (dashboard-grid.js →
  // fitGridHeights). The stage doesn't emit one, so nudge a synthetic resize after
  // toggling so tiles refit to the 2560-wide stage. Guarded against re-entrancy.
  let relayouting = false;
  function relayout() {
    if (relayouting) return;
    relayouting = true;
    requestAnimationFrame(() => {
      relayouting = false;
      try { window.dispatchEvent(new Event('resize')); } catch (e) { /* no-op */ }
    });
  }

  function buildChip() {
    if (chip) return;
    chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'edge-preview-chip';
    chip.setAttribute('aria-label', t('edge_preview_exit', 'Exit Xeneon Edge preview'));
    const label = document.createElement('span');
    label.textContent = t('edge_preview_label', 'Xeneon Edge preview');
    const dim = document.createElement('span');
    dim.className = 'epc-dim';
    dim.textContent = '2560×720';
    const x = document.createElement('span');
    x.className = 'epc-x';
    x.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    chip.append(label, dim, x);
    chip.addEventListener('click', () => setOn(false));
    chip.addEventListener('pointerenter', armIdle);
    // Injected into <html>, OUTSIDE the scaled <body>, so it stays viewport-sized.
    document.documentElement.appendChild(chip);
  }

  function armIdle() {
    if (!chip) return;
    chip.classList.remove('is-idle');
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (chip) chip.classList.add('is-idle'); }, 4000);
  }

  function apply() {
    const root = document.documentElement;
    if (effective()) {
      root.classList.add('edge-preview');
      buildChip();
      fit();
      armIdle();
      relayout();
    } else {
      root.classList.remove('edge-preview');
      root.style.removeProperty('--edge-scale');
      root.style.removeProperty('--edge-x');
      root.style.removeProperty('--edge-y');
      if (chip) { chip.remove(); chip = null; }
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      relayout();
    }
  }

  // Keep the Settings → General checkbox in step with the actual state.
  function syncToggle() {
    const cb = document.getElementById('settings-edge-preview');
    if (cb) cb.checked = on;
  }

  function setOn(next) {
    next = !!next;
    if (next === on) return;
    on = next;
    try { localStorage.setItem(STORE_KEY, on ? '1' : '0'); } catch (e) { /* private mode */ }
    apply();
    syncToggle();
  }

  // Pause/resume the visual stage without touching the saved preference or the
  // checkbox. Used to drop out of the Edge letterbox while Settings are open (#86).
  function setSuspended(next) {
    next = !!next;
    if (next === suspended) return;
    suspended = next;
    apply();
  }

  // Suspend while the Settings overlay is open, resume when it closes. Watched via
  // the overlay's `hidden` attribute so every open/close path is covered without
  // coupling settings.js to this module. The observer lives for the page lifetime.
  function watchSettingsOverlay() {
    const overlay = document.getElementById('settings-overlay');
    if (!overlay) return;
    const sync = () => setSuspended(!overlay.hidden);
    try {
      new MutationObserver(sync).observe(overlay, { attributes: true, attributeFilter: ['hidden'] });
    } catch (e) { /* MutationObserver unavailable — preview simply won't auto-pause */ }
    sync();
  }

  function initialState() {
    // URL wins so a shared/bookmarked ?edge link always opens in preview.
    try {
      const p = new URLSearchParams(window.location.search);
      if (p.has('edge')) return p.get('edge') !== '0' && p.get('edge') !== 'false';
    } catch (e) { /* ignore */ }
    if ((window.location.hash || '').toLowerCase().indexOf('edge') >= 0) return true;
    try { return localStorage.getItem(STORE_KEY) === '1'; } catch (e) { return false; }
  }

  window.addEventListener('resize', fit, { passive: true });

  // Public API: a Settings toggle / shortcut can flip it; `isOn` reflects state.
  window.EdgePreview = {
    toggle: function () { if (!isNative) setOn(!on); },
    setEnabled: function (v) { if (!isNative) setOn(v); },
    isOn: function () { return on; },
    available: !isNative,
  };

  function init() {
    if (isNative) return;             // native window is already the Edge
    // Reveal the browser-only Settings toggle. Hidden via display (not `hidden`):
    // the settings category switcher rewrites `hidden` on every category change,
    // which would resurface the row in the native kiosk where it is a no-op.
    const row = document.getElementById('settings-edge-preview-row');
    if (row) row.style.removeProperty('display');
    if (initialState()) setOn(true);
    syncToggle();
    watchSettingsOverlay();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
