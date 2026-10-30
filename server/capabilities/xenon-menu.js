'use strict';
// The Xenon menu (plan §20): one menu, two places. Over the main screen when a
// native shell can draw it (screen-menu.js), otherwise as a panel on the open
// dashboards. Opening it reads nothing and changes nothing; every row inside
// runs its own capability.
//
// deps.menu (screen-menu.js): show({ section }), close(), toggle({ section }), get()

const { SECTIONS, cleanSection } = require('../screen-menu.js');

const MODES = Object.freeze(['toggle', 'open', 'close']);

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

module.exports = { MODES, SECTIONS, available, run };
