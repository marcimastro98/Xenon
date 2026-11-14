'use strict';
// Where Twitch is asked: the sign-in, token and revoke addresses, the Helix API, the scopes the
// user grants, and the check that a link shown to the user is https.

// User-token scopes. clips/marker/ad/title/game need the first three; the chat
// message, chat-mode and shoutout actions need the last three. Adding a scope
// here means already-connected users must reconnect once to grant it (a refresh
// alone never widens scope) — surfaced as 'not_connected'/403 until they do.
//
// user:read:follows is the newest and the only one that is not for the streamer:
// it is what lets the watching widget list the channels you follow that are on
// air. It is the one place where "reconnect once" is a real cost to an existing
// user, so followedChannels() below tells a token that lacks it apart from a
// token that is simply dead, and the widget says which of the two it is.
const SCOPES = 'clips:edit channel:manage:broadcast channel:edit:commercial user:write:chat moderator:manage:chat_settings moderator:manage:shoutouts user:read:follows';
const DEVICE_URL = 'https://id.twitch.tv/oauth2/device';
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const REVOKE_URL = 'https://id.twitch.tv/oauth2/revoke';
const HELIX = 'https://api.twitch.tv/helix';

// A link the dashboard shows as-is must be https, never javascript: or data:.
function httpsOnly(u, fallback) {
  try { const x = new URL(String(u || '')); return x.protocol === 'https:' ? x.href : fallback; } catch { return fallback; }
}

module.exports = { SCOPES, DEVICE_URL, TOKEN_URL, REVOKE_URL, HELIX, httpsOnly };
