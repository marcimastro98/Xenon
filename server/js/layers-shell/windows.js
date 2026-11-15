// What the app's shell is told about each window of widgets: whether this page is the shell's
// driver, the windows of alerts, drawing and the Xenon menu, and the description of every window
// the layout needs.

(() => {
  'use strict';

  const caps = () => window.__XENON_NATIVE_CAPS__ || {};

  // The hidden page of "widgets only" (js/shell-driver.js), not the dashboard.
  const isDriver = () => {
    const root = typeof document !== 'undefined' && document.documentElement;
    return !!(root && root.hasAttribute && root.hasAttribute('data-shell-driver'));
  };

  // With no dashboard window the pop-ups need a window of their own: the
  // on-screen alerts (js/screen-alerts.js), an overlay on the main screen.
  const ALERTS_SURFACE = Object.freeze({ key: 'alerts:', kind: 'overlay', monitor: '' });

  // Drawing on the screen where the capture engine has no sheet (macOS, Linux):
  // the shell's see-through /draw page over the main screen, while the server
  // says drawing is on (server/alerts/screen-draw-shell.js, SSE `screen_draw`).
  const DRAW_SURFACE = Object.freeze({ key: 'draw:', kind: 'draw', monitor: '' });

  // The Xenon menu over the main screen (server/menu/screen-menu.js, SSE
  // `screen_menu`): the shell's /menu page, while the server says it is open.
  const MENU_SURFACE = Object.freeze({ key: 'menu:', kind: 'menu', monitor: '' });

  // What the shell needs per window: its key, its behaviour, and for an
  // anchored widget the app it follows. Which tiles go where stays in the page.
  // `alerts`: the alerts window goes first, so the widget cap never drops it.
  // `scenes`: the wallpaper and screensaver windows, after the widgets.
  // `draw`: the drawing sheet, first of all: the user just asked for it.
  // `menu`: the Xenon menu, before even that: the user just pressed its key.
  // `capturing`: Xenon was recording when the menu opened, so the menu stays out
  // of that video; otherwise it can be photographed like any window.
  // `top`: a game is on, so the menu stays on top of it; else it is an ordinary window.
  // `front`: counts the asks to bring the open menu forward (server/menu/screen-menu.js).
  // `desks`: some page is tied to a virtual desktop, so the shell says which
  // one is shown (LayersShell.onDesk); nothing watches desktops otherwise.
  // `pad`: the shell reads a game controller, whose two small middle buttons held
  // (View + Menu, Create + Options) open the Xenon menu (layers/pad.rs); off with
  // `layers.menuPad` false.
  function specFor(layers, opts) {
    // The app's picture stays here: the spec travels in an address.
    const forShell = ({ icon: _picture, ...anchor }) => anchor;
    const LM = window.LayersModel;
    const cur = LM.normalize(layers);
    const surfaces = LM.surfaceKeys(cur).map((key) => {
      const w = LM.widgetsFor(cur, key)[0];
      const s = { key, kind: w.surface };
      if (w.surface === 'anchor') s.anchor = forShell(w.anchor);
      else s.monitor = w.monitor || '';
      return s;
    });
    if (opts && opts.alerts) surfaces.unshift({ ...ALERTS_SURFACE });
    if (opts && opts.draw) surfaces.unshift({ ...DRAW_SURFACE });
    if (opts && opts.menu) surfaces.unshift({ ...MENU_SURFACE });
    if (opts && Array.isArray(opts.scenes)) surfaces.push(...opts.scenes);
    const spec = { exclude: cur.excludeFromCapture, surfaces };
    if (opts && opts.desks && cur.pages.some((p) => p.desktop)) spec.desks = true;
    if (opts && opts.pad && cur.menuPad) spec.pad = true;
    if (opts && opts.capturing) spec.capturing = true;
    if (opts && opts.menu && opts.top) spec.top = true;
    if (opts && opts.menu && opts.front) spec.front = opts.front;
    return spec;
  }

  window.LayersShellWindows = { caps, isDriver, specFor };
})();
