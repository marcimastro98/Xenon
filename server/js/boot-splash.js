// Bit while the dashboard loads (components/BootSplash/BootSplash.css).
//
// Loaded right after its markup, at the top of <body>, so it runs before the
// rest of the page is parsed. It paints the splash on the ground the user's
// theme had last time, then lifts it once the dashboard has something real to
// show: the server's settings, and the first system data or a short wait after
// the settings for screens without it. Bit says hello for HELLO_MS before it
// goes. However the load goes, the splash is gone after HARD_CAP_MS, and a tap
// removes it at once: it never holds the dashboard hostage to a slow or
// offline backend.
//
// The colours are a snapshot of the applied theme, written by remember() after
// a settings apply, in a tiny key of their own: the settings blob can be
// megabytes, too much to parse before the first paint.
(() => {
  'use strict';

  const LOOK_KEY = 'xeneonedge.bootLook.v1';
  const HARD_CAP_MS = 6000;   // never cover the dashboard longer than this
  const SETTLE_MS = 1200;     // after the settings, how long to wait for live data
  const MIN_MS = 500;         // long enough to read as Bit, not a flash
  // Bit's hello once ready, skipped on a tap and without motion. With the CSS
  // fade after it, the hello reaches its last pose just as the splash is gone
  // (test/xenon-loader.test.mjs holds it to bit-hello.svg's own timing).
  const HELLO_MS = 670;
  const LEAVE_MS = 700;       // removal fallback, longer than the CSS fade
  const REMEMBER_DELAY_MS = 1000;
  const TOKENS = { bg: '--bg', text: '--text', accent: '--accent' };

  const el = document.getElementById('boot-splash');
  const startedAt = performance.now();
  const parts = { settings: false, data: false };
  let done = !el;
  let capTimer = 0;
  let settleTimer = 0;
  let rememberTimer = 0;
  let helloTimer = 0;
  let leaving = false;

  function readLook() {
    try {
      const look = JSON.parse(localStorage.getItem(LOOK_KEY) || 'null');
      return look && typeof look === 'object' ? look : null;
    } catch {
      return null;
    }
  }

  function validColor(v) {
    return typeof v === 'string' && v.length < 64 && !!window.CSS && CSS.supports('color', v);
  }

  function remove() {
    if (el && el.isConnected) el.remove();
  }

  function leave() {
    if (leaving) return;
    leaving = true;
    clearTimeout(helloTimer);
    el.classList.add('is-leaving');
    el.addEventListener('transitionend', remove, { once: true });
    setTimeout(remove, LEAVE_MS);
  }

  function hide(now = false) {
    if (done) return;
    done = true;
    clearTimeout(capTimer);
    clearTimeout(settleTimer);
    const wait = now ? 0 : Math.max(0, MIN_MS - (performance.now() - startedAt));
    setTimeout(() => {
      if (now || leaving || matchMedia('(prefers-reduced-motion: reduce)').matches) return leave();
      el.classList.add('is-ready');
      helloTimer = setTimeout(leave, HELLO_MS);
    }, wait);
  }

  // A part of the dashboard is ready: 'settings' (hydrated from the server) or
  // 'data' (the first system reading).
  function ready(part) {
    if (done || !(part in parts) || parts[part]) return;
    parts[part] = true;
    if (parts.settings && parts.data) hide();
    else if (part === 'settings') settleTimer = setTimeout(hide, SETTLE_MS);
  }

  // Snapshot the applied theme for the next load. Debounced: settings apply on
  // every slider step, and reading computed styles forces a style pass.
  function remember() {
    clearTimeout(rememberTimer);
    rememberTimer = setTimeout(() => {
      const cs = getComputedStyle(document.documentElement);
      const look = {};
      for (const [k, prop] of Object.entries(TOKENS)) {
        const v = cs.getPropertyValue(prop).trim();
        if (validColor(v)) look[k] = v;
      }
      if (typeof hubSettings === 'object' && hubSettings && hubSettings.bootSplash === false) look.off = true;
      const next = JSON.stringify(look);
      try {
        if (localStorage.getItem(LOOK_KEY) !== next) localStorage.setItem(LOOK_KEY, next);
      } catch { /* storage full or blocked: the next load uses the theme defaults */ }
    }, REMEMBER_DELAY_MS);
  }

  window.BootSplash = { ready, remember };
  if (done) return;

  const look = readLook();
  if (look && look.off) {
    done = true;
    remove();
    return;
  }
  if (look && validColor(look.accent)) {
    for (const k of Object.keys(TOKENS)) {
      if (validColor(look[k])) el.style.setProperty('--bs-' + k, look[k]);
    }
  } else {
    el.classList.add('is-neutral');
  }
  // A tap means "let me in": no hello, even if it already started.
  el.addEventListener('pointerdown', () => (done ? leave() : hide(true)), { once: true });
  capTimer = setTimeout(hide, HARD_CAP_MS);
})();
