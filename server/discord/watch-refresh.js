// Holds the Discord watch only while a dashboard is open and an account is signed in.

const { sseClients, broadcastSSE } = require('../http/sse-clients.js');
const { pushDiscordNotification } = require('./notif-push.js');
const { discordLink } = require('./link.js');
const { discordWatch, stopDiscordWatch } = require('./watch-stop.js');
const { discordArm } = require('./watch-arm-state.js');
const { discordMirror } = require('./mirrored.js');

async function refreshDiscordWatch() {
  // This is called from several async triggers that can overlap (SSE connect/close,
  // the /voice mount read, login/logout). Serialize them: without the guard two
  // concurrent calls could both pass `!discordWatch.stop` and start two watches,
  // orphaning one socket. The dirty flag re-evaluates once against fresh state so a
  // transition (e.g. logout) that lands mid-flight is never lost.
  if (discordArm.arming) { discordArm.dirty = true; return; }
  discordArm.arming = true;
  try {
    do {
      discordArm.dirty = false;
      const st = await discordLink.rpc.status().catch(() => null);
      // The call card's Answer button is only real while the account is linked,
      // so the flag it reads follows the same status this watch is armed on.
      discordMirror.linkedForCalls = !!(st && st.configured && st.connected);
      const want = !!(st && st.configured && st.connected) && sseClients.size > 0;
      if (want && !discordWatch.stop) {
        discordArm.login = (st && st.login) || '';
        discordWatch.stop = discordLink.rpc.watchVoice((voice) => {
          // Derive `connected` (account linked) from the pushed state, not a hardcoded
          // true — otherwise a token revoked mid-watch would leave the widget stuck
          // looking linked. A dropped pipe still reports connected:true (linked, just
          // offline); a token failure reports connected:false (→ "connect" notice).
          // `notif` tells the widget's Notifications tab whether the feed is live or
          // the token needs a re-link ('scope_missing').
          broadcastSSE('discord', { connected: !!(voice && voice.connected), login: discordArm.login, voice, notif: discordLink.rpc.notifStatus() });
        }, pushDiscordNotification);
      } else if (!want && discordWatch.stop) {
        stopDiscordWatch();
        // Clear the widget's live state so it reflects the linked-but-idle / unlinked view.
        broadcastSSE('discord', { connected: !!(st && st.connected), login: (st && st.login) || '', voice: null, notif: 'off' });
      }
    } while (discordArm.dirty);
  } finally { discordArm.arming = false; }
}

module.exports = { refreshDiscordWatch };
