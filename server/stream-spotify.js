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
const crypto = require('crypto');
const { makeCredsNormalizer, createTokenStore, FORM } = require('./stream-common');

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';

// Read playback + queue/devices, control playback (add-to-queue, shuffle, transfer,
// start a playlist), read the user's playlists, and save tracks to Liked Songs.
// Playback CONTROL requires Spotify Premium; reads work on free accounts too.
const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'user-library-read',
  'user-library-modify',
].join(' ');

const PENDING_TTL_MS = 10 * 60 * 1000;   // an unfinished authorize expires after 10 min

const normalizeStreamSpotify = makeCredsNormalizer({ login: 120, userId: 64 });

// base64url without padding — RFC 7636 PKCE verifier/challenge and the state nonce.
function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// deps (all optional, injectable for tests):
//   clientId — the Spotify app Client ID (public; PKCE needs no secret)
//   tokensFile — server-only token store (defaults to ./stream-tokens.json)
//   fetch — fetch implementation (defaults to global fetch)
function createSpotifyProvider(deps) {
  const d = deps || {};
  const _fetch = d.fetch || ((...a) => fetch(...a));
  const clientId = d.clientId || '';
  const tokensFile = d.tokensFile || path.join(__dirname, 'stream-tokens.json');
  const { creds, patchCreds, clearCreds, persistToken, makeGetAccessToken } =
    createTokenStore({ tokensFile, storeKey: 'spotify', normalize: normalizeStreamSpotify });

  // Short-lived PKCE state between /login (authorize) and /callback (token
  // exchange), keyed by the opaque `state`: { verifier, redirectUri, at }. In
  // memory only — an unfinished login simply expires; nothing sensitive persists.
  const pending = new Map();
  function sweepPending() {
    const now = Date.now();
    for (const [k, v] of pending) if (now - v.at > PENDING_TTL_MS) pending.delete(k);
  }

  function configured() { return !!clientId; }

  // Build the Spotify authorize URL. `redirectUri` must EXACTLY match one
  // registered in the user's Spotify app and is reused verbatim at token exchange.
  // Returns { ok, authUrl } and stashes the PKCE verifier under the state nonce.
  function buildAuthUrl(redirectUri) {
    if (!configured()) return { ok: false, error: 'no_client_id' };
    if (!redirectUri) return { ok: false, error: 'no_redirect' };
    sweepPending();
    const verifier = b64url(crypto.randomBytes(48));               // 64-char verifier
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));
    pending.set(state, { verifier, redirectUri, at: Date.now() });
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      scope: SCOPES,
      code_challenge_method: 'S256',
      code_challenge: challenge,
      redirect_uri: redirectUri,
      state,
      // Force the consent screen so a RECONNECT actually re-grants scopes. Without
      // it Spotify silently reuses an existing authorization — an old token that
      // predates a scope we added (e.g. user-library-read for Liked Songs) would
      // never pick up the new permission.
      show_dialog: 'true',
    });
    return { ok: true, authUrl: AUTH_URL + '?' + params.toString(), state };
  }

  // Exchange the authorization code for tokens, validating state → verifier. The
  // redirect_uri sent here must equal the one used at authorize time (Spotify
  // checks it), so we reuse the value stashed with the pending state.
  async function exchangeCode(code, state) {
    if (!configured()) return { ok: false, error: 'no_client_id' };
    const p = state && pending.get(state);
    if (!p) return { ok: false, error: 'bad_state' };       // unknown/expired/forged → reject
    pending.delete(state);
    if (!code) return { ok: false, error: 'no_code' };
    try {
      const res = await _fetch(TOKEN_URL, {
        method: 'POST', headers: FORM,
        body: new URLSearchParams({
          grant_type: 'authorization_code', code, redirect_uri: p.redirectUri,
          client_id: clientId, code_verifier: p.verifier,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || !data.access_token) return { ok: false, error: 'token_failed' };
      await persistToken(data);
      const me = await fetchMe(data.access_token);
      if (me) await patchCreds({ login: me.name, userId: me.id });
      return { ok: true, connected: true, login: me ? me.name : '' };
    } catch { return { ok: false, error: 'network' }; }
  }

  async function refresh() {
    const c = await creds();
    if (!c.refreshToken) return false;
    if (rateLimited()) return false;   // honour the 429 breaker — the token endpoint is rate-limited too
    try {
      const res = await _fetch(TOKEN_URL, {
        method: 'POST', headers: FORM,
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.refreshToken, client_id: clientId }),
      });
      if (res.status === 429) { noteRateLimit(res); return false; }   // rate-limited: KEEP creds, retry after cooldown
      const data = await res.json().catch(() => null);
      if (res.ok && data && data.access_token) { await persistToken(data); return true; }
      // Only a DEFINITIVE auth rejection should disconnect the account. Spotify
      // returns HTTP 400 invalid_grant when the refresh token is truly revoked or
      // expired; a 5xx or any transient failure must NOT wipe the login — doing so
      // logged users out on a mere hiccup or rate-limit and forced a full re-auth
      // (the "Spotify player disappeared" bug under heavy request load).
      const invalidGrant = res.status >= 400 && res.status < 500 &&
        data && String(data.error || '').toLowerCase() === 'invalid_grant';
      if (invalidGrant) await clearCreds();
      return false;
    } catch { return false; }   // network error: keep creds, retry later
  }

  const getAccessToken = makeGetAccessToken(refresh);

  // ── 429 circuit breaker ─────────────────────────────────────────────────────
  // Spotify rate-limits over a rolling window and answers 429 with a Retry-After
  // (seconds). The dashboard polls several endpoints every few seconds, so once we
  // trip the limit, blindly retrying keeps us pinned in the penalty box forever —
  // every call (even /me) 429s and the integration looks permanently broken. When we
  // see a 429 we back off for Retry-After and short-circuit every call until then,
  // so we stop adding load and the limit clears on its own. Dev-mode apps have low
  // limits, so this matters most there.
  let _rateLimitedUntil = 0;
  function rateLimited() { return Date.now() < _rateLimitedUntil; }
  function noteRateLimit(res) {
    let secs = 5;
    try { const h = res && res.headers && res.headers.get('retry-after'); const n = h && parseInt(h, 10); if (n) secs = Math.min(3600, Math.max(1, n)); } catch { /* default */ }
    _rateLimitedUntil = Date.now() + secs * 1000;
  }

  async function fetchMe(token) {
    if (rateLimited()) return null;
    try {
      const res = await _fetch(API + '/me', { headers: { Authorization: 'Bearer ' + token } });
      if (res.status === 429) { noteRateLimit(res); return null; }
      const data = await res.json().catch(() => null);
      return (data && data.id) ? { id: data.id, name: data.display_name || data.id } : null;
    } catch { return null; }
  }

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
  let _playerCache = null;      // { at, data }
  let _playerPending = null;    // in-flight promise shared by concurrent callers
  let _playerGen = 0;           // bumped on every mutation; a read tagged with a stale gen won't cache
  const PLAYER_TTL_MS = 4000;   // upstream cap: a 204 (paused) costs a 2nd call, so with two surfaces polling this bounds /me/player to ~30 Spotify calls/min; the 1s client ticker hides the coarser snapshot

  async function apiRequest(method, pathWithQuery, bodyObj) {
    if (method !== 'GET') { _playerCache = null; _playerGen++; }   // a mutation invalidates the snapshot AND any in-flight read
    if (rateLimited()) return { ok: false, status: 429, error: 'rate_limited' };
    const token = await getAccessToken();
    if (!token) return { ok: false, error: 'not_connected' };
    const init = { method, headers: { Authorization: 'Bearer ' + token } };
    if (bodyObj != null) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(bodyObj); }
    try {
      const res = await _fetch(API + pathWithQuery, init);
      if (res.status === 429) { noteRateLimit(res); return { ok: false, status: 429, error: 'rate_limited' }; }
      const data = (res.status === 204) ? null : await res.json().catch(() => null);
      return { ok: res.ok, status: res.status, data };
    } catch { return { ok: false, error: 'network' }; }
  }

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
  async function logout() { await clearCreds(); return { ok: true }; }

  // ── Reads for the dashboard widget (trimmed, client-safe shapes) ───────────
  // Smallest album image for a compact list; the full array is widest-first.
  function trackLite(t) {
    if (!t || typeof t !== 'object') return null;
    const imgs = (t.album && Array.isArray(t.album.images)) ? t.album.images : [];
    return {
      name: t.name || '',
      uri: t.uri || '',
      artist: Array.isArray(t.artists) ? t.artists.map(a => a && a.name).filter(Boolean).join(', ') : '',
      image: imgs.length ? (imgs[imgs.length - 1].url || '') : '',
    };
  }

  async function getQueue() {
    const r = await apiRequest('GET', '/me/player/queue');
    if (!r.ok || !r.data) return { ok: false, error: r.error || 'no_playback' };
    // Spotify's queue is the REAL upcoming order only when playback has a context
    // (playlist/album/artist). Playing a loose "random" track — a single, Liked
    // Songs, or radio — makes this endpoint return autoplay GUESSES that routinely
    // don't match what actually plays next. Flag that (reliable:false) so the UI can
    // annotate the list instead of presenting a wrong "next" as fact. getPlayer is
    // cached, so this rarely costs an extra call.
    const p = await getPlayer();
    const reliable = !!(p && p.ok && p.context);
    return {
      ok: true,
      current: trackLite(r.data.currently_playing),
      queue: Array.isArray(r.data.queue) ? r.data.queue.slice(0, 20).map(trackLite).filter(Boolean) : [],
      reliable,
    };
  }

  async function getPlaylists() {
    const r = await apiRequest('GET', '/me/playlists?limit=50');
    if (!r.ok || !r.data) return { ok: false, error: r.error || 'failed' };
    const items = Array.isArray(r.data.items) ? r.data.items : [];
    return {
      ok: true,
      playlists: items.filter(Boolean).map(p => ({
        name: p.name || '',
        uri: p.uri || '',
        image: (Array.isArray(p.images) && p.images.length) ? (p.images[0].url || '') : '',
        tracks: (p.tracks && p.tracks.total != null) ? p.tracks.total : null,
      })),
    };
  }

  async function getDevices() {
    const r = await apiRequest('GET', '/me/player/devices');
    if (r.status === 403) return { ok: false, error: 'forbidden' };   // missing user-read-playback-state
    if (!r.ok || !r.data) return { ok: false, error: r.error || 'failed' };
    const list = Array.isArray(r.data.devices) ? r.data.devices : [];
    return {
      ok: true,
      devices: list.filter(Boolean).map(dv => ({
        id: dv.id || '',
        name: dv.name || '',
        type: String(dv.type || '').toLowerCase(),
        active: !!dv.is_active,
        volume: (dv.volume_percent != null) ? dv.volume_percent : null,
      })),
    };
  }

  // Full now-playing shape for the widget hero: the LARGEST cover (crisp at the
  // hero size, unlike the list rows which take the smallest), the track id (for
  // save/like state) and album name. Returns null for a non-track item (ad/episode).
  function trackFull(t) {
    if (!t || typeof t !== 'object' || t.type === 'ad') return null;
    const imgs = (t.album && Array.isArray(t.album.images)) ? t.album.images : [];
    return {
      id: t.id || '',
      name: t.name || '',
      uri: t.uri || '',
      artist: Array.isArray(t.artists) ? t.artists.map(a => a && a.name).filter(Boolean).join(', ') : '',
      album: (t.album && t.album.name) || '',
      image: imgs.length ? (imgs[0].url || '') : '',   // widest-first → [0] is largest
    };
  }

  // Is a track in the user's Liked Songs? Needs the user-library-read scope.
  // Returns null (unknown) on any failure so the heart just stays neutral.
  async function isSaved(id) {
    if (!id) return null;
    const r = await apiRequest('GET', '/me/tracks/contains?ids=' + encodeURIComponent(id));
    return (r.ok && Array.isArray(r.data)) ? !!r.data[0] : null;
  }

  // Cached variant for the hero poll: the liked state only changes when the track
  // changes or the user toggles the heart, so re-checking it every poll is a wasted
  // API call (and on a low-limit Dev-Mode app, wasted calls trip the rate limit).
  let _likedCache = { id: '', liked: null };
  async function isSavedCached(id) {
    if (!id) return null;
    if (id === _likedCache.id && _likedCache.liked !== null) return _likedCache.liked;
    const liked = await isSaved(id);
    if (liked !== null) _likedCache = { id, liked };
    return liked;
  }

  // Full playback state for the widget's now-playing hero — one call covers the
  // track, progress, shuffle/repeat, and the active device's volume. A 204 (no
  // active device) is a normal "nothing playing" state, not an error.
  // opts.fresh skips the snapshot cache (still folds into any in-flight read): used
  // by the client's post-control resync (next/prev/seek), where a cached snapshot
  // would keep serving the pre-action state for the whole TTL.
  async function getPlayer(opts) {
    const now = Date.now();
    const fresh = !!(opts && opts.fresh);
    if (!fresh && _playerCache && (now - _playerCache.at) < PLAYER_TTL_MS) return _playerCache.data;
    if (_playerPending) return _playerPending;              // fold concurrent callers into one call
    const gen = _playerGen;
    _playerPending = (async () => {
      try {
        const data = await _getPlayerUncached();
        // Skip caching if a control action (play/pause/…) raced in during this read —
        // otherwise the pre-action snapshot would poison the cache for the whole TTL.
        if (gen === _playerGen) _playerCache = { at: Date.now(), data };
        return data;
      } finally { _playerPending = null; }
    })();
    return _playerPending;
  }

  async function _getPlayerUncached() {
    const r = await apiRequest('GET', '/me/player');
    if (r.error === 'not_connected') return { ok: false, error: 'not_connected' };
    // 403 on a playback READ = the stored token is missing user-read-playback-state
    // (an old login from before we requested it). Surface it distinctly so the UI can
    // say "reconnect to grant permission" instead of the misleading "no active device"
    // — the app can be playing and we still can't see it.
    if (r.status === 403) return { ok: false, error: 'forbidden' };
    if (!r.ok) return { ok: false, error: r.error || ('http_' + (r.status || '?')) };
    // A 204 (or a body with no item) means there is no ACTIVE Spotify Connect
    // device — which happens shortly after you PAUSE, even though a track is
    // still loaded. `/me/player/currently-playing` keeps reporting that paused
    // track for much longer, so fall back to it to match what the Media tile
    // (Windows SMTC) shows instead of going blank. That endpoint carries no
    // device/shuffle/repeat, so those degrade to neutral defaults below.
    let data = r.data;
    if (r.status === 204 || !data || !data.item) {
      const cp = await apiRequest('GET', '/me/player/currently-playing');
      if (cp.ok && cp.status !== 204 && cp.data && cp.data.item) data = cp.data;
      else return { ok: true, playing: false, track: null };
    }
    const dev = data.device || null;
    const track = trackFull(data.item);
    return {
      ok: true,
      playing: !!data.is_playing,
      track,
      progressMs: data.progress_ms || 0,
      durationMs: (data.item && data.item.duration_ms) || 0,
      shuffle: !!data.shuffle_state,
      repeat: data.repeat_state || 'off',           // 'off' | 'context' | 'track'
      // Playback context type ('playlist'|'album'|'artist'|…) or '' when playing a
      // loose/"random" track (single, Liked Songs, radio). Consumed by getQueue to
      // decide whether Spotify's Up Next order can be trusted.
      context: (data.context && data.context.type) ? String(data.context.type) : '',
      device: dev ? (dev.name || '') : '',
      volume: (dev && dev.volume_percent != null) ? dev.volume_percent : null,
      supportsVolume: !!(dev && dev.supports_volume),
      liked: track ? await isSavedCached(track.id) : null,
    };
  }

  // ── Actions (Deck + widget). Each returns {ok} or {ok:false,error}. ────────
  // A 403 from Spotify is ambiguous — it does NOT always mean "not Premium". Read the
  // error body to tell the cases apart so the UI shows the RIGHT hint instead of
  // always blaming Premium (which strands a Premium user who really needs to reconnect):
  //   • reason PREMIUM_REQUIRED → genuinely a free account → `premium_required`
  //   • "Insufficient client scope" (or any LIBRARY write) → the stored token predates
  //     a permission we now request (e.g. user-modify-playback-state added later), so
  //     the user must reconnect to re-grant it → `forbidden` ("reconnect in Settings")
  //   • any other player restriction (no controllable device, transient state) →
  //     `no_active_device` ("start playback first"), the actionable common case.
  function classify403(r, kind) {
    const err = (r && r.data && r.data.error) || {};
    const reason = String(err.reason || '').toUpperCase();
    const message = String(err.message || '').toLowerCase();
    if (reason === 'PREMIUM_REQUIRED') return 'premium_required';
    if (kind === 'library' || message.includes('scope')) return 'forbidden';
    return 'no_active_device';
  }

  // Map a control response to a stable result the UI turns into a friendly hint.
  // 404 NO_ACTIVE_DEVICE = nothing to control; a 403 is disambiguated above.
  // `kind` defaults to playback (the common case); pass 'library' for /me/tracks.
  function apiResult(r, fallbackError, kind) {
    if (r.ok) return { ok: true };
    if (r.status === 404) return { ok: false, error: 'no_active_device' };
    if (r.status === 403) return { ok: false, error: classify403(r, kind) };
    return { ok: false, error: r.error || fallbackError || ('http_' + (r.status || '?')) };
  }

  // Extract a bare Spotify ID from an id / spotify: URI / open.spotify.com link,
  // so a Deck key can carry whichever form the user pasted.
  function spotifyId(input, kind) {
    const v = String(input == null ? '' : input).trim();
    let m = v.match(new RegExp('spotify:' + kind + ':([A-Za-z0-9]+)'));
    if (m) return m[1];
    m = v.match(new RegExp('open\\.spotify\\.com/' + kind + '/([A-Za-z0-9]+)'));
    if (m) return m[1];
    if (/^[A-Za-z0-9]+$/.test(v)) return v;                  // already a bare id
    return '';
  }

  async function saveCurrent() {
    const q = await apiRequest('GET', '/me/player/currently-playing');
    if (q.error === 'not_connected') return { ok: false, error: 'not_connected' };
    const id = q.ok && q.data && q.data.item && q.data.item.id;
    if (!id) return { ok: false, error: 'nothing_playing' };
    return apiResult(await apiRequest('PUT', '/me/tracks?ids=' + encodeURIComponent(id)), 'save_failed', 'library');
  }

  async function playPlaylist(input) {
    const id = spotifyId(input, 'playlist');
    if (!id) return { ok: false, error: 'bad_playlist' };
    return apiResult(await apiRequest('PUT', '/me/player/play', { context_uri: 'spotify:playlist:' + id }), 'play_failed');
  }

  async function setShuffle(mode) {
    let state;
    if (mode === 'on') state = true;
    else if (mode === 'off') state = false;
    else {                                                    // toggle: read current, invert
      const p = await apiRequest('GET', '/me/player');
      state = !(p.ok && p.data && p.data.shuffle_state);
    }
    return apiResult(await apiRequest('PUT', '/me/player/shuffle?state=' + state), 'shuffle_failed');
  }

  async function transferDevice(input) {
    const name = String(input == null ? '' : input).trim().toLowerCase();
    if (!name) return { ok: false, error: 'bad_device' };
    const dv = await getDevices();
    if (!dv.ok) return { ok: false, error: dv.error || 'no_devices' };
    const match = dv.devices.find(x => x.name.toLowerCase() === name)
      || dv.devices.find(x => x.name.toLowerCase().includes(name));
    if (!match || !match.id) return { ok: false, error: 'device_not_found' };
    return transferToId(match.id);
  }

  // Transfer playback to a device by its exact id (used by the widget's device
  // list, which already knows the id). `play:true` resumes on the new device.
  async function transferToId(deviceId) {
    const id = String(deviceId == null ? '' : deviceId).trim();
    if (!id) return { ok: false, error: 'bad_device' };
    return apiResult(await apiRequest('PUT', '/me/player', { device_ids: [id], play: true }), 'transfer_failed');
  }

  const clampInt = (v, lo, hi) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return lo;
    return Math.max(lo, Math.min(hi, n));
  };

  // Play / pause / toggle. 'toggle' reads the live state and flips it.
  async function playPause(mode) {
    let want = mode;
    if (mode !== 'play' && mode !== 'pause') {
      const p = await apiRequest('GET', '/me/player');
      if (p.error === 'not_connected') return { ok: false, error: 'not_connected' };
      want = (p.ok && p.data && p.data.is_playing) ? 'pause' : 'play';
    }
    const r = await apiRequest('PUT', '/me/player/' + want);
    // A 404 on PLAY means there's no ACTIVE device — but Spotify is open (idle), so
    // instead of failing, wake a device and start playing. This is the common case
    // behind "No active device": the desktop app is a device but not yet active.
    if (want === 'play' && r.status === 404) return startPlayback();
    return apiResult(r, 'playback_failed');
  }

  // Wake an available Spotify Connect device and start playback: transfer to it with
  // play:true (which resumes the last track/context). If there is nothing to resume
  // (a cold-but-open app), fall back to starting the user's first playlist — so the
  // "Play" button always gets music going rather than erroring on no-active-device.
  async function startPlayback() {
    const dv = await getDevices();
    if (!dv.ok || !dv.devices.length) return { ok: false, error: 'no_active_device' };
    const target = dv.devices.find(x => x.active) || dv.devices.find(x => x.type === 'computer') || dv.devices[0];
    if (!target || !target.id) return { ok: false, error: 'no_active_device' };
    const r = await apiRequest('PUT', '/me/player', { device_ids: [target.id], play: true });
    if (r.ok) return { ok: true };
    if (r.status === 403) return { ok: false, error: classify403(r) };
    const pls = await getPlaylists();
    const uri = (pls.ok && Array.isArray(pls.playlists) && pls.playlists[0]) ? pls.playlists[0].uri : '';
    if (uri) return apiResult(await apiRequest('PUT', '/me/player/play?device_id=' + encodeURIComponent(target.id), { context_uri: uri }), 'play_failed');
    return apiResult(r, 'play_failed');
  }

  // Skip to next/previous. Like PLAY, a 404 means there's no ACTIVE device even
  // though Spotify is open (idle/paused) — so instead of failing with
  // "no active device", wake a device and retry the skip. Without this, Next/Prev
  // was dead in the exact state where Play silently worked (the "can't turn on the
  // next song" report).
  async function skipTo(dir) {
    const path = '/me/player/' + dir;
    const r = await apiRequest('POST', path);
    if (r.status === 404) {
      const woke = await startPlayback();
      if (!woke.ok) return woke;
      return apiResult(await apiRequest('POST', path), 'skip_failed');
    }
    return apiResult(r, 'skip_failed');
  }
  async function skipNext() { return skipTo('next'); }
  async function skipPrev() { return skipTo('previous'); }

  // Repeat off → context → track → off. 'toggle' advances the cycle; an explicit
  // 'off'/'context'/'track' sets it directly.
  async function setRepeat(mode) {
    const CYCLE = { off: 'context', context: 'track', track: 'off' };
    let state = mode;
    if (mode !== 'off' && mode !== 'context' && mode !== 'track') {
      const p = await apiRequest('GET', '/me/player');
      const cur = (p.ok && p.data && p.data.repeat_state) || 'off';
      state = CYCLE[cur] || 'context';
    }
    return apiResult(await apiRequest('PUT', '/me/player/repeat?state=' + state), 'repeat_failed');
  }

  // Save/remove the currently-playing track from Liked Songs. 'toggle' reads the
  // current saved state and flips it.
  async function toggleLike(mode) {
    const q = await apiRequest('GET', '/me/player/currently-playing');
    if (q.error === 'not_connected') return { ok: false, error: 'not_connected' };
    const id = q.ok && q.data && q.data.item && q.data.item.id;
    if (!id) return { ok: false, error: 'nothing_playing' };
    let add;
    if (mode === 'like') add = true;
    else if (mode === 'unlike') add = false;
    else add = !(await isSaved(id));                       // toggle
    const r = apiResult(await apiRequest(add ? 'PUT' : 'DELETE', '/me/tracks?ids=' + encodeURIComponent(id)), 'like_failed', 'library');
    if (r.ok) _likedCache = { id, liked: add };            // keep the hero heart in sync without a re-fetch
    return r;
  }

  // Set device volume. mode 'set' uses `value` (0–100); 'up'/'down' step ±10 from
  // the live volume. Requires an active device that supports volume.
  async function setVolume(mode, value) {
    let vol;
    if (mode === 'up' || mode === 'down') {
      const p = await apiRequest('GET', '/me/player');
      const cur = (p.ok && p.data && p.data.device && p.data.device.volume_percent != null) ? p.data.device.volume_percent : 50;
      vol = clampInt(cur + (mode === 'up' ? 10 : -10), 0, 100);
    } else {
      vol = clampInt(value, 0, 100);
    }
    return apiResult(await apiRequest('PUT', '/me/player/volume?volume_percent=' + vol), 'volume_failed');
  }

  // Seek to an absolute position in the current track (`ms` from the caller, which
  // already knows the duration). Deck keys can pass 0 to restart the track.
  async function seek(ms) {
    return apiResult(await apiRequest('PUT', '/me/player/seek?position_ms=' + clampInt(ms, 0, 24 * 60 * 60 * 1000)), 'seek_failed');
  }

  // Search the catalog and return simplified matches. Used by the AI assistant
  // to turn "play <song>" / "queue <song>" into a concrete Spotify URI. Needs no
  // extra scope. `type` is one of track/album/artist/playlist (default track).
  async function search(query, type, limit) {
    const q = String(query == null ? '' : query).trim();
    if (!q) return { ok: false, error: 'no_query' };
    const t = ['track', 'album', 'artist', 'playlist'].includes(String(type)) ? String(type) : 'track';
    const n = clampInt(limit || 5, 1, 10);
    const r = await apiRequest('GET', '/search?type=' + t + '&limit=' + n + '&q=' + encodeURIComponent(q));
    if (!r.ok || !r.data) return { ok: false, error: r.error || 'search_failed' };
    const bucket = r.data[t + 's'];
    const items = (bucket && Array.isArray(bucket.items)) ? bucket.items : [];
    return {
      ok: true,
      type: t,
      results: items.filter(Boolean).slice(0, n).map(it => ({
        name: it.name || '',
        uri: it.uri || '',
        artist: Array.isArray(it.artists) ? it.artists.map(a => a && a.name).filter(Boolean).join(', ') : '',
      })),
    };
  }

  // Search for the top match and start playing it. A track plays via `uris`; an
  // album/artist/playlist plays as a `context_uri`. Requires Premium (403 →
  // premium_required, like every other playback control).
  async function playSearch(query, type) {
    const s = await search(query, type, 1);
    if (!s.ok) return s;
    const hit = s.results[0];
    if (!hit || !hit.uri) return { ok: false, error: 'not_found' };
    const body = s.type === 'track' ? { uris: [hit.uri] } : { context_uri: hit.uri };
    const r = apiResult(await apiRequest('PUT', '/me/player/play', body), 'play_failed');
    return r.ok ? { ok: true, playing: hit } : r;
  }

  // Add the top-matching track to the current playback queue.
  async function queueSearch(query) {
    const s = await search(query, 'track', 1);
    if (!s.ok) return s;
    const hit = s.results[0];
    if (!hit || !hit.uri) return { ok: false, error: 'not_found' };
    const r = apiResult(await apiRequest('POST', '/me/player/queue?uri=' + encodeURIComponent(hit.uri)), 'queue_failed');
    return r.ok ? { ok: true, queued: hit } : r;
  }

  // Single entry the registry calls for every spotify* Deck action.
  async function runAction(action) {
    switch (action.type) {
      case 'spotifySave': return saveCurrent();
      case 'spotifyPlaylist': return playPlaylist(action.playlist);
      case 'spotifyShuffle': return setShuffle(action.mode);
      case 'spotifyDevice': return transferDevice(action.device);
      case 'spotifyPlay': return playPause(action.mode);
      case 'spotifyNext': return skipNext();
      case 'spotifyPrev': return skipPrev();
      case 'spotifyRepeat': return setRepeat(action.mode);
      case 'spotifyLike': return toggleLike(action.mode);
      case 'spotifyVolume': return setVolume(action.mode, action.value);
      case 'spotifySeek': return seek(action.value);
      default: return { ok: false, error: 'unsupported' };
    }
  }

  return {
    configured, status, logout, buildAuthUrl, exchangeCode, getAccessToken,
    getQueue, getPlaylists, getDevices, getPlayer, search,
    saveCurrent, playPlaylist, playSearch, queueSearch, setShuffle, transferDevice, transferToId,
    playPause, skipNext, skipPrev, setRepeat, toggleLike, setVolume, seek, runAction,
  };
}

module.exports = { createSpotifyProvider, normalizeStreamSpotify };
