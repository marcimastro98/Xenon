'use strict';

// Bit's chat reads this global, as on the dashboard (settings.js declares it there).
let hubSettings = {};

// The search window's page (spotlight.html), in its two hosts: the native window
// (?frameless=1), which grows, shrinks and closes through `xenon-app:` signals the
// shell reads (spotlight_window.rs), and Edge app mode, which resizes itself. The
// window is built once and then hidden for hours, so the shell calls
// window.__spotlightShown on every open: the theme and the language are read
// again, and the keyboard goes to the field without waiting for a click.

(function () {
  const SETTINGS_TIMEOUT_MS = 3000;
  const COMPACT_H = 150;
  const EXPANDED_H = 620;
  // Windows can hand the webview the focus a moment after the window gets it.
  const FOCUS_RETRY_MS = [60, 200, 500];
  const FRAMELESS = /[?&]frameless=1/.test(location.search);
  // A new window's first moments: the shell takes the focus back instead of
  // hiding it (SETTLE in spotlight_window.rs), and the page may never hear of it.
  const SETTLE_MS = 1600;
  // How long an open waits for the recents, so the window has its size before the bar comes in.
  const RECENT_WAIT_MS = 120;
  const bornAt = Date.now();
  // The native window's open and close (spotlight-motion.js); Edge app mode has its own.
  const motion = FRAMELESS && window.SpotlightMotion ? window.SpotlightMotion.create(document) : null;

  let canResize = false;
  let leftAlone = false;   // focus went elsewhere: the shell hid the bar, text and all

  const chat = () => window.SpotlightChat;
  const chatOpen = () => !!chat() && chat().isOpen();

  function signal(name) {
    try { window.location.href = (window.__xenonSignal || String)('xenon-app:' + name); } catch (e) { /* not native */ }
  }

  function resolveAppearance(mode) {
    if (mode === 'light' || mode === 'dark') return mode;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  async function readSettings() {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), SETTINGS_TIMEOUT_MS);
    try {
      const res = await fetch('/settings', { cache: 'no-store', signal: ctl.signal });
      const data = res.ok ? await res.json() : null;
      return data && data.settings && typeof data.settings === 'object' ? data.settings : null;
    } catch (e) {
      return null;   // the default look still reads; the search works the same
    } finally {
      clearTimeout(timer);
    }
  }

  // Returns whether the language changed.
  function applySettings(hs) {
    hubSettings = hs;
    const el = document.documentElement;
    const T = window.ThemeTokens;
    const skin = T.applySkin(el, hs);
    const palette = T.derivePalette(hs, { resolve: resolveAppearance });
    T.applyPalette(el, palette);
    T.applyMaterial(el, hs, palette, skin);
    T.applyFont(document, hs.uiFont);
    const next = normalizeLangCode(hs.language);
    // This page holds the languages it was served with (/layer-i18n.js): a new
    // one it lacks comes with the reload that follows (refreshLook).
    const changed = !!next && next !== lang;
    if (changed && i18n[next]) lang = next;
    el.lang = lang;
    return changed;
  }

  async function refreshLook() {
    const hs = await readSettings();
    if (hs && applySettings(hs) && !chatOpen()) location.reload();
  }

  function focusField() {
    if (chatOpen()) chat().focus();
    else if (window.Spotlight) window.Spotlight.open();
  }

  function fieldHasFocus() {
    const tag = document.activeElement && document.activeElement.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA';
  }

  function takeKeyboard() {
    focusField();
    for (const ms of FOCUS_RETRY_MS) setTimeout(() => { if (!fieldHasFocus()) focusField(); }, ms);
  }

  window.__spotlightShown = function () {
    // Every reset below happens unseen, then the bar settles in.
    if (motion) motion.away();
    // The kiosk's claim can come late; without one the server opens the Edge
    // search too, which takes the focus and closes this window.
    if (FRAMELESS) fetch('/spotlight/claimed', { method: 'POST' }).catch(() => {});
    const S = window.Spotlight;
    if (S && !chatOpen()) {
      if (leftAlone || !S.isOpen()) S.fresh();
      // Shown again as it was: the shell made the window compact, the list says how tall it is.
      else if (document.querySelector('.spotlight.spot-expanded')) signal('spotlight-expand');
      S.greet();
    }
    leftAlone = false;
    takeKeyboard();
    refreshLook();
    if (chat()) chat().takeAsked();
    if (motion) motion.enterAfter(S && !chatOpen() ? S.idle() : null, RECENT_WAIT_MS);
  };

  window.addEventListener('blur', () => {
    leftAlone = true;
    // The shell is hiding the window: what it draws now is what the next open shows first.
    if (motion && !chatOpen() && Date.now() - bornAt > SETTLE_MS) motion.away();
  });
  window.addEventListener('focus', () => {
    // A focus loss the shell did not act on.
    if (motion && motion.isAway()) motion.enter();
    focusField();
  });
  // Whatever happened, a window someone touches is never an empty bar.
  window.addEventListener('pointerdown', () => { if (motion && motion.isAway()) motion.enter(); });

  function resizeTo(height) {
    if (!canResize) return;
    try { window.resizeTo(window.outerWidth, height); } catch (e) { /* fixed size is fine */ }
  }

  // Edge app mode only: the window shrinks to the bar if the browser lets it.
  function tryCompact() {
    if (FRAMELESS) return;
    try {
      const before = window.outerHeight;
      window.resizeTo(window.outerWidth, COMPACT_H);
      setTimeout(() => {
        canResize = Math.abs(window.outerHeight - COMPACT_H) < 80;
        if (!canResize && window.outerHeight !== before) window.resizeTo(window.outerWidth, before);
      }, 100);
    } catch (e) { /* fixed size is fine */ }
  }

  window.addEventListener('spotlight-expand', (ev) => {
    if (chatOpen()) return;   // the search resetting behind the chat
    const expanded = !!(ev.detail && ev.detail.expanded);
    if (FRAMELESS) signal('spotlight-' + (expanded ? 'expand' : 'collapse'));
    else resizeTo(expanded ? EXPANDED_H : COMPACT_H);
  });

  window.addEventListener('spotlight-chat', (ev) => {
    const open = !!(ev.detail && ev.detail.open);
    if (FRAMELESS) signal(open ? 'spotlight-chat' : 'spotlight-search');
    else resizeTo(open ? EXPANDED_H : COMPACT_H);
  });

  function closeWindow() {
    if (FRAMELESS) {
      // Hidden now, so the next show starts from the bare panel.
      if (motion) motion.away();
      signal('spotlight-close');
      // The bar opens again with the next show (__spotlightShown), never in the
      // hidden window: there its recents grew a window the shell then shrank.
      setTimeout(() => {
        // Still here and focused: the shell did not hide it, so never leave an empty bar.
        if (!document.hasFocus()) return;
        window.Spotlight.open();
        if (motion) motion.enter();
      }, 250);
      return;
    }
    window.close();
    // If the browser refused the script close, never strand a dead page.
    setTimeout(() => { if (!document.hidden) window.Spotlight.open(); }, 150);
  }

  async function boot() {
    if (!window.Spotlight) return;
    window.Spotlight._setCloseNav(closeWindow);
    tryCompact();
    const hs = await readSettings();
    if (hs) applySettings(hs);
    window.Spotlight.open();
    if (chat()) chat().takeAsked();
    if (motion) motion.enter();
  }

  if (FRAMELESS) {
    document.body.classList.add('spotlight-frameless');
    document.documentElement.classList.add('spotlight-frameless-host');
    if (motion) motion.away();
  }
  document.addEventListener('DOMContentLoaded', boot);
})();
