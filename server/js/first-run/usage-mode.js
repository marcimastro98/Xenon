'use strict';

// How this PC uses Xenon (native app): the full dashboard, only widgets on the
// screen plus the menu, or both. One owner for the values: the dashboard's
// settings (window.UsageMode), the server's normalizer and route `/` (require),
// the capability and the tests all read this file.
//
// '' = not set yet. It behaves like 'dashboard', so nothing moves: a new install
// answers the first-run question, someone updating gets 'both' without being asked.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.UsageMode = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const MODES = Object.freeze(['dashboard', 'widgets', 'both']);

  function normalize(value) {
    return MODES.includes(value) ? value : '';
  }

  // The main window loads only the small driver page instead of the dashboard.
  function widgetsOnly(value) {
    return normalize(value) === 'widgets';
  }

  // The menu key and the main-screen extras are on (everything but 'dashboard';
  // not asked yet keeps today's behaviour, which already offers the widgets).
  function mainScreenOn(value) {
    return normalize(value) !== 'dashboard';
  }

  // The answer the first-run question recommends. The dashboard earns its place where it
  // has a screen of its own, an Edge or a second monitor; a PC whose only screen is the
  // Edge has no desktop to put widgets on.
  function recommended({ screens = 0, edge = false } = {}) {
    if (edge && screens === 1) return 'dashboard';
    return edge || screens >= 2 ? 'both' : 'widgets';
  }

  return Object.freeze({ MODES, normalize, widgetsOnly, mainScreenOn, recommended });
});
