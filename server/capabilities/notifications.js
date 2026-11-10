'use strict';
// Notifications and Do not disturb (hubSettings.notifications), read and
// changed by Bit or a Deck key: the same switches as Settings, Notifications.
//
// deps.notifications (injected):
//   { get() → { enabled, popups, sounds, quiet }, set(change) → Promise<same>
//     (writes under the settings lock) }

const QUIET = Object.freeze(['auto', 'always', 'off']);
const SWITCHES = Object.freeze(['enabled', 'popups', 'sounds']);

function usable(n) {
  return !!(n && typeof n.get === 'function' && typeof n.set === 'function');
}

const view = (s) => ({ enabled: s.enabled, popups: s.popups, sounds: s.sounds, quiet: s.quiet });

// Do not disturb: "always" holds routine pop-ups back the whole time, "auto"
// (the default) only during a game or a full-screen scene, "off" never.
// "toggle" switches between always and auto.
async function setQuiet(d, action) {
  const n = d && d.notifications;
  if (!usable(n)) return { ok: false, error: 'unavailable' };
  const mode = action && action.mode;
  if (mode !== 'toggle' && !QUIET.includes(mode)) return { ok: false, error: 'bad_mode', choices: ['toggle', ...QUIET] };
  const quiet = mode === 'toggle' ? (n.get().quiet === 'always' ? 'auto' : 'always') : mode;
  return { ok: true, ...view(await n.set({ quiet })) };
}

// "on"/"off" per switch; "keep", a missing or an unknown value changes nothing.
function changeFrom(action) {
  const change = {};
  for (const k of SWITCHES) {
    if (action[k] === 'on') change[k] = true;
    else if (action[k] === 'off') change[k] = false;
  }
  return change;
}

async function setSwitches(d, action) {
  const n = d && d.notifications;
  if (!usable(n)) return { ok: false, error: 'unavailable' };
  const change = changeFrom(action || {});
  const state = Object.keys(change).length ? await n.set(change) : n.get();
  return { ok: true, ...view(state) };
}

// The app a notification came from, to the front or started
// (notification-open/). Only the feed's own id travels; none = the newest.
async function openApp(d, action) {
  const opener = d && d.notificationOpen;
  if (!opener || typeof opener.open !== 'function') return { ok: false, error: 'unavailable' };
  const id = action && action.id != null ? String(action.id) : '';
  if (id && !/^[1-9][0-9]{0,14}$/.test(id)) return { ok: false, error: 'no_notification' };
  return opener.open(id || 'latest');
}

module.exports = { setQuiet, setSwitches, openApp, changeFrom, QUIET };
