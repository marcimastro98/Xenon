'use strict';
// One call to the Spotify Web API and how its answer is read: the token put on it, the pause
// respected, the short cache of what widgets read, a refusal told apart from a failure, an id
// checked and a number kept within its bounds before they go in an address.

const { API } = require('./spotify-endpoints.js');

function makeRequests({
  _fetch, rateLimited, retryAfterMs, noteRateLimit, playerState, getAccessToken,
}) {
  const QUERY_CACHE_MAX = 16;
  const _queryCache = new Map();        // path -> { at, ttl, res }

  function queryCacheClear() { _queryCache.clear(); }
  function queryCacheGet(path) {
    const hit = _queryCache.get(path);
    if (!hit) return null;
    if (Date.now() - hit.at > hit.ttl) { _queryCache.delete(path); return null; }
    return hit.res;
  }
  function queryCachePut(path, ttl, res) {
    _queryCache.delete(path);           // re-set keeps a Map's ORIGINAL position, and position is the eviction order
    _queryCache.set(path, { at: Date.now(), ttl, res });
    while (_queryCache.size > QUERY_CACHE_MAX) _queryCache.delete(_queryCache.keys().next().value);
  }

  async function apiRequest(method, pathWithQuery, bodyObj) {
    if (method !== 'GET') { playerState._playerCache = null; playerState._playerGen++; queryCacheClear(); }   // a mutation invalidates the snapshot AND any in-flight read — including the widgets', or a widget's own play lands on a stale queue
    // How long the breaker still holds travels with the refusal. Without it every
    // caller could say only "busy", which is fine for the few seconds this
    // usually lasts and wrong for the hours Spotify imposes on an app that has
    // burnt its quota — reported as "waited 24 hours and the limit persists",
    // against a dashboard that kept saying "retrying shortly".
    if (rateLimited()) return { ok: false, status: 429, error: 'rate_limited', retryAfterMs: retryAfterMs() };
    const token = await getAccessToken();
    if (!token) return { ok: false, error: 'not_connected' };
    const init = { method, headers: { Authorization: 'Bearer ' + token } };
    if (bodyObj != null) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(bodyObj); }
    try {
      const res = await _fetch(API + pathWithQuery, init);
      if (res.status === 429) { noteRateLimit(res); return { ok: false, status: 429, error: 'rate_limited', retryAfterMs: retryAfterMs() }; }
      const data = (res.status === 204) ? null : await res.json().catch(() => null);
      return { ok: res.ok, status: res.status, data };
    } catch { return { ok: false, error: 'network' }; }
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

  const clampInt = (v, lo, hi) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return lo;
    return Math.max(lo, Math.min(hi, n));
  };

  return {
    queryCacheClear, queryCacheGet, queryCachePut, apiRequest, classify403, apiResult, spotifyId,
    clampInt,
  };
}

module.exports = { makeRequests };
