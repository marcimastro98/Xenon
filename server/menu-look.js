'use strict';
// The Look section of the Xenon menu: the theme, then the screens as they stand on the
// desk, each saying what it shows. One tap on a screen gives its own choices: the
// dashboard's screen has its Ambient scene, every other screen its wallpaper and its
// screensaver. What a screen says is what is on it now (js/screen-scene-model.js plan):
// a wallpaper that is off reads as the person's own. Pure.

const ScreenSceneModel = require('./js/screen-scene-model.js');
const { k, run, open } = require('./menu-rows.js');
const { screenLabel, screensOf } = require('./menu-tune.js');
const { MAKER_URL } = require('./menu-widgets.js');
const { BUILTIN, SCENE_PARTS, sceneList } = require('./capabilities/desktop-scene.js');

const NONE = '';

const themeRow = () => ({ kind: 'button', id: 'theme', label: k('xmenu_theme'), sub: k('xmenu_theme_sub'), action: k('xmenu_do_change'), act: open('settings:appearance'), closes: true });

// The scene ids the menu offers, with the uninstalled ones read as the built-in scene,
// which is what the screen falls back to (js/ambient-resolve.js).
function namer(list) {
  const known = (id) => (list.some((s) => s.id === id) ? id : BUILTIN);
  const name = (id) => {
    const s = list.find((x) => x.id === known(id));
    if (!s || s.id === BUILTIN) return k('ambient_scene_builtin');
    return s.name ? { text: s.name } : k('ambient_editor_untitled');
  };
  return { known, name };
}

// `live`: the moving preview in the screen's picture (js/xenon-menu-scene-view.js). Only
// one tab of one screen is drawn at a time, so one preview runs.
function sceneChoice(id, label, sub, value, list, none, actFor) {
  const { name } = namer(list);
  const options = list.map((s) => ({ value: s.id, label: name(s.id), act: run(actFor(s.id)) }));
  if (none) options.unshift({ value: NONE, label: k(none), act: run(actFor('none')) });
  return { kind: 'choice', id, label: k(label), sub: k(sub), value, live: true, scenes: true, options };
}

// The settings as the scene model reads them, from the menu's state.
function settingsOf(sc) {
  return { ambientMode: { enabled: sc.on !== false, sceneId: sc.id, wallpaper: sc.wallpaper, saverMinutes: sc.saverMinutes, screens: sc.screens, byScreen: sc.byScreen } };
}

// What one screen shows now, and its choices in tabs: the dashboard's screen has its
// Ambient and the dashboard's background, every other screen its wallpaper and its
// screensaver. Each tab says what it is set to; the picture of a screen says one line,
// so it fits the shortest screen.
// `n` is the screen's number for the action, as screensOf orders them.
function screenView(m, i, p, ctx) {
  const { sc, list, screens } = ctx;
  const { known, name } = namer(list);
  const n = String(i + 1);
  const on = sc.on !== false;
  const wall = on && sc.wallpaper && p.wallpaper ? known(p.wallpaper) : NONE;
  const saver = on && sc.saverMinutes > 0 && p.saver ? known(p.saver) : NONE;
  const act = (kind) => (scene) => ({ type: 'desktopScene', screen: n, for: kind, scene });
  // The Classic scene's own switches go with the tab that uses it.
  const parts = (value) => (value === BUILTIN ? [partsRow(sc.parts, n)] : []);
  const tabs = [];
  const says = [];
  if (p.dashboard) {
    const ambient = known(sc.id);
    tabs.push(
      { id: 'ambient', label: k('xmenu_scr_ambient'), value: name(ambient), rows: [sceneChoice(`ambient-${n}`, 'xmenu_scr_ambient', 'xmenu_scr_ambient_sub', ambient, list, '', act('ambient')), ...parts(ambient)] },
      { id: 'dash', label: k('xmenu_scr_dash_bg'), value: k('xmenu_scr_theme_bg'), rows: [{ kind: 'button', id: `dashBg-${n}`, label: k('xmenu_scr_dash_bg'), sub: k('xmenu_scr_dash_bg_sub'), action: k('xmenu_do_change'), act: open('settings:appearance'), closes: true }] },
    );
    says.push({ label: k('xmenu_scr_ambient_short'), value: name(ambient) });
  }
  if (!p.dashboard || screens.length === 1) {
    const wallName = wall ? name(wall) : k('xmenu_scr_own_wallpaper');
    // The minutes are the same on every screen; which scene runs is this screen's.
    const saverRows = [saverRow(sc)];
    if (sc.saverMinutes > 0) saverRows.push(sceneChoice(`saver-${n}`, 'xmenu_scr_saver', 'xmenu_scr_saver_sub', saver, list, 'xmenu_scr_no_saver', act('saver')), ...parts(saver));
    tabs.push(
      { id: 'wall', label: k('xmenu_scr_wallpaper'), value: wallName, rows: [sceneChoice(`wall-${n}`, 'xmenu_scr_wallpaper', 'xmenu_scr_wallpaper_sub', wall, list, 'xmenu_scr_own_wallpaper', act('wallpaper')), ...parts(wall)] },
      { id: 'saver', label: k('xmenu_scr_saver'), value: saver ? name(saver) : k('xmenu_scr_no_saver'), rows: saverRows },
    );
    if (!p.dashboard) says.push({ label: k('xmenu_scr_wallpaper'), value: wallName });
  }
  return { key: m.key, label: screenLabel(m, i, screens), width: m.width, height: m.height, x: m.x, y: m.y, dashboard: p.dashboard, says, tabs };
}

