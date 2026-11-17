'use strict';
// The Xenon menu's content (plan §20): one description of its sections,
// read by both places that show the menu (over the main screen, /menu, and the
// dashboard panel), so neither can have a row the other lacks. Pure: server.js
// gathers the state, this turns it into rows; js/xenon-menu.js draws them.
//
// A row is { kind, id, label, ... }. Texts are { key, vars? } (an i18n key),
// { text } (a name the user chose) or a list of those, shown joined by commas. Every change a row makes is an `act`:
//   { run: <Deck action> }   POST /actions/run, the capability validates it
//   { open: <verb> }         gallery, settings:<cat>, dashboard, bit
// Kinds: heading, tile, status, toggle, choice, place, widget, pages, key, mode, button, add, guide, screens, home.
// Nothing here carries a path, a window title or a file name.

const LayersModel = require('./js/layers-model.js');
const { SECTIONS } = require('./screen-menu.js');
const { k, comboText, cornerOf, secondsText } = require('./menu-rows.js');
const { nowSection, agoText } = require('./menu-now.js');
const { addChoices } = require('./menu-widgets.js');
const { screensSection } = require('./menu-screens.js');
const { captureSection } = require('./menu-capture.js');
const { keysSection } = require('./menu-keys.js');

const BUILDERS = Object.freeze({ screens: screensSection, now: nowSection, capture: captureSection, keys: keysSection });
const ICONS = Object.freeze({ screens: 'screens', now: 'bolt', capture: 'camera', keys: 'keyboard' });

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
