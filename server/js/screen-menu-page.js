'use strict';

// The Xenon menu over the main screen (menu.html). The native shell opens this
// page in a window over everything while the server says the menu is open
// (server/screen-menu.js, the `menu:` surface of js/layers-shell.js) and gives
// it the keyboard. The menu itself is js/xenon-menu.js, the same one the
// dashboard shows as a panel. This page only themes it, closes it (Esc, a click
// outside, the window losing focus) and turns the verbs that lead elsewhere
// into `xenon-app:` signals the shell accepts from this window only
// (layers::spec::dashboard_page).

(function () {
  if (!window.XenonMenuView) return;
  const BLUR_GRACE_MS = 800;       // the shell gives the focus just after the load
  const SETTINGS_TIMEOUT_MS = 3000;

  const scrim = document.getElementById('xm-scrim');
  const frame = scrim.querySelector('.xm-frame');
  const root = document.getElementById('xm-root');
  const shownAt = Date.now();
  let closing = false;
  let view = null;

  // ── Theme and language, as the other layer pages apply them ──
  function resolveAppearance(mode) {
    if (mode === 'light' || mode === 'dark') return mode;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  async function readSettings() {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), SETTINGS_TIMEOUT_MS) : 0;
    try {
      const res = await fetch(SERVER + '/settings', { cache: 'no-store', signal: ctl && ctl.signal });
      const data = res.ok ? await res.json() : null;
      return data && data.settings && typeof data.settings === 'object' ? data.settings : null;
    } catch (e) {
      return null;   // the default theme still reads; the menu works the same
    } finally {
      clearTimeout(timer);
    }
  }

  function applySettings(hs) {
    if (!hs || !window.ThemeTokens) return;
    const el = document.documentElement;
    const skin = ThemeTokens.applySkin(el, hs);
    const palette = ThemeTokens.derivePalette(hs, { resolve: resolveAppearance });
    ThemeTokens.applyPalette(el, palette);
    ThemeTokens.applyMaterial(el, hs, palette, skin);
    ThemeTokens.applyFont(document, hs.uiFont);
    const next = normalizeLangCode(hs.language);
    if (next && i18n[next]) lang = next;
    el.lang = lang;
  }

  function translateFrame() {
    frame.setAttribute('aria-label', t('xmenu_title'));
  }

  // ── Closing ──
  async function close() {
    if (closing) return;
    closing = true;
    try {
      await fetch(SERVER + '/screen-menu', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ open: false }),
      });
    } catch (e) {
      closing = false;   // the server is restarting: Esc again, or the shell closes it with the server
    }
  }

  // Verbs that lead out of the menu. The menu closed itself already (rows that
  // lead elsewhere `close` first); Bit wakes through the server, which also
  // closes the menu.
  function openVerb(verb) {
    if (verb === 'bit') {
      fetch(SERVER + '/screen-menu', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bit: true }),
      }).catch(() => {});
      return;
    }
    const [what, cat] = String(verb || '').split(':');
    if (!['gallery', 'dashboard', 'settings'].includes(what)) return;
    const q = 'open=' + encodeURIComponent(what) + (what === 'settings' && cat ? '&cat=' + encodeURIComponent(cat) : '');
    try { window.location.href = 'xenon-app:open-dashboard?' + q; } catch (e) { /* not in the shell */ }
  }

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || (view && view.recording())) return;
    e.preventDefault();
    close();
  });
  scrim.addEventListener('pointerdown', (e) => {
    if (!frame.contains(e.target)) close();
  });
  // Clicking another window leaves the menu: it closes, like the system's own.
  window.addEventListener('blur', () => {
    if (Date.now() - shownAt > BLUR_GRACE_MS) close();
  });

  async function start() {
    const [hs, state] = await Promise.all([
      readSettings(),
      fetch(SERVER + '/screen-menu', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    applySettings(hs);
    translateFrame();
    view = XenonMenuView.create(root, {
      place: 'screen', server: SERVER, t, live: true,
      onClose: close,
      onOpen: openVerb,
      onEvent: (name, d) => {
        if (name === 'screen_menu' && d && d.open === true && d.section) view.show(d.section);
        if (name === 'settings') readSettings().then(applySettings);
      },
    });
    if (state && state.section) view.show(state.section);
    if (window.MenuGamepad) MenuGamepad.forMenu(window, root, view, close);
    await view.load();
    const first = root.querySelector('.xm-nav-btn[aria-current="true"]');
    if (first) first.focus();
  }

  start();
})();
