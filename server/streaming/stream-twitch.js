'use strict';
// Twitch integration provider — OAuth Device Code Flow (no client secret, ideal
// for the touchscreen: the user authorises on their phone), token persistence +
// refresh, and a small authenticated Helix helper for the action layer (Phase 2).
//
// SECURITY: tokens live in a SERVER-ONLY runtime file (stream-tokens.json), NOT
// in settings.json — settings.json is round-tripped to the browser via /settings
// (which would both expose the tokens and let a client save clobber them). Tokens
// never leave the server; the client only ever sees { connected, login }. Never
// log a token.
//
// ROBUSTNESS: every method resolves to a plain result object and never throws, so
// a Twitch outage or an expired/garbage token degrades the Deck dispatcher and
// status polling to a clean { ok:false } instead of crashing the request.

const path = require('path');
const { makeCredsNormalizer, createTokenStore } = require('./stream-common');

// The Twitch app client_id is CONFIGURATION, never committed source. server.js
// resolves it from the `TWITCH_CLIENT_ID` env var or a gitignored
// `server/stream-config.json` and passes it as `deps.clientId`. Do NOT hardcode a
// real id here — this stays empty so nothing app-identifying lives in the repo.
// When unset the provider reports `configured:false` and every call returns
// { ok:false, error:'no_client_id' }.
const TWITCH_CLIENT_ID = '';

const { HELIX } = require('./twitch-endpoints.js');

// Coerce a stored credentials blob into a clean, fully-populated shape so callers
// can destructure unconditionally. Unknown keys are dropped.
const normalizeStreamTwitch = makeCredsNormalizer({ login: 120, userId: 60 });

const { makeSignIn } = require('./twitch-sign-in.js');

const { makeBroadcast } = require('./twitch-broadcast.js');

// deps (all optional, injectable for tests):
//   clientId    — override the shipped client_id
//   tokensFile  — path to the server-only token store (defaults to ./stream-tokens.json)
//   fetch       — fetch implementation (defaults to global fetch)
function createTwitchProvider(deps) {
  const d = deps || {};
  const _fetch = d.fetch || ((...a) => fetch(...a));
  const clientId = d.clientId != null ? d.clientId : TWITCH_CLIENT_ID;
  const tokensFile = d.tokensFile || path.join(__dirname, '..', 'stream-tokens.json');
  // Server-only token store (shared plumbing with the other providers).
  const { creds, patchCreds, clearCreds, persistToken, makeGetAccessToken } =
    createTokenStore({ tokensFile, storeKey: 'twitch', normalize: normalizeStreamTwitch });

  const {
    configured, startDeviceLogin, pollDeviceToken, refresh, status, logout,
  } = makeSignIn({ _fetch, clientId, creds, patchCreds, clearCreds, persistToken, dropCaches });

  // A valid access token, refreshing if it's within the skew window, or '' when
  // not connected / refresh failed.
  const getAccessToken = makeGetAccessToken(refresh);

  // Authenticated Helix request used by the Phase 2 action layer. Resolves to
  // { ok, status, data } or { ok:false, error:'not_connected'|'network' }.
  async function helix(method, pathWithQuery, bodyObj) {
    const token = await getAccessToken();
    if (!token) return { ok: false, error: 'not_connected' };
    const init = { method, headers: { 'Client-Id': clientId, Authorization: 'Bearer ' + token } };
    if (bodyObj) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(bodyObj); }
    try {
      const res = await _fetch(HELIX + pathWithQuery, init);
      const data = await res.json().catch(() => null);
      return { ok: res.ok, status: res.status, data };
    } catch { return { ok: false, error: 'network' }; }
  }

  // The broadcaster_id the action layer needs (from the stored login), or ''.
  async function broadcasterId() { return (await creds()).userId || ''; }

  // ── Phase 2 action methods (Deck dispatcher) ──────────────────────────────
  // All require the channel to be LIVE; Twitch answers 404 otherwise, which we
  // surface as 'not_live' so the key can flash with a meaningful reason.
  function mapActionError(r) {
    if (r.error) return r.error;                       // 'not_connected' / 'network'
    if (r.status === 401) return 'not_connected';      // token rejected
    if (r.status === 404) return 'not_live';
    return 'http_' + (r.status || '?');
  }

  const {
    createClip, createMarker, runAd, setTitle, setGame, sendChat, shoutout, setChatMode, streamStatus,
  } = makeBroadcast({ helix, broadcasterId, mapActionError });


  const {
    watchCache, followedChannels, topChannels, searchChannels, chanIdCache, sendChatTo, channelEmotes,
  } = makeChannels({ helix, broadcasterId, mapActionError });
  // Dropped on login and logout: a second account must never be shown the first
  // one's followed channels.
  function dropCaches() { watchCache.clear(); chanIdCache.clear(); }





  return { startDeviceLogin, pollDeviceToken, getAccessToken, status, logout, helix, configured, broadcasterId, createClip, createMarker, runAd, setTitle, setGame, sendChat, shoutout, setChatMode, streamStatus, followedChannels, topChannels, searchChannels, sendChatTo, channelEmotes };
}

const { streamMatches, mergeSearch } = require('./twitch-search-match.js');

const { makeChannels } = require('./twitch-channels.js');

module.exports = { createTwitchProvider, normalizeStreamTwitch, streamMatches, mergeSearch };
