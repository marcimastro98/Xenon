// Sends one Discord notification to the dashboards with its number.

const { broadcastSSE } = require('../http/sse-clients.js');
const calls = require('../calls.js');
const lighting = require('../lighting.js');
const { discordNotifWanted } = require('../settings/notification-switches.js');
const { DISCORD_NOTIF_MAX } = require('./notification-limit.js');
const { discordMirror } = require('./mirrored.js');
const { discordNotif } = require('./notif-seq-state.js');

function pushDiscordNotification(n) {
  if (!n || typeof n !== 'object') return;
  // Calls read this BEFORE the feed's own opt-in. The Discord notification feed
  // (the widget's Notifications tab) and the ring are two different features
  // with two different switches, and a user who wants the call card should not
  // have to turn on a message feed to get it. Both still need the RPC scope,
  // which is what actually delivers the event.
  try { calls.onDiscordNotification(n); } catch { /* a ring never breaks the feed */ }
  if (!discordNotifWanted()) return;   // toggled off mid-watch → drop until re-arm
  const item = Object.assign({ id: ++discordNotif.seq, at: Date.now() }, n);
  discordMirror.notifications.push(item);
  if (discordMirror.notifications.length > DISCORD_NOTIF_MAX) discordMirror.notifications = discordMirror.notifications.slice(-DISCORD_NOTIF_MAX);
  broadcastSSE('discord_notification', item);
  // Fire the "notification" RGB event effect (no-op unless the user enabled it in
  // Settings → Illuminazione → Effetti evento). Same entry point as timer/reminder.
  try { lighting.onEvent('notification'); } catch { /* lighting optional */ }
}

module.exports = { pushDiscordNotification };
