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

  return { startDeviceLogin, pollDeviceToken, getAccessToken, status, logout, apiRequest, configured, broadcastStatus, transitionBroadcast, updateBroadcastTitle };
}

module.exports = { createYouTubeProvider, normalizeStreamYouTube };
