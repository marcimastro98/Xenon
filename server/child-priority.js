'use strict';

const os = require('os');

// Background readers give way to what the user is running. On a free core nothing
// changes: this only decides who waits when every core is busy, as in a heavy game.
// Never for what must answer on time: the shortcut listener, PresentMon, the capture
// engine. A pid of 0 means this very process to the OS, and the server must not slow.
function lowerPriority(pid) {
  if (!pid) return;
  try { os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* gone, or not allowed */ }
}

module.exports = { lowerPriority };
