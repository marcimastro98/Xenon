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
// Kinds: heading, tile, status, toggle, choice, place, widget, pages, key, mode, button, add, guide, screens.
// Nothing here carries a path, a window title or a file name.

const LayersModel = require('./js/layers-model.js');
const { SECTIONS } = require('./screen-menu.js');
const { k, run, open, comboText, cornerOf, secondsText } = require('./menu-rows.js');
const { nowSection, agoText } = require('./menu-now.js');
const { widgetsSection, addChoices } = require('./menu-widgets.js');
const { lookSection } = require('./menu-look.js');
const { captureSection } = require('./menu-capture.js');
const { keysSection } = require('./menu-keys.js');

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
