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
  let letGo = null;
  let unpad = null;
  let refreshTimer = 0;
  const REFRESH_DELAY_MS = 250;

  function openVerb(verb) {
    const [what, cat] = String(verb || '').split(':');
    if (what === 'dashboard' || !window.DashboardOpen) return;
    window.DashboardOpen.run(what === 'macro' ? { open: what, id: cat } : what === 'settings' ? { open: what, cat } : { open: what, kind: cat });
  }

  function stepBack() {
    if (view && !view.stepBack()) close();
  }

  function build() {
    scrim = document.createElement('div');
    scrim.className = 'xm-scrim';
    scrim.hidden = true;
    const frame = document.createElement('div');
    frame.className = 'xm-frame';
    frame.setAttribute('role', 'dialog');
    frame.setAttribute('aria-modal', 'true');
    frame.tabIndex = -1;
    const root = document.createElement('div');
    root.id = 'xm-root';
    frame.appendChild(root);
    scrim.appendChild(frame);
    scrim.addEventListener('pointerdown', (e) => { if (!frame.contains(e.target)) close(); });
    document.body.appendChild(scrim);
    return root;
  }

  function open(section) {
    if (view) { view.show(section); return; }
    const root = build();
    const frame = scrim.querySelector('.xm-frame');
    frame.setAttribute('aria-label', t('xmenu_title'));
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
    letGo = window.DialogFocus.hold(frame, { onEsc: stepBack, leavesEsc: () => !!view && view.holdsEsc() });
    view.load().then(() => {
      const first = root.querySelector('.xm-nav-btn[aria-current="true"]');
      if (first && scrim && !scrim.hidden) first.focus({ focusVisible: false });
    });
  }

  function close() {
    if (!view) return;
    letGo();
    letGo = null;
    if (unpad) unpad();
    unpad = null;
    view.destroy();
    view = null;
    if (scrim) scrim.remove();
    scrim = null;
  }

  window.addEventListener('xenon-menu-changed', () => {
    if (!view) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { if (view) view.load(); }, REFRESH_DELAY_MS);
  });

  window.XenonMenuPanel = { open, close, openVerb, isOpen: () => !!view };
})();
