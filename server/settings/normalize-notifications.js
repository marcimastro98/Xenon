// Checks the saved settings of notifications, calls and the paired phone.

// Master notifications switch. `enabled` (default ON) is the global gate that can
// silence every source at once and stop the background watchers; `popups` (default
// ON) keeps the feeds but suppresses on-screen toasts; `sounds` (default ON)
// toggles the client-played pop-up cue. All round-trip as booleans.
function normalizeNotifications(value) {
  const v = value && typeof value === 'object' ? value : {};
  // `quiet` is the do-not-disturb mode: 'auto' (default) holds routine pop-ups
  // back while the screen is immersive (a full-screen ambient scene, game mode),
  // 'always' holds them back the whole time, 'off' never does. Errors, warnings,
  // reminders and finished timers are never held back on any setting.
  const quiet = (v.quiet === 'off' || v.quiet === 'always') ? v.quiet : 'auto';
  // `onScreen`: in "Solo widget" (no dashboard window) the same pop-ups show in
  // a small click-through window on the main screen (/screen-alerts).
  return { enabled: v.enabled !== false, popups: v.popups !== false, sounds: v.sounds !== false, quiet, onScreen: v.onScreen !== false };
}

// Discord notification mirroring — privacy-touching, so OFF by default (unknown/
// malformed collapses to off). `hide` masks each notification's text until tapped.
function normalizeDiscordNotifications(value) {
  const v = value && typeof value === 'object' ? value : {};
  return { enabled: v.enabled === true, hide: v.hide === true };
}

// Windows notification mirroring — same privacy posture as the Discord feed
// (off by default, unknown collapses to off). `excluded` is the per-app mute
// list: {id, name} entries where id is the app's AUMID (or its display name
// when the toast carries no AUMID) — a bounded known-key rebuild, never a
// spread of persisted input.
function normalizeWindowsNotifications(value) {
  const v = value && typeof value === 'object' ? value : {};
  const excluded = [];
  if (Array.isArray(v.excluded)) {
    for (const e of v.excluded.slice(0, 100)) {
      const id = String((e && e.id) || '').slice(0, 200).trim();
      if (!id) continue;
      excluded.push({ id, name: String((e && e.name) || '').slice(0, 200) });
    }
  }
  // `toast` (default on) is client-presentation only — round-tripped so it
  // survives a restart; the server never acts on it.
  return { enabled: v.enabled === true, hide: v.hide === true, toast: v.toast !== false, excluded };
}

// Incoming calls. Strict opt-in, and for two reasons rather than one: it takes
// over the screen when it fires, and for every source except Discord it reads
// the notification mirror, which is itself opt-in.
//
// `disabledApps` rather than an allowlist on purpose — a stored allowlist would
// freeze the app table at the version the user first enabled it, so an app
// added in a later release would silently never ring for them.
function normalizeCalls(value) {
  const v = value && typeof value === 'object' ? value : {};
  const disabledApps = [];
  if (Array.isArray(v.disabledApps)) {
    for (const id of v.disabledApps.slice(0, 40)) {
      const s = String(id || '').trim().slice(0, 40);
      if (s && !disabledApps.includes(s)) disabledApps.push(s);
    }
  }
  // The user's own entries. `match` is what a notification's app name/AUMID is
  // substring-tested against, so it is cleaned but never interpreted — it never
  // becomes a path, a command or a regex.
  const apps = [];
  if (Array.isArray(v.apps)) {
    for (const raw of v.apps.slice(0, 20)) {
      const a = raw && typeof raw === 'object' ? raw : {};
      const id = String(a.id || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
      if (!id) continue;
      const match = [];
      if (Array.isArray(a.match)) {
        for (const m of a.match.slice(0, 10)) {
          const s = String(m || '').trim().slice(0, 80);
          if (s) match.push(s);
        }
      }
      if (!match.length) continue;          // an entry that matches nothing is noise
      if (apps.some(e => e.id === id)) continue;
      apps.push({ id, name: String(a.name || id).slice(0, 60), match });
    }
  }
  return {
    enabled: v.enabled === true,
    push: v.push !== false,
    sound: v.sound !== false,
    disabledApps,
    apps,
  };
}

// The paired phone (phonebook, call log, dialler, live call state). Strict
// opt-in, and the reason is privacy rather than cost: switching it on reads the
// user's entire address book off their phone and keeps it in this process. That
// is not something to inherit from a default.
//
// `ring` is separate from `enabled` because the two are different asks. Someone
// may well want the phonebook and the dialler on a second screen without that
// screen taking itself over every time the phone rings.
function normalizePhone(value) {
  const v = value && typeof value === 'object' ? value : {};
  return {
    enabled: v.enabled === true,
    ring: v.ring !== false,
    // Message text masked until tapped. ON by default, unlike the notification
    // mirror's equivalent, and for a specific reason: an SMS inbox is where
    // one-time login codes live, and this widget sits on a screen in the open.
    hide: v.hide !== false,
  };
}

module.exports = {
  normalizeNotifications, normalizeDiscordNotifications, normalizeWindowsNotifications,
  normalizeCalls, normalizePhone,
};
