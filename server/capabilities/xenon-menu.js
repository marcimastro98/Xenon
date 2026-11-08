'use strict';
// The Xenon menu (plan §20): one menu, two places. Over the main screen when a
// native shell can draw it (screen-menu.js), otherwise as a panel on the open
// dashboards. Opening it reads nothing and changes nothing; every row inside
// runs its own capability.
//
// deps.menu (screen-menu.js): show({ section }), close(), toggle({ section }), get()

const { SECTIONS, cleanSection } = require('../screen-menu.js');

const MODES = Object.freeze(['toggle', 'open', 'close']);
// Screens a key opens by themselves, in the menu's window (js/sheet-page.js).
const SCREENS = Object.freeze(['chat', 'store', 'sparks', 'settings', 'mixer', 'whatsnew']);

function available(menu) {
  return !!(menu && typeof menu.show === 'function');
}

function run(d, action) {
  const menu = d && d.menu;
  if (!available(menu)) return { ok: false, error: 'unavailable' };
  const mode = MODES.includes(action && action.mode) ? action.mode : 'toggle';
  const next = { section: action && action.section };
  const where = mode === 'open' ? menu.show(next) : mode === 'close' ? menu.close() : menu.toggle(next);
  // The dashboard panel keeps no state here: its section is the one asked for.
  return { ok: true, where, section: where === 'dashboard' ? cleanSection(next.section) : menu.get().section };
}

// Without a window to open it in, the menu is the way there.
function openScreen(d, action) {
  const menu = d && d.menu;
  if (!available(menu)) return { ok: false, error: 'unavailable' };
  const screen = action && action.screen;
  if (!SCREENS.includes(screen)) return { ok: false, error: 'bad_screen' };
  if (menu.showSheet({ open: screen }) === 'screen') return { ok: true, where: 'screen', screen };
  return { ok: true, where: menu.show({}), screen };
}

module.exports = { MODES, SCREENS, SECTIONS, available, run, openScreen };
