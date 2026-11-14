'use strict';
// The optional log of what the Discord app sends, switched on for a diagnosis.

// ── Live RPC diagnostic ─────────────────────────────────────────────────────
// Discord's RPC documents no incoming-call event: the event table is READY,
// VOICE_*, SPEAKING_*, MESSAGE_*, NOTIFICATION_CREATE, ACTIVITY_* and
// ENTITLEMENT_*, and nothing else. The Calls feature is therefore built on the
// hypothesis that a ringing DM raises NOTIFICATION_CREATE carrying a message of
// type 3 (CALL) — which is true of Discord's data model but has not been
// observed on a live ring here, because verifying it needs a linked account and
// somebody to actually call.
//
// So: set XENON_DISCORD_RPC_DEBUG=1, have someone call you, and read the log.
// Every dispatch is printed with the fields that matter and NOTHING else — no
// message content, no author, no attachments. The point is to learn which event
// fires and what its message type is, not to mirror a private conversation into
// a log file.
const RPC_DEBUG = process.env.XENON_DISCORD_RPC_DEBUG === '1';

function logDispatch(evt, payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const msg = p.message && typeof p.message === 'object' ? p.message : null;
  const parts = ['[discord-rpc] dispatch ' + String(evt)];
  if (typeof p.channel_id === 'string') parts.push('channel=' + p.channel_id);
  if (msg && msg.type != null) parts.push('message.type=' + JSON.stringify(msg.type));
  // Lengths, not text: enough to tell an empty call notification from a worded
  // one without putting what somebody wrote into a log.
  if (typeof p.title === 'string') parts.push('title.len=' + p.title.length);
  if (typeof p.body === 'string') parts.push('body.len=' + p.body.length);
  if (msg) parts.push('message.keys=' + Object.keys(msg).slice(0, 20).join('|'));
  console.log(parts.join(' '));
}

module.exports = { RPC_DEBUG, logDispatch };
