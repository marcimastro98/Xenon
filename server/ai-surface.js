'use strict';

// Where Xenon AI is answering from. 'screen' is Bit on the main screen in
// "widgets only" (js/screen-bit.js): there is no dashboard there, so a client
// action that only a dashboard can carry out (open Settings, change the theme,
// turn a page, compose with Genesis...) would do nothing while the model said
// "done". Those answer `needs_dashboard` instead, and the model says so.
// 'sheet' is the chat in the Xenon menu's window (js/sheet-chat.js): the dashboard's
// code runs there, so what changes settings works, what needs its tiles does not.

// Client actions that still mean something on the screen surface: closing the
// panel is Bit's own, the refreshes have nothing on screen to refresh, and What's
// New has its own stage there (js/screen-release.js).
const SCREEN_OK = new Set(['close_ai_panel', 'refresh_tasks', 'refresh_calendar', 'refresh_timers', 'open_whats_new']);

// The screen's list, plus what the page in the menu's window can carry out.
const SHEET_OK = new Set([
  ...SCREEN_OK, 'open_settings', 'open_sparks_shop', 'open_store_entry', 'change_theme', 'customize_appearance',
  'create_dashboard_style', 'configure_preferences', 'set_media_source',
]);

const NEEDS_DASHBOARD = Object.freeze({
  ok: false,
  error: 'needs_dashboard',
  hint: 'No dashboard is open: Xenon runs as widgets only on this PC. Say plainly that this needs the dashboard, '
    + 'and that the card on the screen opens it, or that you can switch to the dashboard for good (set_usage_mode).',
});

const SHEET_NEEDS_DASHBOARD = Object.freeze({
  ok: false,
  error: 'needs_dashboard',
  hint: 'This chat is in the Xenon menu window, with no dashboard behind it. Say plainly that this needs the dashboard, '
    + 'and that "Open the dashboard" in the menu opens it.',
});

// Performance Mode runs with no dashboard too (js/driver-perf.js): on the
// screen surface these become the user's answer to it (perf-screen.js).
const SCREEN_PERF = Object.freeze({ optimize_performance: 'optimize', restore_performance: 'restore' });

// The sheet is told apart by its address: `panel=sheet` stays on it (dashboard-open.js).
function surfaceOf(body, referer) {
  if (body && body.surface === 'screen') return 'screen';
  try {
    return new URL(referer).searchParams.get('panel') === 'sheet' ? 'sheet' : '';
  } catch (e) {
    return '';
  }
}

// The answer for a dashboard-only client action on this surface, or null when
// the action may run as usual.
function clientActionRefusal(fnName, surface, widgetsOnly = false) {
  if (screenPerfChoice(fnName, surface, widgetsOnly)) return null;
  if (surface === 'screen') return SCREEN_OK.has(fnName) ? null : { ...NEEDS_DASHBOARD };
  if (surface === 'sheet') return SHEET_OK.has(fnName) ? null : { ...SHEET_NEEDS_DASHBOARD };
  return null;
}

// The Performance Mode choice a client action stands for on this surface, or ''.
// With a dashboard open somewhere, the sheet leaves them to it.
function screenPerfChoice(fnName, surface, widgetsOnly = false) {
  const driven = surface === 'screen' || (surface === 'sheet' && widgetsOnly);
  return driven && Object.prototype.hasOwnProperty.call(SCREEN_PERF, fnName) ? SCREEN_PERF[fnName] : '';
}

module.exports = { surfaceOf, clientActionRefusal, screenPerfChoice, SCREEN_OK, SHEET_OK };
