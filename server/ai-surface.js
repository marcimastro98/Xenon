'use strict';

// Where Xenon AI is answering from. 'screen' is Bit on the main screen in
// "widgets only" (js/screen-bit.js): there is no dashboard there, so a client
// action that only a dashboard can carry out (open Settings, change the theme,
// turn a page, compose with Genesis...) would do nothing while the model said
// "done". Those answer `needs_dashboard` instead, and the model says so.

// Client actions that still mean something on the screen surface: closing the
// panel is Bit's own, and the refreshes have nothing on screen to refresh.
const SCREEN_OK = new Set(['close_ai_panel', 'refresh_tasks', 'refresh_calendar', 'refresh_timers']);

const NEEDS_DASHBOARD = Object.freeze({
  ok: false,
  error: 'needs_dashboard',
  hint: 'No dashboard is open: Xenon runs as widgets only on this PC. Say plainly that this needs the dashboard, '
    + 'and that the user can open it from the tray icon or ask you to switch to the dashboard (set_usage_mode).',
});

// Performance Mode runs with no dashboard too (js/driver-perf.js): on the
// screen surface these become the user's answer to it (perf-screen.js).
const SCREEN_PERF = Object.freeze({ optimize_performance: 'optimize', restore_performance: 'restore' });

function surfaceOf(body) {
  return body && body.surface === 'screen' ? 'screen' : '';
}

// The answer for a dashboard-only client action on this surface, or null when
// the action may run as usual.
function clientActionRefusal(fnName, surface) {
  if (surface !== 'screen' || SCREEN_OK.has(fnName) || screenPerfChoice(fnName, surface)) return null;
  return { ...NEEDS_DASHBOARD };
}

// The Performance Mode choice a client action stands for on this surface, or ''.
function screenPerfChoice(fnName, surface) {
  return surface === 'screen' && Object.prototype.hasOwnProperty.call(SCREEN_PERF, fnName) ? SCREEN_PERF[fnName] : '';
}

module.exports = { surfaceOf, clientActionRefusal, screenPerfChoice, SCREEN_OK };
