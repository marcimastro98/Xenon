'use strict';
// The Screens section of the Xenon menu, its home: the screens as they stand on the desk,
// each saying what it shows, and for the one tapped three tabs: what it shows (the
// dashboard or the widgets), its widgets, and its background. The widget screens and the
// scenes keep the Widgets and Look builders' own rows, carried in `parts`; `tune` is what
// search finds inside. Pure.

const { k, run, open } = require('./menu-rows.js');
const { screenLabel, screensOf } = require('./menu-tune.js');
const { widgetsSection } = require('./menu-widgets.js');
const { lookSection } = require('./menu-look.js');

// How this PC uses Xenon, said once for every screen: what a PC with no screen known
// gets, and what search finds under the home.
function modeSection(st) {
  const rows = [];
  if ((st.probes || {}).usageMode) {
    const value = st.usageMode || 'dashboard';
    rows.push({
      kind: 'mode', id: 'mode', label: k('xmenu_mode'), value,
      options: ['dashboard', 'widgets', 'both'].map((m) => ({ value: m, label: k('xmenu_mode_' + m), sub: k('xmenu_mode_' + m + '_sub'),
        act: run({ type: 'usageMode', mode: m }) })),
    });
    if (value === 'widgets') {
      rows.push({ kind: 'toggle', id: 'alerts', label: k('xmenu_alerts'), sub: k('xmenu_sub_alerts'), on: st.alertsOn !== false,
        acts: { on: run({ type: 'screenAlerts', alerts: 'on' }), off: run({ type: 'screenAlerts', alerts: 'off' }) } });
    }
  }
  if (st.usageMode !== 'widgets') {
    rows.push({ kind: 'button', id: 'dashboard', label: k('xmenu_mode_dashboard'), sub: k('xmenu_sub_dashboard'), action: k('xmenu_open'), act: open('dashboard'), primary: true, closes: true, screenOnly: true });
  }
  return rows;
}

// The screen a widget row is on: its monitor (menu-widgets.js keeps only a known one),
// else the main screen; an app's window has no screen of its own and follows the app.
const screenOfRow = (r, main) => (r.at && r.at.monitor) || main;

// Dashboard or widgets, on one screen. The dashboard goes where it is chosen and the
// widgets stay on the other screens; widgets on the dashboard's own screen closes the
// dashboard. "Not asked yet" behaves as the dashboard, so it keeps both. The answer in
// use never runs (the mode row only acts on the other one).
function showsRow(st, n, here) {
  if (!(st.probes || {}).usageMode) return null;
  const mode = st.usageMode === 'widgets' || !st.usageMode ? 'both' : st.usageMode;
  return {
    kind: 'mode', id: 'shows-' + n, label: k('xmenu_scr_shows'), value: here ? 'dashboard' : 'widgets',
    options: [
      { value: 'dashboard', label: k('xmenu_scr_dashboard'), sub: k('xmenu_shows_dashboard_sub'), act: run({ type: 'usageMode', mode, screen: n }) },
      { value: 'widgets', label: k('xmenu_sec_widgets'), sub: k(here ? 'xmenu_shows_leave_sub' : 'xmenu_shows_widgets_sub'), act: here ? run({ type: 'usageMode', mode: 'widgets' }) : null },
    ],
  };
}

// The dashboard's own tiles are changed on the dashboard, never from here.
const tilesRow = () => ({ kind: 'button', id: 'tiles', label: k('xmenu_scr_tiles'), sub: k('xmenu_scr_tiles_sub'), action: k('xmenu_open'), act: open('dashboard'), closes: true, screenOnly: true });

// The Background tab: the screen's own Look tabs one under the other, each under its
// name when there are two. Without scenes on this machine, what Look has instead.
function lookTab(view, ctx) {
  const tabs = view ? view.tabs : [];
  // The Classic scene's switches are one row for the screen, whichever tab uses it.
  const seen = new Set();
  const once = (rows) => rows.filter((r) => !seen.has(r.id) && seen.add(r.id));
  const rows = tabs.length > 1
    ? tabs.flatMap((t) => [{ kind: 'tunehead', id: 'lookhead-' + t.id, label: t.label }, ...once(t.rows)])
    : tabs.flatMap((t) => once(t.rows));
  return {
    id: 'look', label: k('settings_cat_background'), value: tabs.length ? tabs[0].value : k('xmenu_theme'),
    rows: tabs.length ? [...ctx.wait, ...rows] : ctx.lookRows,
  };
}

// One screen: where it stands, what it shows, which widget rows are on it and its
// background (menu-look.js), found by the screen's key.
function screenView(m, i, screens, ctx) {
  const n = String(i + 1);
  const here = ctx.dash === m.key;
  const mine = ctx.widgetRows.filter((r) => screenOfRow(r, screens[0].key) === m.key);
  const shows = [showsRow(ctx.st, n, here), ...(!i ? ctx.alerts : [])].filter(Boolean);
  const chip = here ? k('xmenu_scr_dashboard') : k(mine.length ? 'xmenu_sec_widgets' : 'xmenu_scr_free');
  const tabs = [
    ...(shows.length ? [{ id: 'shows', label: k('xmenu_scr_shows'), value: chip, rows: shows }] : []),
    // The dashboard covers its screen: its widgets are its tiles, and widgets placed there
    // would sit behind it, so the tab offers none unless some are there already.
    { id: 'widgets', label: k('xmenu_sec_widgets'), value: here && !mine.length ? null : { text: String(mine.length) }, widgets: !here || mine.length > 0, rows: here ? [tilesRow()] : [] },
    lookTab(ctx.looks.find((v) => v.key === m.key), ctx),
  ];
  return {
    key: m.key, label: screenLabel(m, i, screens), width: m.width, height: m.height, x: m.x, y: m.y,
    main: !i, dashboard: here, chip, widgets: mine.map((r) => r.id), tabs,
  };
}

// No screen known (no app, or before it reports them): one, holding everything.
function loneView(ctx, mode) {
  return {
    key: '', label: k('xmenu_scr_this'), main: true, dashboard: false, chip: null, widgets: ctx.widgetRows.map((r) => r.id),
    tabs: [
      ...(mode.length ? [{ id: 'shows', label: k('xmenu_scr_shows'), value: k('xmenu_mode_' + (ctx.st.usageMode || 'dashboard')), rows: mode }] : []),
      { id: 'widgets', label: k('xmenu_sec_widgets'), value: { text: String(ctx.widgetRows.length) }, widgets: true },
      lookTab(null, ctx),
    ],
  };
}

function screensSection(st) {
  const widgets = widgetsSection(st);
  const look = lookSection(st);
  const mode = modeSection(st);
  const map = look.find((r) => r.kind === 'screens');
  const screens = screensOf(st);
  const ctx = {
    st, dash: String((st.scene || {}).dashboard || ''), looks: map ? map.screens : [],
    widgetRows: widgets.filter((r) => r.kind === 'widget'),
    alerts: mode.filter((r) => r.id === 'alerts'),
    wait: look.filter((r) => r.id === 'sceneWait'),
    lookRows: look,
  };
  return [{
    kind: 'home', id: 'home', label: k('xmenu_scr_map'), sub: k('xmenu_scr_map_sub'),
    screens: screens.length ? screens.map((m, i) => screenView(m, i, screens, ctx)) : [loneView(ctx, mode)],
    more: map ? map.more : null,
    parts: { widgets, look, mode },
    tune: [...mode, ...widgets, ...look.flatMap((r) => (r.kind === 'screens' ? r.tune : [r]))],
  }];
}

module.exports = { screensSection, modeSection };
