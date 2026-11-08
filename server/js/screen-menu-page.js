'use strict';

// The Xenon menu in its own window (menu.html). The native shell opens this page
// in a window with a title bar, on top only of a game, while the server says the menu is
// open (server/screen-menu.js, the `menu:` surface of js/layers-shell.js) and
// gives it the keyboard. The menu itself is js/xenon-menu.js, the same one the
// dashboard shows as a panel. This page only themes it, closes it on Esc (the X
// is the window's own, layers/menu_window.rs) and sends the verbs that lead
// elsewhere on their way: Settings, the Store, Scintille and the gallery open in
// this same window (a sheet, js/sheet-page.js, which comes back here), the
// dashboard through an `xenon-app:` signal the shell accepts from this window
// only (layers::spec::dashboard_page). It stays when another window takes the
// focus: the user works in the app under it, and the system's own screenshot
// tool does. A one-shot function steps the window aside, so that the picture it
// takes is clear of it, and the window comes back with what happened on a line.

(function () {
  if (!window.XenonMenuView) return;
  const SETTINGS_TIMEOUT_MS = 3000;
  const SECTION_KEY = 'xenon.menuSection';

  const frame = document.querySelector('.xm-frame');
  const root = document.getElementById('xm-root');
  let closing = false;
  let stepped = false;   // out of the picture while a one-shot function runs
  let staying = false;   // a result's button turned this window into another screen
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

  const signal = (name) => {
    try { window.location.href = (window.__xenonSignal || String)('xenon-app:' + name); } catch (e) { /* not in the shell */ }
  };

  // Verbs that lead out of the menu.
  function openVerb(verb) {
    const [what, arg] = String(verb || '').split(':');
    if (toSheet(what === 'macro' ? { open: what, id: arg } : { open: what, cat: arg, kind: arg }) || what !== 'dashboard') return;
    signal('open-dashboard?open=dashboard');
  }

  // This window becomes that screen, and comes back to this section.
  function toSheet(req) {
    const address = DashboardOpen.sheetAddress(req);
    if (!address) return false;
    try { sessionStorage.setItem(SECTION_KEY, view ? view.section() : ''); } catch (e) { /* comes back on the first section */ }
    window.location.href = address;
    return true;
  }

  // A row that closes the menu. Closing takes this window away, so nothing can
  // wait here: a signal goes first, and an action goes to the server, which runs
  // it once the menu is off the screen (a screenshot must not catch it).
  function leave(act, row) {
    if (closing || stepped) return;
    if (row && row.returns && act.run) { stepAside(act.run); return; }
    if (act.open) {
      openVerb(act.open);
      if (!DashboardOpen.sheetAddress({ open: String(act.open).split(':')[0] })) close();
      return;
    }
    closing = true;
    fetch(SERVER + '/screen-menu', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ open: false, run: act.run }),
    }).catch(() => { closing = false; });
  }

  // The window hides before the action runs: the server waits for that, and says
  // when to come back (`aside` gone from SSE screen_menu).
  function stepAside(run) {
    stepped = true;
    signal('menu-aside');
    fetch(SERVER + '/screen-menu', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ aside: true, run }),
    }).catch(comeBack);
  }

  function comeBack() {
    stepped = false;
    signal('menu-back');
  }

  // The cards this menu would otherwise leave to the screen, said here instead.
  // Pressing a button leaves too: a folder opened now would land under this window.
  function sayResults() {
    window.XenonToast = {
      show: (card) => { view.showResult(card); return 1; },
      dismiss: () => view.showResult(null),
    };
    window.CaptureGallery = { open: ({ id }) => { staying = true; toSheet({ open: 'gallery', id }); } };
  }

  function onResultAction(a) {
    staying = false;
    if (typeof a.onClick === 'function') a.onClick();
    if (!staying) close();
  }

  function onEvent(name, d) {
    if (name === 'screen_menu' && d && d.open === true && d.sheet) toSheet(d.sheet);
    // Stepped aside it comes back to the screen it left, not to the top of a section.
    else if (name === 'screen_menu' && d && d.open === true && d.section && !stepped) view.show(d.section);
    if (name === 'screen_menu' && stepped && d && d.open === true && !d.aside) comeBack();
    if (name === 'settings') readSettings().then(applySettings);
    if (name === 'capture') CaptureToast.onCapture(d);
    if (name === 'capture_marker') CaptureToast.onMarker(d);
    if (name === 'stutter_why') view.showResult(AlertToasts.stutterWhy(d, { t }));
    if (name === 'xenon_menu_failed') view.showError(d.error);
  }

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || (view && view.holdsEsc())) return;
    e.preventDefault();
    if (!(view && view.stepBack())) close();
  });

  async function start() {
    const [hs, state] = await Promise.all([
      readSettings(),
      fetch(SERVER + '/screen-menu', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    // A tile's Set up button opened this window for that screen. Coming back from
    // one (`?back=1`), it is done, and the section it left from comes back.
    const back = /[?&]back=1/.test(window.location.search);
    if (!back && state && state.sheet && toSheet(state.sheet)) return;
    applySettings(hs);
    translateFrame();
    view = XenonMenuView.create(root, {
      place: 'screen', server: SERVER, t, live: true,
      onClose: close,
      onOpen: openVerb,
      leave,
      // The shell opens a link in the browser and lets it come above this window;
      // run on the server, the page would open behind a menu that stays on top.
      openLink: window.__xenonSignal ? (url) => { window.location.href = url; } : undefined,
      onResultAction,
      onEvent,
    });
    sayResults();
    let left = '';
    try { left = back ? sessionStorage.getItem(SECTION_KEY) || '' : ''; } catch (e) { /* the server's section */ }
    if (left || (state && state.section)) view.show(left || state.section);
    if (window.MenuGamepad) MenuGamepad.forMenu(window, root, view, close);
    await view.load();
    // Like a launcher: the window opens ready to type a function's name.
    const find = root.querySelector('.xm-find');
    if (find) find.focus();
  }

  start();
})();
