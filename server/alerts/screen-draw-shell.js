'use strict';
// Drawing on the screen where the capture engine has no sheet of its own (macOS,
// Linux): the native shell opens a see-through page over the main screen
// (/draw, js/screen-draw-page.js). The server only keeps whether it is open and
// tells the pages over SSE `screen_draw`; the dashboard, or the "widgets only"
// driver, turns that into a `draw:` surface for the shell (js/layers-shell.js).
// Runtime only: a restart closes it.
//
// deps:
//   host       layers-host.js: draws() says a shell that can open the sheet is running
//   broadcast  ({ drawing }) → void, the SSE push

function createScreenDrawShell({ host, broadcast } = {}) {
  let on = false;

  function available() {
    return !!(host && typeof host.draws === 'function' && host.draws());
  }

  // Open only while a shell can show it: one that quit takes the sheet with it.
  function get() {
    return on && available();
  }

  function set(next) {
    const want = next === true && available();
    if (want !== on) {
      on = want;
      if (typeof broadcast === 'function') broadcast({ drawing: on });
    }
    return on;
  }

  return { available, get, set };
}

module.exports = { createScreenDrawShell };