function screenViews(st) {
  const sc = st.scene || {};
  const screens = screensOf(st);
  const list = sceneList(st.scenes, sc.canvases, sc.themes);
  const active = String(sc.dashboard || '');
  const plan = ScreenSceneModel.plan({ settings: settingsOf(sc), displays: screens.map((m) => ({ id: m.key })), active, noDashboard: !active });
  return screens.map((m, i) => screenView(m, i, plan[i], { sc, list, screens }));
}

// What the Classic scene shows, the same switches as Settings, Ambient.
function partsRow(parts, n) {
  const shown = SCENE_PARTS.filter((p) => !parts || parts[p] !== false);
  const flip = (p) => SCENE_PARTS.filter((x) => shown.includes(x) !== (x === p));
  return {
    kind: 'choice', id: `sceneParts-${n}`, multi: true, label: k('ambient_classic_widgets'),
    options: SCENE_PARTS.map((p) => ({ value: p, label: k('lock_widget_' + p), on: shown.includes(p),
      act: run({ type: 'desktopScene', show: flip(p).join(',') || 'none' }) })),
  };
}

// Chosen but not running: without this the screen shows the built-in scene and
// nothing says why.
function sceneWaitRow() {
  return { kind: 'button', id: 'sceneWait', label: k('xmenu_scene_wait'), sub: k('ambient_scene_wait'), action: k('ambient_scene_approve'), act: open('settings:ambient'), closes: true };
}

// Where more of them come from: the Store, Bit, the Maker, or the editor in Settings.
function moreScenesRow() {
  return {
    kind: 'button', id: 'moreScenes', label: k('xmenu_more_scenes'), sub: k('xmenu_sub_more_scenes'),
    actions: [
      { label: k('xmenu_store'), act: open('store:ambient'), closes: true },
      { label: k('xmenu_bit'), icon: 'bit', act: open('chat'), closes: true },
      { label: k('xmenu_own_maker'), act: run({ type: 'openUrl', url: MAKER_URL }) },
      { label: k('xmenu_scene_editor'), act: open('settings:ambient'), closes: true },
    ],
  };
}

// Never, 5, 15, 30 minutes, plus the one chosen in Settings if it is another.
function savers(current) {
  const list = ['0', '5', '15', '30'];
  const cur = String(current || 0);
  return list.includes(cur) ? list : list.concat(cur);
}

function saverRow(sc) {
  return {
    kind: 'choice', id: 'saver', label: k('xmenu_saver_after'), sub: k('xmenu_saver_after_sub'), value: String(sc.saverMinutes || 0),
    options: savers(sc.saverMinutes).map((m) => ({ value: m, label: m === '0' ? k('xmenu_never') : k('xmenu_minutes', { n: Number(m) }),
      act: run({ type: 'desktopSaver', minutes: m }) })),
  };
}

// The screens with their tabs, and under them the theme. What is kept for every screen
// (more scenes, the screensaver's minutes, the theme) is carried by the screens row, and
// `tune` is what search finds inside it.
function lookSection(st) {
  const theme = themeRow();
  if (!(st.probes || {}).scene) return [theme];
  const sc = st.scene || {};
  const views = screenViews(st);
  const more = moreScenesRow();
  const rows = (sc.waiting || []).length ? [sceneWaitRow()] : [];
  if (!views.length) return [theme, ...rows, more, saverRow(sc)];
  rows.push({ kind: 'screens', id: 'sceneScreens', label: k('xmenu_scr_map'), sub: k('xmenu_scr_map_sub'), screens: views, more, theme, tune: [theme, saverRow(sc), more] });
  return rows;
}

module.exports = { lookSection, screenViews };
