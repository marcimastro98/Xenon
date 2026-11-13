// Which notification sources are switched on in the settings: the master switch, Discord, and
// the mirror of the PC's own notifications.

const { hub } = require('./current.js');

// Discord voice integration via the local RPC/IPC channel (needs the Discord
// desktop client + the user's own app credentials). `let` so it can be re-created
// when the user saves credentials in Settings → Streaming (see saveStreamConfig).
// Tokens persist to the same server-only stream-tokens.json.
// Read at authorize/subscribe time, so the login consent and the live watch both
// follow the current Settings toggle without re-creating the provider.
// The master switch (Settings → Notifiche). When OFF, every notification source is
// silenced and its background watcher stops — one place to kill it all.
function notificationsEnabled() {
  const n = hub.settings && hub.settings.notifications;
  return !n || n.enabled !== false;   // default ON
}
function discordNotifWanted() {
  const dn = hub.settings && hub.settings.discordNotifications;
  return notificationsEnabled() && !!(dn && dn.enabled);
}
// Whether the RPC token needs the notifications SCOPE, which is a different
// question from whether the notification FEED is on. A ringing Discord call
// arrives as NOTIFICATION_CREATE and there is no other event for it, so Calls
// needs the subscription even when the widget's message feed is switched off.
// Both still go through the same one-time re-link, and pushDiscordNotification
// keeps the feed itself gated on its own switch.
function discordNotifScopeWanted() {
  if (discordNotifWanted()) return true;
  const c = hub.settings && hub.settings.calls;
  return !!(c && c.enabled);
}

// ── Windows notification mirror (the Notifications tile) ────────────────────
// Same lifecycle discipline as the Discord/HA watches: the notifications-serve
// child (native helper or notifications.ps1) runs only while the feature is
// enabled AND a dashboard is open. winnotif.js owns the child + feed buffer.
function winNotifWanted() {
  if (!notificationsEnabled()) return false;   // master switch off → no mirror child
  const wn = hub.settings && hub.settings.windowsNotifications;
  if (wn && wn.enabled) return true;
  // Calls read the same child: outside Discord, an OS notification is the only
  // thing that can tell us a call is ringing (Windows exposes no toast XML and
  // no "incoming call" flag — measured). So enabling Calls starts the reader
  // even with the Notifications tile switched off, and the Settings copy says
  // so rather than leaving the user to discover that one switch moved another.
  const c = hub.settings && hub.settings.calls;
  return !!(c && c.enabled);
}

module.exports = {
  notificationsEnabled, discordNotifWanted, discordNotifScopeWanted, winNotifWanted,
};
