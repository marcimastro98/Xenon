'use strict';
// How this PC uses Xenon: the dashboard, only widgets on the screen, or both
// (js/usage-mode.js owns the values). The native shell reads the choice when
// its main window loads (route `/` in server.js), so this file only changes it.
//
// deps (injected):
//   host     { available(), monitors() } — the native shell reported itself and its
//            screens (layers-host.js): without it there is no main window to switch
//   settings { setUsageMode(mode, surface?), setScreenAlerts(on) } — write the
//            settings under the settings lock

const UsageMode = require('../js/usage-mode.js');
const { screensOf } = require('../menu-tune.js');

function available(host) {
  return !!(host && typeof host.available === 'function' && host.available());
}

// The screen the dashboard goes to, as the first-run question stores it
// (js/usage-ask-plan.js); the dashboard tells the shell (SurfacePicker.reconcileShell).
// By number, 1 being the main screen, the order the Xenon menu shows them in.
function surfaceFor(host, screen) {
  const screens = screensOf({ monitors: typeof host.monitors === 'function' ? host.monitors() : [] });
  const m = /^[1-9]\d?$/.test(String(screen)) ? screens[Number(screen) - 1] : null;
  if (!m) return { error: { ok: false, error: 'bad_screen', choices: screens.map((_, i) => String(i + 1)) } };
  return { surface: { kind: 'screen', monitor: m.key, label: m.name || '', asked: true } };
}

async function setMode(d, action) {
  const mode = UsageMode.normalize(action.mode);
  if (!mode) return { ok: false, error: 'bad_mode', choices: UsageMode.MODES.slice() };
  if (!available(d.host) || !d.settings || typeof d.settings.setUsageMode !== 'function') {
    return { ok: false, error: 'unavailable' };
  }
  const wanted = action.screen !== undefined && action.screen !== '' && mode !== 'widgets';
  const place = wanted ? surfaceFor(d.host, action.screen) : {};
  if (place.error) return place.error;
  const saved = await d.settings.setUsageMode(mode, place.surface);
  return saved ? { ok: true, mode: saved, ...(place.surface ? { screen: String(action.screen) } : {}) } : { ok: false, error: 'failed' };
}

// "Widgets only" shows the dashboard's pop-ups in a small window on the main
// screen (js/screen-alerts.js); hubSettings.notifications.onScreen turns it off.
async function setScreenAlerts(d, action) {
  if (action.alerts !== 'on' && action.alerts !== 'off') return { ok: false, error: 'bad_alerts', choices: ['on', 'off'] };
  if (!available(d.host) || !d.settings || typeof d.settings.setScreenAlerts !== 'function') {
    return { ok: false, error: 'unavailable' };
  }
  const saved = await d.settings.setScreenAlerts(action.alerts === 'on');
  return typeof saved === 'boolean' ? { ok: true, alerts: saved ? 'on' : 'off' } : { ok: false, error: 'failed' };
}

module.exports = { available, setMode, setScreenAlerts };
