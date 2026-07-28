'use strict';
// YouTube integration provider — Google OAuth 2.0 Device Flow (TV & limited-input
// devices), ideal for the touchscreen: the user authorises on their phone. Token
// persistence + refresh, mirroring stream-twitch.js.
//
// SECURITY: tokens live in the SERVER-ONLY runtime file (stream-tokens.json),
// never in settings.json and never sent to the browser (the client only sees
// { connected, login }). Google's device-flow "client secret" for an installed
// app is non-confidential, but like the client_id it stays out of committed
// source — server.js injects both from env / stream-config.json. Never log a token.
//
// ROBUSTNESS: every method resolves to a plain result object and never throws.

const path = require('path');
const { makeCredsNormalizer, createTokenStore, FORM } = require('./stream-common');

const SCOPE = 'https://www.googleapis.com/auth/youtube';
const DEVICE_URL = 'https://oauth2.googleapis.com/device/code';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const API = 'https://www.googleapis.com/youtube/v3';

const normalizeStreamYouTube = makeCredsNormalizer({ channel: 120, channelId: 60 });

// deps (all optional, injectable for tests):
//   clientId / clientSecret — the Google OAuth installed-app credentials
//   tokensFile — server-only token store (defaults to ./stream-tokens.json)
//   fetch — fetch implementation (defaults to global fetch)
function createYouTubeProvider(deps) {
  const d = deps || {};
  const _fetch = d.fetch || ((...a) => fetch(...a));
  const clientId = d.clientId || '';
  const clientSecret = d.clientSecret || '';
  const tokensFile = d.tokensFile || path.join(__dirname, 'stream-tokens.json');
  // Server-only token store (shared plumbing with the other providers).
  const { creds, patchCreds, clearCreds, persistToken, makeGetAccessToken } =
    createTokenStore({ tokensFile, storeKey: 'youtube', normalize: normalizeStreamYouTube });

  function configured() { return !!clientId && !!clientSecret; }

  async function startDeviceLogin() {
    if (!configured()) return { ok: false, error: 'no_client_id' };
    try {
      const res = await _fetch(DEVICE_URL, { method: 'POST', headers: FORM, body: new URLSearchParams({ client_id: clientId, scope: SCOPE }) });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || !data.device_code) return { ok: false, error: 'device_failed' };
      return {
        ok: true,
        deviceCode: data.device_code,
        userCode: data.user_code,
        verificationUri: data.verification_url || data.verification_uri || 'https://www.google.com/device',
        interval: data.interval || 5,
        expiresIn: data.expires_in,
      };
    } catch { return { ok: false, error: 'network' }; }
  }

  async function pollDeviceToken(deviceCode) {
    if (!configured()) return { ok: false, error: 'no_client_id' };
    if (!deviceCode || typeof deviceCode !== 'string') return { ok: false, error: 'bad_request' };
    try {
      const res = await _fetch(TOKEN_URL, {
        method: 'POST', headers: FORM,
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data && data.access_token) {
        await persistToken(data);
        dropCaches();   // a different account may have signed in
        const ch = await fetchChannel(data.access_token);
        if (ch) await patchCreds({ channel: ch.title, channelId: ch.id });
        return { ok: true, connected: true, login: ch ? ch.title : '' };
      }
      const err = String((data && data.error) || '').toLowerCase();
      if (err === 'authorization_pending') return { ok: false, pending: true };
      if (err === 'slow_down') return { ok: false, pending: true, slowDown: true };
      if (err === 'expired_token') return { ok: false, error: 'expired' };
      if (err === 'access_denied') return { ok: false, error: 'denied' };
      return { ok: false, error: err || 'token_failed' };
    } catch { return { ok: false, error: 'network' }; }
  }

  async function refresh() {
    const c = await creds();
    if (!c.refreshToken) return false;
    try {
      const res = await _fetch(TOKEN_URL, {
        method: 'POST', headers: FORM,
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: c.refreshToken }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || !data.access_token) { await clearCreds(); return false; }
      await persistToken(data);
      return true;
    } catch { return false; }
  }

  const getAccessToken = makeGetAccessToken(refresh);

  async function fetchChannel(token) {
    try {
      const res = await _fetch(API + '/channels?part=snippet&mine=true', { headers: { Authorization: 'Bearer ' + token } });
      const data = await res.json().catch(() => null);
      const item = data && Array.isArray(data.items) && data.items[0];
      return item ? { id: item.id, title: (item.snippet && item.snippet.title) || '' } : null;
    } catch { return null; }
  }

  // Authenticated Data API call for the Phase 4 action layer.
  async function apiRequest(method, pathWithQuery, bodyObj) {
    const token = await getAccessToken();
    if (!token) return { ok: false, error: 'not_connected' };
    const init = { method, headers: { Authorization: 'Bearer ' + token } };
    if (bodyObj) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(bodyObj); }
    try {
      const res = await _fetch(API + pathWithQuery, init);
      const data = await res.json().catch(() => null);
      return { ok: res.ok, status: res.status, data };
    } catch { return { ok: false, error: 'network' }; }
  }

  async function status() {
    const c = await creds();
    return { connected: !!c.accessToken, login: c.channel, configured: configured() };
  }

  async function logout() {
    const c = await creds();
    if (c.accessToken) {
      try { await _fetch(REVOKE_URL, { method: 'POST', headers: FORM, body: new URLSearchParams({ token: c.accessToken }) }); }
      catch { /* best-effort */ }
    }
    await clearCreds();
    dropCaches();
    return { ok: true };
  }

  // ── Phase 4: live broadcast control + status ──────────────────────────────
  // The user's most relevant broadcast: an active one first, else an upcoming one.
  async function findBroadcast() {
    const a = await apiRequest('GET', '/liveBroadcasts?part=id,status,snippet&broadcastStatus=active&maxResults=1');
    if (a.ok && a.data && Array.isArray(a.data.items) && a.data.items[0]) return a.data.items[0];
    const u = await apiRequest('GET', '/liveBroadcasts?part=id,status,snippet&broadcastStatus=upcoming&maxResults=1');
    if (u.ok && u.data && Array.isArray(u.data.items) && u.data.items[0]) return u.data.items[0];
    return null;
  }

  function apiReason(r) {
    const e = r && r.data && r.data.error && r.data.error.errors && r.data.error.errors[0];
    return (e && e.reason) || (r && r.error) || ('http_' + (r && r.status || '?'));
  }

  // Ingestion health (is OBS reaching YouTube?): '', 'good', 'ok', 'bad', 'noData'.
  async function streamHealth() {
    const r = await apiRequest('GET', '/liveStreams?part=status&mine=true&maxResults=1');
    const item = r.ok && r.data && Array.isArray(r.data.items) && r.data.items[0];
    const h = item && item.status && item.status.healthStatus && item.status.healthStatus.status;
    return typeof h === 'string' ? h : '';
  }

  // Live status for the widget: { ok, live, viewers, title, health }. Quota note:
  // stream health is only queried when a broadcast exists (live or upcoming) — an
  // idle account skips it.
  async function broadcastStatus() {
    if (!(await getAccessToken())) return { ok: false, error: 'not_connected' };
    const b = await findBroadcast();
    if (!b) return { ok: true, live: false, health: '' };
    const live = !!(b.status && b.status.lifeCycleStatus === 'live');
    const out = { ok: true, live, title: (b.snippet && b.snippet.title) || '', health: await streamHealth() };
    if (live) {
      // One call gets concurrent viewers (liveStreamingDetails) + total views/likes
      // (statistics) — cheaper than two requests.
      const v = await apiRequest('GET', '/videos?part=liveStreamingDetails,statistics&id=' + encodeURIComponent(b.id));
      const item = v.ok && v.data && Array.isArray(v.data.items) && v.data.items[0];
      const cv = item && item.liveStreamingDetails && item.liveStreamingDetails.concurrentViewers;
      out.viewers = (cv != null) ? Number(cv) : null;
      const stats = item && item.statistics;
      out.totalViews = (stats && stats.viewCount != null) ? Number(stats.viewCount) : null;
      out.likes = (stats && stats.likeCount != null) ? Number(stats.likeCount) : null;
    }
    return out;
  }

  // ── Viewer mode: playlists, liked videos, subscriptions, search ───────────
  // YouTube playlist ids are URL-safe base64 tokens; validated before any
  // interpolation so a wire-supplied id can never reshape the API path.
  const PLAYLIST_ID_RE = /^[A-Za-z0-9_-]{2,64}$/;
  const PLAYLIST_TTL_MS = 5 * 60 * 1000;
  const LIST_TTL_MS = 5 * 60 * 1000;         // liked videos, playlist contents
  const FEED_TTL_MS = 15 * 60 * 1000;        // subscriptions feed (costs ~18 units)
  const SEARCH_TTL_MS = 30 * 60 * 1000;      // a search costs 100 units — cache hard
  const FEED_CHANNELS = 15;                  // channels polled per feed build
  const FEED_PER_CHANNEL = 3;
  let plCache = { at: 0, data: null };   // quota-kind: every surface shares one read
  // Bounded TTL cache for the video lists. The whole map is dropped on login and
  // logout so a second account never sees the first one's library.
  const listCache = new Map();
  function cacheGet(key, ttl) {
    const e = listCache.get(key);
    return (e && Date.now() - e.at < ttl) ? e.data : null;
  }
  function cacheSet(key, data) {
    if (listCache.size >= 40) listCache.clear();
    listCache.set(key, { at: Date.now(), data });
    return data;
  }
  function dropCaches() { plCache = { at: 0, data: null }; listCache.clear(); }

  // Thumbnails are painted as CSS background-images by the client, so the scheme
  // is allowlisted here at the boundary rather than trusted from the API.
  function thumb(th) {
    const raw = (th && ((th.medium && th.medium.url) || (th.default && th.default.url) || (th.high && th.high.url))) || '';
    return /^https:\/\//.test(raw) ? raw : '';
  }
  // "PT1H2M3S" → 3723. Anything unparseable stays null and the client just omits
  // the duration chip rather than showing a wrong one.
  function isoSeconds(s) {
    const m = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(s == null ? '' : s));
    if (!m) return null;
    return (+(m[1] || 0)) * 86400 + (+(m[2] || 0)) * 3600 + (+(m[3] || 0)) * 60 + (+(m[4] || 0));
  }
  const VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,24}$/;

  // One batched videos.list for the durations of a whole page (1 quota unit).
  async function durationsFor(ids) {
    const clean = ids.filter(id => VIDEO_ID_RE.test(id)).slice(0, 50);
    const out = new Map();
    if (!clean.length) return out;
    const r = await apiRequest('GET', '/videos?part=contentDetails&id=' + encodeURIComponent(clean.join(',')));
    const items = (r.ok && r.data && Array.isArray(r.data.items)) ? r.data.items : [];
    items.forEach(v => {
      if (v && v.id) out.set(v.id, isoSeconds(v.contentDetails && v.contentDetails.duration));
    });
    return out;
  }

  function mapVideo(id, snippet, seconds) {
    return {
      id,
      title: (snippet && snippet.title) || '',
      channel: (snippet && (snippet.videoOwnerChannelTitle || snippet.channelTitle)) || '',
      image: thumb(snippet && snippet.thumbnails),
      seconds: (seconds == null ? null : seconds),
      published: (snippet && snippet.publishedAt) || '',
    };
  }

  async function listPlaylists() {
    if (!(await getAccessToken())) return { ok: false, error: 'not_connected' };
    if (plCache.data && Date.now() - plCache.at < PLAYLIST_TTL_MS) return plCache.data;
    const r = await apiRequest('GET', '/playlists?part=snippet,contentDetails&mine=true&maxResults=50');
    if (!r.ok || !r.data) return { ok: false, error: apiReason(r) };
    const items = Array.isArray(r.data.items) ? r.data.items : [];
    const out = {
      ok: true,
      playlists: items.filter(Boolean).map(p => ({
        id: p.id || '',
        title: (p.snippet && p.snippet.title) || '',
        count: (p.contentDetails && p.contentDetails.itemCount != null) ? p.contentDetails.itemCount : null,
        image: thumb(p.snippet && p.snippet.thumbnails),
      })).filter(p => p.id),
    };
    plCache = { at: Date.now(), data: out };
    return out;
  }

  // The videos the user liked. videos.list?myRating=like returns snippet AND
  // contentDetails in one request, so this is a single quota unit — and it works
  // where the "LL" playlist doesn't (that playlist is private and several
  // accounts refuse it through playlistItems).
  async function likedVideos() {
    if (!(await getAccessToken())) return { ok: false, error: 'not_connected' };
    const hit = cacheGet('liked', LIST_TTL_MS);
    if (hit) return hit;
    const r = await apiRequest('GET', '/videos?part=snippet,contentDetails&myRating=like&maxResults=25');
    if (!r.ok || !r.data) return { ok: false, error: apiReason(r) };
    const items = Array.isArray(r.data.items) ? r.data.items : [];
    const videos = items.filter(v => v && v.id).map(v => mapVideo(v.id, v.snippet, isoSeconds(v.contentDetails && v.contentDetails.duration)));
    return cacheSet('liked', { ok: true, videos });
  }

  // The videos inside one playlist. Durations need a second (batched) call —
  // playlistItems doesn't carry them.
  async function playlistVideos(id) {
    if (!(await getAccessToken())) return { ok: false, error: 'not_connected' };
    const pid = String(id == null ? '' : id).trim();
    if (!PLAYLIST_ID_RE.test(pid)) return { ok: false, error: 'bad_id' };
    const hit = cacheGet('pl:' + pid, LIST_TTL_MS);
    if (hit) return hit;
    const r = await apiRequest('GET', '/playlistItems?part=snippet,contentDetails&playlistId=' + encodeURIComponent(pid) + '&maxResults=50');
    if (!r.ok || !r.data) return { ok: false, error: apiReason(r) };
    const items = Array.isArray(r.data.items) ? r.data.items : [];
    const rows = items.map(it => {
      const vid = (it && it.contentDetails && it.contentDetails.videoId)
        || (it && it.snippet && it.snippet.resourceId && it.snippet.resourceId.videoId) || '';
      return VIDEO_ID_RE.test(vid) ? { vid, snippet: it.snippet } : null;
    }).filter(Boolean);
    const dur = await durationsFor(rows.map(r2 => r2.vid));
    const videos = rows.map(r2 => mapVideo(r2.vid, r2.snippet, dur.has(r2.vid) ? dur.get(r2.vid) : null));
    return cacheSet('pl:' + pid, { ok: true, videos });
  }

  // Latest uploads from the channels the user is subscribed to. There is no
  // "home feed" in the Data API, so it is rebuilt: subscriptions (1 unit) →
  // their uploads playlist ids in one batch (1 unit) → the newest few of each
  // (1 unit per channel). Capped at FEED_CHANNELS and cached for 15 minutes so
  // a whole day of use stays well inside the default 10,000-unit quota.
  async function subscriptionsFeed() {
    if (!(await getAccessToken())) return { ok: false, error: 'not_connected' };
    const hit = cacheGet('subs', FEED_TTL_MS);
    if (hit) return hit;
    const s = await apiRequest('GET', '/subscriptions?part=snippet&mine=true&order=relevance&maxResults=50');
    if (!s.ok || !s.data) return { ok: false, error: apiReason(s) };
    const chIds = (Array.isArray(s.data.items) ? s.data.items : [])
      .map(it => it && it.snippet && it.snippet.resourceId && it.snippet.resourceId.channelId)
      .filter(id => PLAYLIST_ID_RE.test(String(id || '')))
      .slice(0, FEED_CHANNELS);
    if (!chIds.length) return cacheSet('subs', { ok: true, videos: [] });
    const c = await apiRequest('GET', '/channels?part=contentDetails&id=' + encodeURIComponent(chIds.join(',')) + '&maxResults=50');
    const uploads = ((c.ok && c.data && Array.isArray(c.data.items)) ? c.data.items : [])
      .map(ch => ch && ch.contentDetails && ch.contentDetails.relatedPlaylists && ch.contentDetails.relatedPlaylists.uploads)
      .filter(pid => PLAYLIST_ID_RE.test(String(pid || '')));
    const pages = await Promise.all(uploads.map(pid =>
      apiRequest('GET', '/playlistItems?part=snippet,contentDetails&playlistId=' + encodeURIComponent(pid) + '&maxResults=' + FEED_PER_CHANNEL)));
    const rows = [];
    pages.forEach(p => {
      const items = (p.ok && p.data && Array.isArray(p.data.items)) ? p.data.items : [];
      items.forEach(it => {
        const vid = (it && it.contentDetails && it.contentDetails.videoId) || '';
        if (VIDEO_ID_RE.test(vid)) rows.push({ vid, snippet: it.snippet });
      });
    });
    rows.sort((a, b) => String((b.snippet && b.snippet.publishedAt) || '').localeCompare(String((a.snippet && a.snippet.publishedAt) || '')));
    const top = rows.slice(0, 30);
    const dur = await durationsFor(top.map(r2 => r2.vid));
    const videos = top.map(r2 => mapVideo(r2.vid, r2.snippet, dur.has(r2.vid) ? dur.get(r2.vid) : null));
    return cacheSet('subs', { ok: true, videos });
  }

  // Search. This is the one expensive call in the widget (100 quota units of a
  // 10,000/day default), so it only ever runs on an explicit search and the
  // result is cached for half an hour per query.
  async function searchVideos(q) {
    if (!(await getAccessToken())) return { ok: false, error: 'not_connected' };
    const query = String(q == null ? '' : q).trim().slice(0, 100);
    if (query.length < 2) return { ok: false, error: 'empty' };
    const key = 'q:' + query.toLowerCase();
    const hit = cacheGet(key, SEARCH_TTL_MS);
    if (hit) return hit;
    const r = await apiRequest('GET', '/search?part=snippet&type=video&maxResults=25&q=' + encodeURIComponent(query));
    if (!r.ok || !r.data) return { ok: false, error: apiReason(r) };
    const rows = (Array.isArray(r.data.items) ? r.data.items : []).map(it => {
      const vid = it && it.id && it.id.videoId;
      return VIDEO_ID_RE.test(String(vid || '')) ? { vid, snippet: it.snippet } : null;
    }).filter(Boolean);
    const dur = await durationsFor(rows.map(r2 => r2.vid));
    const videos = rows.map(r2 => mapVideo(r2.vid, r2.snippet, dur.has(r2.vid) ? dur.get(r2.vid) : null));
    return cacheSet(key, { ok: true, videos });
  }

  // Playlist id → the URL the client should open. A watch URL on the first video
  // autoplays the whole playlist; when the first video can't be read (private
  // video, or the special LL liked-videos id some accounts refuse via the API)
  // fall back to the playlist page rather than failing — opening a page the
  // user's browser can render is never worse than an error.
  async function resolvePlaylistUrl(id) {
    if (!(await getAccessToken())) return { ok: false, error: 'not_connected' };
    const pid = String(id == null ? '' : id).trim();
    if (!PLAYLIST_ID_RE.test(pid)) return { ok: false, error: 'bad_id' };
    const r = await apiRequest('GET', '/playlistItems?part=contentDetails&playlistId=' + encodeURIComponent(pid) + '&maxResults=1');
    const first = r.ok && r.data && Array.isArray(r.data.items) && r.data.items[0];
    const vid = first && first.contentDetails && first.contentDetails.videoId;
    const url = vid
      ? 'https://www.youtube.com/watch?v=' + encodeURIComponent(vid) + '&list=' + encodeURIComponent(pid)
      : 'https://www.youtube.com/playlist?list=' + encodeURIComponent(pid);
    return { ok: true, url };
  }

  // Rename the current/upcoming broadcast (liveBroadcasts.update needs title +
  // scheduledStartTime in the snippet, so we preserve the existing start time).
  async function updateBroadcastTitle(title) {
    if (!(await getAccessToken())) return { ok: false, error: 'not_connected' };
    const ttl = String(title == null ? '' : title).trim().slice(0, 100);
    if (!ttl) return { ok: false, error: 'empty' };
    const b = await findBroadcast();
    if (!b) return { ok: false, error: 'no_broadcast' };
    const snippet = { title: ttl };
    if (b.snippet && b.snippet.scheduledStartTime) snippet.scheduledStartTime = b.snippet.scheduledStartTime;
    const r = await apiRequest('PUT', '/liveBroadcasts?part=snippet', { id: b.id, snippet });
    return r.ok ? { ok: true, title: ttl } : { ok: false, error: apiReason(r) };
  }

  // Start / stop / toggle the broadcast via liveBroadcasts.transition. The
  // broadcast must already exist (scheduled) and its stream be receiving data to
  // go live — otherwise YouTube refuses with a reason we surface verbatim.
  async function transitionBroadcast(mode) {
    if (!(await getAccessToken())) return { ok: false, error: 'not_connected' };
    const b = await findBroadcast();
    if (!b) return { ok: false, error: 'no_broadcast' };
    let want;
    if (mode === 'start') want = 'live';
    else if (mode === 'stop') want = 'complete';
    else want = (b.status && b.status.lifeCycleStatus === 'live') ? 'complete' : 'live';   // toggle
    const r = await apiRequest('POST', '/liveBroadcasts/transition?part=status&broadcastStatus=' + want + '&id=' + encodeURIComponent(b.id));
    return r.ok ? { ok: true } : { ok: false, error: apiReason(r) };
  }

  return {
    startDeviceLogin, pollDeviceToken, getAccessToken, status, logout, apiRequest, configured,
    broadcastStatus, transitionBroadcast, updateBroadcastTitle,
    listPlaylists, resolvePlaylistUrl, likedVideos, playlistVideos, subscriptionsFeed, searchVideos,
  };
}

module.exports = { createYouTubeProvider, normalizeStreamYouTube };
