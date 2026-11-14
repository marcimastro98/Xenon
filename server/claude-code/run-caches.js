'use strict';
// The two answers the Claude Code runner works out once and remembers: where the program is,
// and which options it accepts.

const runCaches = {
  // ── locating the claude executable ───────────────────────────────────────────
  // The native installer drops a real .exe, which spawns cleanly with an argv
  // array. An npm install instead leaves a .cmd shim on Windows, and running THAT
  // would need a shell — so rather than relax the invariant we resolve the shim's
  // underlying cli.js and run it through node, which stays argv-clean.
  exec: null,
  // What the installed CLI accepts, read once from its own --help (argv, no
  // shell). An older Claude Code without --effort or one of the modes simply
  // does not get that option offered.
  options: null,
};

module.exports = { runCaches };
