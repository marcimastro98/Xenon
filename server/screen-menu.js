'use strict';
// The Xenon menu over the main screen (plan §20): the native shell opens a page
// over everything (/menu, js/screen-menu-page.js) while it is open. The server
// keeps only whether it is open and on which section, and tells the pages over
// SSE `screen_menu`; the dashboard, or the "widgets only" driver, turns that into
// a `menu:` surface for the shell (js/layers-shell.js). Runtime only: a restart
// closes it. Where no shell can draw it, opening it asks the open dashboards to
// show the same menu as a panel instead (SSE `xenon_menu_panel`).
//
// deps:
//   host       layers-host.js: menus() says a shell that can draw the menu is running
//   broadcast  ({ open, section }) → void, the SSE push for the shell surface
//   panel      ({ section }) → void, the SSE push that opens the dashboard panel

const SECTIONS = ['now', 'widgets', 'overlay', 'capture', 'keys', 'look', 'mode'];

function cleanSection(value) {
  return SECTIONS.includes(value) ? value : 'now';
}

function createScreenMenu({ host, broadcast, panel } = {}) {
  let open = false;
  let section = 'now';

  function available() {
    return !!(host && typeof host.menus === 'function' && host.menus());
  }

  function push() {
    if (typeof broadcast === 'function') broadcast({ open, section });
  }

  // Open only while a shell can show it: one that quit takes the menu with it.
  function get() {
    return { open: open && available(), section };
  }

  // → 'screen' (over the main screen), 'dashboard' (panel asked of the open
  // dashboards) or 'closed'.
  function show(next = {}) {
    const wanted = cleanSection(next.section);
    if (available()) {
      if (!open || wanted !== section) {
        open = true;
        section = wanted;
        push();
      }
      return 'screen';
    }
    if (typeof panel === 'function') panel({ section: wanted });
    return 'dashboard';
  }

  function close() {
    if (open) {
      open = false;
      push();
    }
    return 'closed';
  }

  function toggle(next = {}) {
    return get().open ? close() : show(next);
  }

  return { available, get, show, close, toggle };
}

module.exports = { createScreenMenu, SECTIONS, cleanSection };
