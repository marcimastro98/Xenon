// The main dashboard tells the native shell which widget-layer windows to keep
// open (apps/native/src-tauri/src/layers): one per layer per monitor and one per
// anchored widget, from hubSettings.layers. It also tells the server that this
// shell can draw layers, which keeps the `layers` capability honest
// (server/layers-host.js): no report, no placement offered to the AI or the Deck.
//
// Signals are navigations, like every other shell signal (native-bridge.js): one
// during the initial load would abort it, so they wait for it to end
// (`XenonNative.afterLoad`, which still runs when another signal cancelled the
// `load` event itself). The sync is
// idempotent and re-sent with every report, so a signal superseded by another
// one in the same tick heals within minutes.
(function () {
  'use strict';

  const REPORT_MS = 4 * 60 * 1000; // well inside the server's 10 minute window
  const SIGNAL_DELAY_MS = 300;
  const search = String((window.location && window.location.search) || '');
  const isLayerPage = /[?&]layer=/.test(search);

  const caps = () => window.__XENON_NATIVE_CAPS__ || {};
  const supported = () => !isLayerPage && window.__XENON_NATIVE__ === true && caps().layers === true;

  // The hidden page of "widgets only" (js/shell-driver.js), not the dashboard.
  const isDriver = () => {
    const root = typeof document !== 'undefined' && document.documentElement;
    return !!(root && root.hasAttribute && root.hasAttribute('data-shell-driver'));
  };

  // With no dashboard window the pop-ups need a window of their own: the
  // on-screen alerts (js/screen-alerts.js), an overlay on the main screen.
  const ALERTS_SURFACE = Object.freeze({ key: 'alerts:', kind: 'overlay', monitor: '' });

  // Bit's vitals popup (server/vitals-nag.js) has no PowerShell window off
  // Windows: it opens the same alerts window for as long as it shows, with or
  // without the dashboard (SSE `vitals_nag`).
  let vitalsUntil = 0;
  let vitalsTimer = null;

  function alertsWanted(s) {
    if (Date.now() < vitalsUntil) return true;
    const n = s && s.notifications;
    return isDriver() && !!window.UsageMode && window.UsageMode.widgetsOnly(s.usageMode)
      && !(n && n.onScreen === false);
  }

  function onVitalsPopup(d) {
    const until = Number(d && d.until);
    if (!Number.isFinite(until) || until <= Date.now()) return;
    vitalsUntil = until;
    clearTimeout(vitalsTimer);
    // The window stays a moment after the card, so its fade is not cut off.
    vitalsTimer = setTimeout(() => { vitalsTimer = null; sync(false); }, until - Date.now() + 1500);
    sync(false);
  }

  // A page that (re)starts while the popup shows picks it up again.
  async function readVitalsPopup() {
    try {
      const res = await fetch(SERVER + '/api/vitals/popup', { cache: 'no-store' });
      const body = res.ok ? await res.json() : null;
      if (body && body.popup) onVitalsPopup(body.popup);
    } catch (e) { /* server restarting: SSE vitals_nag brings it */ }
  }

  // The Ambient scene as animated wallpaper and screensaver
  // (js/screen-scene-model.js), from the last full status ({ gaming, idleSec }).
  let status = null;
  function sceneSurfaces(s) {
    if (caps().scene !== true || !window.ScreenSceneModel) return [];
    const display = caps().display || {};
    return window.ScreenSceneModel.surfaces({
      settings: s, displays: caps().displays, active: display.active, noDashboard: isDriver(), status,
    }).map(({ key, kind }) => ({ key, kind }));
  }

  // Drawing on the screen where the capture engine has no sheet (macOS, Linux):
  // the shell's see-through /draw page over the main screen, while the server
  // says drawing is on (server/screen-draw-shell.js, SSE `screen_draw`).
  const DRAW_SURFACE = Object.freeze({ key: 'draw:', kind: 'draw', monitor: '' });
  let drawing = false;
  const drawWanted = () => drawing && caps().draw === true;

  // The Xenon menu over the main screen (server/screen-menu.js, SSE
  // `screen_menu`): the shell's /menu page, while the server says it is open.
  const MENU_SURFACE = Object.freeze({ key: 'menu:', kind: 'menu', monitor: '' });
  let menuOpen = false;
  const menuWanted = () => menuOpen && caps().menu === true;

  // What the shell needs per window: its key, its behaviour, and for an
  // anchored widget the app it follows. Which tiles go where stays in the page.
  // `alerts`: the alerts window goes first, so the widget cap never drops it.
  // `scenes`: the wallpaper and screensaver windows, after the widgets.
  // `draw`: the drawing sheet, first of all: the user just asked for it.
  // `menu`: the Xenon menu, before even that: the user just pressed its key.
  // `desks`: some page is tied to a virtual desktop, so the shell says which
  // one is shown (LayersShell.onDesk); nothing watches desktops otherwise.
  // `pad`: the shell reads a game controller, whose two small middle buttons held
  // (View + Menu, Create + Options) open the Xenon menu (layers/pad.rs); off with
  // `layers.menuPad` false.
  function specFor(layers, opts) {
    const LM = window.LayersModel;
    const cur = LM.normalize(layers);
    const surfaces = LM.surfaceKeys(cur).map((key) => {
      const w = LM.widgetsFor(cur, key)[0];
      const s = { key, kind: w.surface };
      if (w.surface === 'anchor') s.anchor = w.anchor;
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
    return spec;
  }

  let sent = '';
  let pending = '';
  let timer = null;
  let waiting = false;
  let reportTimer = null;

  function fire() {
    waiting = false;
    timer = setTimeout(() => {
      timer = null;
      const next = pending;
      pending = '';
      if (!next) return;
      sent = next;
      try { window.location.href = 'xenon-app:layers-sync?d=' + encodeURIComponent(next); } catch (e) { /* not native */ }
    }, SIGNAL_DELAY_MS);
  }

  function signal(json) {
    pending = json;
    if (timer || waiting) return;
    waiting = true;
    window.XenonNative.afterLoad(fire);
  }

  // `force`: send even when nothing changed (a screen moved, or the periodic
  // self-heal). A layout with no layers sends nothing until it had some.
  // The user switched this PC to "widgets only" (js/usage-mode.js): the app's
  // own window trades the dashboard for the small driver page, which keeps the
  // sync going. Not after the tray's "Show Xenon" (`full=1`): that was asked for.
  function followUsageMode(s) {
    if (!window.UsageMode || !window.UsageMode.widgetsOnly(s.usageMode)) return false;
    const q = new URLSearchParams(search);
    if (q.get('shell') !== 'main' || q.get('full') === '1') return false;
    try { window.location.replace('/?shell=main'); } catch (e) { return false; }
    return true;
  }

  function sync(force) {
    if (!supported() || !window.LayersModel) return;
    // `hubSettings` is a script-level binding of settings.js, not a window prop.
    const s = typeof hubSettings === 'object' && hubSettings ? hubSettings : {};
    if (followUsageMode(s)) return;
    const spec = specFor(s.layers, {
      alerts: alertsWanted(s), scenes: sceneSurfaces(s), draw: drawWanted(), menu: menuWanted(), desks: caps().desks === true,
      pad: caps().pad === true && caps().menu === true,
    });
    const json = JSON.stringify(spec);
    if (!sent && !spec.surfaces.length && !spec.desks && !spec.pad) return;
    if (json === sent && !force) return;
    signal(json);
  }

  async function report() {
    const monitors = (Array.isArray(caps().displays) ? caps().displays : [])
      .map((d) => ({ key: String((d && d.id) || ''), primary: !!(d && d.primary === true) }))
      .filter((m) => m.key);
    try {
      await fetch(SERVER + '/layers/host', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          layers: true, scene: caps().scene === true, draw: caps().draw === true, menu: caps().menu === true, anchor: caps().anchor === true,
          desks: caps().desks === true, pad: caps().pad === true, monitors,
        }),
      });
    } catch (e) {
      console.warn('[layers] could not report to the server:', e && e.message);
    }
  }

  function onDraw(d) {
    const next = !!(d && d.drawing === true);
    if (next === drawing) return;
    drawing = next;
    sync(false);
  }

  // A page that (re)starts while the sheet is open picks it up again.
  async function readDraw() {
    if (caps().draw !== true) return;
    try {
      const res = await fetch(SERVER + '/screen-draw', { cache: 'no-store' });
      if (res.ok) onDraw(await res.json());
    } catch (e) { /* server restarting: SSE screen_draw brings it */ }
  }

  function onMenu(d) {
    const next = !!(d && d.open === true);
    if (next === menuOpen) return;
    menuOpen = next;
    sync(false);
  }

  // A page that (re)starts while the menu is open picks it up again.
  async function readMenu() {
    if (caps().menu !== true) return;
    try {
      const res = await fetch(SERVER + '/screen-menu', { cache: 'no-store' });
      if (res.ok) onMenu(await res.json());
    } catch (e) { /* server restarting: SSE screen_menu brings it */ }
  }

  // The shell says which virtual desktop is shown (layers/desks.rs); the server
  // shows the page tied to it. Only real changes are sent: the shell repeats
  // the last one whenever the spec asks for desktops again.
  let deskSent = '';
  async function onDesk(d) {
    const current = Number(d && d.current);
    const count = Number(d && d.count);
    if (!Number.isInteger(current) || !Number.isInteger(count) || current < 0 || count < 0 || current > 64 || count > 64) return;
    const body = JSON.stringify({ current, count });
    if (body === deskSent) return;
    deskSent = body;
    try {
      await fetch(SERVER + '/layers/desk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    } catch (e) {
      deskSent = '';
      console.warn('[layers] could not tell the server the desktop:', e && e.message);
    }
  }

  // A restarted server forgot the desktop: say it again with the report.
  function resendDesk() {
    if (!deskSent) return;
    const last = JSON.parse(deskSent);
    deskSent = '';
    onDesk(last);
  }

  function start() {
    if (!supported() || reportTimer) return;
    report().then(readDraw).then(readMenu).then(readVitalsPopup);
    reportTimer = setInterval(() => { report(); sync(true); resendDesk(); }, REPORT_MS);
  }

  if (supported()) window.XenonNative.afterLoad(start);

  // The shell pushes its display state after page loads too, not only when a
  // screen changed. Answering every push with a signal would loop: each signal
  // is a navigation, and the shell pushes again when it completes.
  let screensSeen = '';
  function screensChanged() {
    const c = caps();
    const now = JSON.stringify([c.displays || [], (c.display && c.display.active) || '']);
    if (now === screensSeen) return false;
    screensSeen = now;
    return true;
  }

  window.LayersShell = Object.freeze({
    sync: () => sync(false),
    // The shell pushed a new monitor list: windows have to move with it. A
    // shell that cannot draw layers (Linux on Wayland) pushes too, and must not
    // tell the server it can.
    onDisplays: () => {
      if (!supported() || !screensChanged()) return;
      sync(true);
      report();
    },
    // A full status payload: the screensaver follows the PC's idle time and a
    // game closes the scenes. Sent only when that changes what is open.
    onStatus: (d) => {
      if (!d || (d.gaming == null && d.gameRunning == null)) return;
      status = { gaming: !!d.gaming, idleSec: d.idleSec == null ? null : Number(d.idleSec) };
      sync(false);
    },
    // SSE `screen_draw`: the drawing sheet opened or closed.
    onDraw: (d) => { if (supported()) onDraw(d); },
    // SSE `screen_menu`: the Xenon menu opened or closed.
    onMenu: (d) => { if (supported()) onMenu(d); },
    // SSE `vitals_nag`: Bit's popup on this PC ({ text, mood, until }).
    onVitalsPopup: (d) => { if (supported()) onVitalsPopup(d); },
    // The shell: the virtual desktop shown changed ({ current, count }).
    onDesk: (d) => { if (supported()) return onDesk(d); return undefined; },
    specFor,
  });
})();
