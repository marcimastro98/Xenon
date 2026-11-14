'use strict';
// Signing Xenon in to the Discord app on this PC: the addresses, the permissions asked for, and
// a failed sign-in said plainly.

const API = 'https://discord.com/api';
const TOKEN_URL = API + '/oauth2/token';
const REVOKE_URL = API + '/oauth2/token/revoke';
// The redirect only has to MATCH one registered on the user's Discord app — the
// RPC AUTHORIZE returns the code over IPC, there's no browser hop — so we ask the
// user to register exactly this value and reuse it for the token exchange.
const REDIRECT_URI = 'http://localhost';
// rpc.voice.read/write drive the voice settings; identify names the account for
// the status line. These are owner-usable without Discord whitelisting the app.
const SCOPES = ['rpc', 'rpc.voice.read', 'rpc.voice.write', 'identify'];
// Extra scope for NOTIFICATION_CREATE (the notification feed). Requested ONLY when
// the user has opted into notification mirroring — users who leave it off never
// authorize it — so enabling the feature later means a one-time re-link.
const NOTIF_SCOPE = 'rpc.notifications.read';

// Does the stored grant cover the notification feed?
//
// THREE answers, and the third is the point. A token issued before v4.11.6 has
// no recorded scope, and "we never wrote it down" is not the same as "it was not
// granted" — treating it as missing would put a re-link warning in front of every
// user whose notifications work fine. Only a scope list we actually have, that
// does not contain the notification scope, is a confirmed 'missing'.
//
// Worth knowing eagerly because of how Discord behaves: a scope not asked for at
// link time cannot be added later by reconnecting — AUTHORIZE reuses the existing
// authorization and returns a code for what was already granted. So this is the
// difference between telling someone before they wait, and after.
function notifScopeState(scope) {
  const list = String(scope || '').trim();
  if (!list) return 'unknown';
  return list.split(/\s+/).includes(NOTIF_SCOPE) ? 'granted' : 'missing';
}

// Cap a Discord-provided error message before it travels to the settings note or
// the server log. Plain text only — the client renders it via textContent.
function errDetail(m) { return String(m == null ? '' : m).trim().slice(0, 200); }

// Classify a login-time close frame. Discord rejects a wrong/foreign Client ID by
// closing the pipe (code 4000 "Invalid Client ID") — surface that as its own error
// instead of the generic "Discord closed the connection", and keep the message so
// the settings note can show Discord's actual words.
function loginCloseError(data) {
  const detail = errDetail(data && data.message);
  const e = new Error(/invalid client/i.test(detail) ? 'invalid_client_id' : 'discord_closed');
  if (detail) e.detail = detail;
  return e;
}

// Classify an AUTHORIZE rejection. An explicit user "deny" stays authorize_denied;
// anything else becomes authorize_failed and carries Discord's own message —
// without this every real cause collapsed into a blind "try again".
//
// invalid_scope gets its own code because it's the one users actually hit, and
// its causes are documented and specific: of the scopes we ask for, only `rpc`
// is gated — it is "only allowed for the application owner or whitelisted
// testers" and the app "must not have the EMBEDDED flag set" (i.e. not an
// Activity). rpc.voice.read/write and rpc.notifications.read are public, so
// they are never the culprit. The redirect is NOT one of the causes: AUTHORIZE
// takes no redirect_uri (it is validated only at the token exchange), so a
// redirect problem surfaces as token_exchange_failed instead — don't send
// people to the Redirects page for this one.
function authorizeError(payload) {
  const detail = errDetail(payload && payload.message);
  const denied = !detail || /denied|declined|cancel/i.test(detail);
  const code = /invalid_scope/i.test(detail) ? 'invalid_scope' : (denied ? 'authorize_denied' : 'authorize_failed');
  const e = new Error(code);
  if (detail) e.detail = detail;
  return e;
}

module.exports = {
  API, TOKEN_URL, REVOKE_URL, REDIRECT_URI, SCOPES, NOTIF_SCOPE, notifScopeState, errDetail,
  loginCloseError, authorizeError,
};
