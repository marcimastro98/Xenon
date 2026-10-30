'use strict';
// How this PC uses Xenon: the dashboard, only widgets on the screen, or both
// (js/usage-mode.js owns the values). The native shell reads the choice when
// its main window loads (route `/` in server.js), so this file only changes it.
//
// deps (injected):
//   host     { available() } — the native shell reported itself (layers-host.js):
//            without it there is no main window to switch
//   settings { setUsageMode(mode), setScreenAlerts(on) } — write the settings
//            under the settings lock

const UsageMode = require('../js/usage-mode.js');

function available(host) {
  return !!(host && typeof host.available === 'function' && host.available());
}

async function setMode(d, action) {
  const mode = UsageMode.normalize(action.mode);
  if (!mode) return { ok: false, error: 'bad_mode', choices: UsageMode.MODES.slice() };
  if (!available(d.host) || !d.settings || typeof d.settings.setUsageMode !== 'function') {
    return { ok: false, error: 'unavailable' };
  }
  const saved = await d.settings.setUsageMode(mode);
  return saved ? { ok: true, mode: saved } : { ok: false, error: 'failed' };
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
