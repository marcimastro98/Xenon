// The notification settings: reminders, Discord and Windows notifications.
'use strict';

function updateNotifications(field, enabled) {
  // `quiet` is the one non-boolean here — a three-way select, normalized (and
  // defaulted back to 'auto' on anything unexpected) by normalizeNotifications.
  if (field === 'quiet') {
    const cur = hubSettings.notifications || {};
    hubSettings = normalizeSettings({ ...hubSettings, notifications: { ...cur, quiet: String(enabled || '') } });
    saveHubSettings();
    syncNotificationsControls();
    setSettingsStatus('settings_saved', 'ok');
    return;
  }
  if (field !== 'enabled' && field !== 'popups' && field !== 'sounds' && field !== 'onScreen') return;
  const cur = hubSettings.notifications || {};
  hubSettings = normalizeSettings({ ...hubSettings, notifications: { ...cur, [field]: !!enabled } });
  saveHubSettings();
  syncNotificationsControls();
  setSettingsStatus('settings_saved', 'ok');
}

function syncNotificationsControls() {
  const n = hubSettings.notifications || {};
  const enabled = n.enabled !== false;
  const en = $('settings-notif-enabled');
  if (en) en.checked = enabled;
  const pop = $('settings-notif-popups');
  if (pop) { pop.checked = n.popups !== false; pop.disabled = !enabled; }
  // The pop-up sub-toggle is meaningless while notifications are off.
  const row = $('settings-notif-popups-row');
  if (row) row.classList.toggle('is-disabled', !enabled);
  // "Widgets only" pop-ups: only the native app can drop the dashboard window
  // (as the usage mode row). Not gated by the master switch: they also carry
  // timers and captures, which never were notifications.
  const caps = window.__XENON_NATIVE_CAPS__ || {};
  const onScreenRow = $('settings-notif-onscreen-row');
  if (onScreenRow) onScreenRow.hidden = !(window.__XENON_NATIVE__ === true && caps.layers === true);
  const onScreen = $('settings-notif-onscreen');
  if (onScreen) onScreen.checked = n.onScreen !== false;
  // Sound sub-toggle: gated by the master switch, like the pop-ups.
  const snd = $('settings-notif-sounds');
  if (snd) { snd.checked = n.sounds !== false; snd.disabled = !enabled; }
  const sndRow = $('settings-notif-sounds-row');
  if (sndRow) sndRow.classList.toggle('is-disabled', !enabled);
  // Do-not-disturb. Also meaningless with the master switch off, so it follows
  // the same gating as the two above.
  const quiet = $('settings-notif-quiet');
  if (quiet) {
    quiet.value = (n.quiet === 'off' || n.quiet === 'always') ? n.quiet : 'auto';
    quiet.disabled = !enabled;
    // The native <select> is hidden behind the custom dropdown, so setting .value
    // alone leaves the visible label on the old option.
    if (typeof quiet._csSync === 'function') quiet._csSync();
  }
  const quietRow = $('settings-notif-quiet-row');
  if (quietRow) quietRow.classList.toggle('is-disabled', !enabled);
  // Windows notification mirroring — the same two switches the Notifications
  // tile carries (the tile also owns the muted-apps list). The server gates the
  // mirror child on the master switch too, so mirror that gating here; "hide
  // content" additionally needs the mirror itself to be on.
  const wn = hubSettings.windowsNotifications || {};
  const wnOn = wn.enabled === true;
  const win = $('settings-winnotif');
  if (win) { win.checked = wnOn; win.disabled = !enabled; }
  const winRow = $('settings-winnotif-row');
  if (winRow) winRow.classList.toggle('is-disabled', !enabled);
  const winHide = $('settings-winnotif-hide');
  if (winHide) { winHide.checked = wn.hide === true; winHide.disabled = !enabled || !wnOn; }
  const winHideRow = $('settings-winnotif-hide-row');
  if (winHideRow) winHideRow.classList.toggle('is-disabled', !enabled || !wnOn);
  syncCallsControls(enabled);
  // The phone is NOT gated on the notification master switch: it reads the
  // phonebook over Bluetooth and gets its ring from the OS, so neither half
  // depends on notification mirroring being on.
  syncPhoneControls();
}

// ── Discord notification mirroring (Settings → Streaming, Discord card) ──
// The toggles live inside the dynamically-built streaming card (streaming-page.js),
// which reads hubSettings.discordNotifications at build time — so there's no
// static control to sync here; saving is enough.
function updateDiscordNotifications(field, enabled) {
  const cur = hubSettings.discordNotifications || {};
  hubSettings = normalizeSettings({ ...hubSettings, discordNotifications: { ...cur, [field]: !!enabled } });
  saveHubSettings();
  setSettingsStatus('settings_saved', 'ok');
}

// ── Windows notification mirroring (Settings → Notifiche + the tile) ─────
// The enable/hide switches live in BOTH places (the tile also owns the
// muted-apps list); this is their single write path. `value` is a boolean for
// enabled/hide and the whole {id,name} array for excluded —
// normalizeWindowsNotifications bounds it all.
function updateWindowsNotifications(field, value) {
  const cur = hubSettings.windowsNotifications || {};
  hubSettings = normalizeSettings({ ...hubSettings, windowsNotifications: { ...cur, [field]: value } });
  saveHubSettings();
  syncNotificationsControls();
  // Repaint the tile so a toggle flipped in Settings lands there immediately —
  // the server's SSE state push would arrive a beat later, and only once it has
  // actually started the mirror child. Idempotent; the tile's own controls call
  // this too and paint again harmlessly.
  if (window.NotificationsWidget && typeof window.NotificationsWidget.renderWidgets === 'function') {
    window.NotificationsWidget.renderWidgets();
  }
  setSettingsStatus('settings_saved', 'ok');
}
