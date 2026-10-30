'use strict';

// The Xenon menu inside the dashboard (plan §20): the same menu as the one over
// the main screen (js/xenon-menu.js draws both, from GET /xenon-menu), as a
// dialog over the dashboard. Opened by the "Main screen" tile, by SSE
// `xenon_menu_panel` (the menu asked for where no shell can draw it over the
// screen) and by window.XenonMenuPanel.open(section). Verbs that lead
// elsewhere run here: the gallery and Settings open on this dashboard, Bit
// wakes here, "dashboard" just closes the dialog.

(function () {
  if (!window.XenonMenuView) return;
  let scrim = null;
  let view = null;
  let opener = null;
  let unpad = null;
  let refreshTimer = 0;
  const REFRESH_DELAY_MS = 250;

  function openVerb(verb) {
    const [what, cat] = String(verb || '').split(':');
    if (what === 'bit') {
      if (typeof window._aiHandleWake === 'function') window._aiHandleWake();
      else if (typeof window.openAiPanel === 'function') window.openAiPanel();
      return;
    }
    if (what === 'dashboard' || !window.DashboardOpen) return;
    window.DashboardOpen.run(what === 'settings' ? { open: 'settings', cat } : { open: what });
  }

  function onKey(e) {
    if (e.key !== 'Escape' || !view || view.recording()) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  }

  function build() {
    scrim = document.createElement('div');
    scrim.className = 'xm-scrim';
    scrim.hidden = true;
    const frame = document.createElement('div');
    frame.className = 'xm-frame';
    frame.setAttribute('role', 'dialog');
    frame.setAttribute('aria-modal', 'true');
    const root = document.createElement('div');
    frame.appendChild(root);
    scrim.appendChild(frame);
    scrim.addEventListener('pointerdown', (e) => { if (!frame.contains(e.target)) close(); });
    document.body.appendChild(scrim);
    return root;
  }

  function open(section) {
    if (view) { view.show(section); return; }
    opener = document.activeElement;
    const root = build();
    scrim.querySelector('.xm-frame').setAttribute('aria-label', t('xmenu_title'));
    view = XenonMenuView.create(root, {
      // The dashboard's own SSE tells it what changed (xenon-menu-changed):
      // no second connection.
      place: 'dashboard', server: SERVER, t,
      onClose: close,
      onOpen: openVerb,
    });
    if (section) view.show(section);
    if (window.MenuGamepad) unpad = MenuGamepad.forMenu(window, root, view, close);
    scrim.hidden = false;
    document.addEventListener('keydown', onKey, true);
    view.load().then(() => {
      const first = root.querySelector('.xm-nav-btn[aria-current="true"]');
      if (first && scrim && !scrim.hidden) first.focus();
    });
  }

  function close() {
    if (!view) return;
    document.removeEventListener('keydown', onKey, true);
    if (unpad) unpad();
    unpad = null;
    view.destroy();
    view = null;
    if (scrim) scrim.remove();
    scrim = null;
    if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus();
    opener = null;
  }

  window.addEventListener('xenon-menu-changed', () => {
    if (!view) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { if (view) view.load(); }, REFRESH_DELAY_MS);
  });

  window.XenonMenuPanel = { open, close, openVerb, isOpen: () => !!view };
})();
