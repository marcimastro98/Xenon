'use strict';
// Spotify integration provider — Authorization Code + PKCE flow. Unlike Twitch /
// YouTube (OAuth Device Code Flow), Spotify's Web API does NOT support device
// code, so we use the redirect flow against the loopback server: tap Connect →
// open Spotify's consent page → it redirects to /stream/spotify/callback → we
// exchange the code (with the PKCE verifier) for tokens. PKCE means NO client
// secret — the user only pastes their Client ID, exactly like Twitch.
//
// SECURITY: tokens live in the SERVER-ONLY runtime file (stream-tokens.json),
// never in settings.json and never sent to the browser (the client only sees
// { connected, login, configured }). The client_id stays out of committed source
// — server.js injects it from env / stream-config.json. Never log a token. The
// OAuth `state` parameter (unguessable, tied to our own /login) is the CSRF guard
// for the GET callback, so the callback is deliberately NOT in CSRF_MUTATION_PATHS.
//
// ROBUSTNESS: every method resolves to a plain result object and never throws.

const path = require('path');
const { makeCredsNormalizer, createTokenStore } = require('./streaming/stream-common');

const normalizeStreamSpotify = makeCredsNormalizer({ login: 120, userId: 64 });

const { makeBackoff } = require('./streaming/spotify-backoff.js');

const { makeSignIn } = require('./streaming/spotify-sign-in.js');

const { makeRequests } = require('./streaming/spotify-requests.js');

const { makePlayer } = require('./streaming/spotify-player.js');

const { makeQueue } = require('./streaming/spotify-queue.js');

const { makeSearch } = require('./streaming/spotify-search.js');

const { makeControls } = require('./streaming/spotify-controls.js');

const { makeQuery } = require('./streaming/spotify-query.js');

// deps (all optional, injectable for tests):
//   clientId — the Spotify app Client ID (public; PKCE needs no secret)
//   tokensFile — server-only token store (defaults to ./stream-tokens.json)
//   fetch — fetch implementation (defaults to global fetch)
function createSpotifyProvider(deps) {
  const d = deps || {};
  const _fetch = d.fetch || ((...a) => fetch(...a));
  const _sleep = d.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const clientId = d.clientId || '';
  const tokensFile = d.tokensFile || path.join(__dirname, 'stream-tokens.json');
  const { creds, patchCreds, clearCreds, persistToken, makeGetAccessToken } =
    createTokenStore({ tokensFile, storeKey: 'spotify', normalize: normalizeStreamSpotify });


  const { rateLimited, retryAfterMs, noteRateLimit, fetchMe } = makeBackoff({ _fetch });

  const {
    configured, buildAuthUrl, exchangeCode, refresh,
  } = makeSignIn({ _fetch, clientId, creds, patchCreds, clearCreds, persistToken, rateLimited, noteRateLimit, fetchMe });

  const playerState = {
    // Authenticated Web API call. Returns { ok, status, data } (data is null on a
    // 204 No Content, which most control endpoints return on success). Returns a
    // `rate_limited` error while the 429 cooldown is active, without hitting Spotify.
    // Micro-cache for the full player snapshot. The Media strip (5s) and the widget
    // (6s) poll /me/player independently, and paused playback costs a 2nd call (the
    // currently-playing fallback) — so with both surfaces open we can hit ~40 Spotify
    // calls/min and flirt with the 429 breaker. A short TTL + in-flight dedup collapses
    // that to at most one upstream call per ~2.5s no matter how many surfaces poll; the
    // client's 1s local ticker interpolates progress between snapshots. Any mutating
    // request (play/pause/next/seek/volume) drops the cache so control feels instant.
    _playerCache: null,      // { at, data }
    _playerPending: null,    // in-flight promise shared by concurrent callers
    _playerGen: 0,           // bumped on every mutation; a read tagged with a stale gen won't cache
  };



  const getAccessToken = makeGetAccessToken(refresh);   // only keeps `refresh` for when a token runs out: nothing is asked of Spotify here

  const {
    queryCacheClear, queryCacheGet, queryCachePut, apiRequest, classify403, apiResult, spotifyId,
    clampInt,
  } = makeRequests({ _fetch, rateLimited, retryAfterMs, noteRateLimit, playerState, getAccessToken });

  const {
    getPlaylists, getDevices, isSaved, lastLiked, getPlayer,
  } = makePlayer({ playerState, apiRequest });

  // Lazily backfill a missing display name. If the `/me` read at link time failed
  // (a transient network blip, or the account not yet confirmed by the app), we
  // still hold a valid token but `login` is empty — the card would read "Connected
  // as —" forever and only a full reconnect could clear it. Re-read the profile
  // here, throttled, so it self-heals on the next status poll without any action.
  let _meRetryAt = 0;
  async function status() {
    const c = await creds();
    if (c.accessToken && !c.login && Date.now() - _meRetryAt > 15000) {
      _meRetryAt = Date.now();
      try {
        const token = await getAccessToken();
        const me = token ? await fetchMe(token) : null;
        if (me && me.name) {
          const nc = await patchCreds({ login: me.name, userId: me.id });
          return { connected: !!nc.accessToken, login: nc.login, configured: configured() };
        }
      } catch { /* fall through to the token-only state */ }
    }
    return { connected: !!c.accessToken, login: c.login, configured: configured() };
  }

  // Spotify has no token-revocation endpoint for the PKCE flow; clearing the
  // stored creds fully disconnects the account from this app's perspective.
  async function logout() { await clearCreds(); queryCacheClear(); return { ok: true }; }

  const { normalizeQueue, getQueue } = makeQueue({ apiRequest, getPlayer });



  const {
    query,
  } = makeQuery({ retryAfterMs, queryCacheGet, queryCachePut, apiRequest, spotifyId, clampInt, getPlayer, normalizeQueue });

  const {
    search, playSearch, queueSearch, playUri,
  } = makeSearch({ apiRequest, apiResult, clampInt });


  const {
    saveCurrent, playPlaylist, setShuffle, transferDevice, transferToId, playPause, computerIds,
    playWhenReady, skipNext, skipPrev, setRepeat, toggleLike, setVolume, seek, runAction,
  } = makeControls({ _sleep, apiRequest, classify403, apiResult, spotifyId, clampInt, getPlaylists, getDevices, isSaved, lastLiked, playUri });




  return {
    configured, status, logout, buildAuthUrl, exchangeCode, getAccessToken,
    getQueue, getPlaylists, getDevices, getPlayer, search, query, playUri,
    normalizeQueue,   // pure, and exported so the wrap rules can be pinned without an account
    saveCurrent, playPlaylist, playSearch, queueSearch, setShuffle, transferDevice, transferToId,
    playPause, skipNext, skipPrev, setRepeat, toggleLike, setVolume, seek, runAction,
    computerIds, playWhenReady,
  };
}

module.exports = { createSpotifyProvider, normalizeStreamSpotify };
