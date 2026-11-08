'use strict';
// The Xenon menu's content (plan §20): one description of the six sections,
// read by both places that show the menu (over the main screen, /menu, and the
// dashboard panel), so neither can have a row the other lacks. Pure: server.js
// gathers the state, this turns it into rows; js/xenon-menu.js draws them.
//
// A row is { kind, id, label, ... }. Texts are { key, vars? } (an i18n key),
// { text } (a name the user chose) or a list of those, shown joined by commas. Every change a row makes is an `act`:
//   { run: <Deck action> }   POST /actions/run, the capability validates it
//   { open: <verb> }         gallery, settings:<cat>, dashboard, bit
// Kinds: heading, tile, status, toggle, choice, place, widget, pages, key, mode, button, add, guide.
// Nothing here carries a path, a window title or a file name.

const LayersModel = require('./js/layers-model.js');
const { SECTIONS } = require('./screen-menu.js');
const { k, run, open, comboText, cornerOf, secondsText } = require('./menu-rows.js');
const { nowSection, agoText } = require('./menu-now.js');
const { widgetsSection, addChoices, MAKER_URL } = require('./menu-widgets.js');
const { BUILTIN, SCENE_PARTS, sceneList } = require('./capabilities/desktop-scene.js');
const { captureSection } = require('./menu-capture.js');
const { screenLabel, screensOf } = require('./menu-tune.js');
const { keysSection } = require('./menu-keys.js');

function lookSection(st) {
  const rows = [{ kind: 'button', id: 'theme', label: k('xmenu_theme'), sub: k('xmenu_theme_sub'), action: k('xmenu_do_change'), act: open('settings:appearance'), closes: true }];
  if ((st.probes || {}).scene) {
    const sc = st.scene || {};
    rows.push({ kind: 'toggle', id: 'wallpaper', label: k('xmenu_wallpaper'), sub: k('xmenu_wallpaper_sub'), on: sc.wallpaper === true,
      acts: { on: run({ type: 'desktopWallpaper', mode: 'on' }), off: run({ type: 'desktopWallpaper', mode: 'off' }) } });
    const scene = sceneRow(sc, st.scenes);
    rows.push(scene);
    if (scene.value === BUILTIN) rows.push(partsRow(sc.parts));
    if (sc.waiting) rows.push(sceneWaitRow());
    rows.push(...screensRow(sc, st));
    rows.push(moreScenesRow());
    rows.push({
      kind: 'choice', id: 'saver', label: k('xmenu_saver'), sub: k('xmenu_saver_sub'), value: String(sc.saverMinutes || 0),
      options: savers(sc.saverMinutes).map((m) => ({ value: m, label: m === '0' ? k('xmenu_never') : k('xmenu_minutes', { n: Number(m) }),
        act: run({ type: 'desktopSaver', minutes: m }) })),
    });
  }
  return rows;
}

// What the wallpaper and the screensaver show. A scene that was uninstalled falls
// back to the built-in one (js/ambient-resolve.js), so that is what the row says.
function sceneRow(sc, packages) {
  const list = sceneList(packages, sc.canvases, sc.themes);
  const value = list.some((s) => s.id === sc.id) ? sc.id : BUILTIN;
  const name = (s) => (s.id === BUILTIN ? k('ambient_scene_builtin') : s.name ? { text: s.name } : k('ambient_editor_untitled'));
  return {
    kind: 'choice', id: 'scene', label: k('xmenu_scene'), sub: k('xmenu_sub_scene'), value, live: true,
    options: list.map((s) => ({ value: s.id, label: name(s), act: run({ type: 'desktopScene', scene: s.id }) })),
  };
}

// What the Classic scene shows, the same switches as Settings, Ambient.
function partsRow(parts) {
  const shown = SCENE_PARTS.filter((p) => !parts || parts[p] !== false);
  const flip = (p) => SCENE_PARTS.filter((x) => shown.includes(x) !== (x === p));
  return {
    kind: 'choice', id: 'sceneParts', multi: true, label: k('ambient_classic_widgets'),
    options: SCENE_PARTS.map((p) => ({ value: p, label: k('lock_widget_' + p), on: shown.includes(p),
      act: run({ type: 'desktopScene', show: flip(p).join(',') || 'none' }) })),
  };
}

// Any mix of the screens; Automatic is the ones without the dashboard. Taking the
// last one away goes back to it. With one screen there is nothing to choose.
function screensRow(sc, st) {
  const screens = screensOf(st);
  if (screens.length < 2) return [];
  const chosen = screens.filter((m) => (sc.screens || []).includes(m.key));
  const pick = (list) => run({ type: 'desktopScreens', screens: list.length ? list.map((m) => screens.indexOf(m) + 1).join(',') : 'auto' });
  const flip = (m) => screens.filter((x) => chosen.includes(x) !== (x === m));
  return [{
    kind: 'choice', id: 'sceneScreens', multi: true, label: k('xmenu_screens'), sub: k('xmenu_sub_screens'),
    options: [
      { value: 'auto', label: k('xmenu_screens_auto'), on: !chosen.length, act: chosen.length ? pick([]) : null },
      ...screens.map((m, i) => ({ value: m.key, label: screenLabel(m, i, screens), on: chosen.includes(m), act: pick(flip(m)) })),
    ],
  }];
}

// Chosen but not running: without this the wallpaper shows the built-in scene and
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

const BUILDERS = Object.freeze({
  now: nowSection, widgets: widgetsSection, capture: captureSection,
  keys: keysSection, look: lookSection, mode: modeSection,
});
const ICONS = Object.freeze({ now: 'bolt', widgets: 'widgets', capture: 'camera', keys: 'keyboard', look: 'palette', mode: 'screens' });

// → { menuKey, sections: [{ id, icon, title, sub, rows }] }
function compose(state) {
  const st = { ...state, layers: LayersModel.normalize(state && state.layers), keys: (state && state.keys) || {} };
  return {
    menuKey: comboText(st.keys.menu),
    sections: SECTIONS.map((id) => ({
      id, icon: ICONS[id], title: k('xmenu_sec_' + id), sub: k('xmenu_sec_' + id + '_sub'), rows: BUILDERS[id](st),
    })),
  };
}

module.exports = { compose, addChoices, cornerOf, secondsText, agoText };
