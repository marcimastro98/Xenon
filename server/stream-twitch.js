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
const { makeCredsNormalizer, createTokenStore, FORM } = require('./stream-common');

// The Twitch app client_id is CONFIGURATION, never committed source. server.js
// resolves it from the `TWITCH_CLIENT_ID` env var or a gitignored
// `server/stream-config.json` and passes it as `deps.clientId`. Do NOT hardcode a
// real id here — this stays empty so nothing app-identifying lives in the repo.
// When unset the provider reports `configured:false` and every call returns
// { ok:false, error:'no_client_id' }.
const TWITCH_CLIENT_ID = '';

const SCOPES = 'clips:edit channel:manage:broadcast channel:edit:commercial chat:edit';
const DEVICE_URL = 'https://id.twitch.tv/oauth2/device';
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const REVOKE_URL = 'https://id.twitch.tv/oauth2/revoke';
const HELIX = 'https://api.twitch.tv/helix';

// Coerce a stored credentials blob into a clean, fully-populated shape so callers
// can destructure unconditionally. Unknown keys are dropped.
const normalizeStreamTwitch = makeCredsNormalizer({ login: 120, userId: 60 });

// deps (all optional, injectable for tests):
//   clientId    — override the shipped client_id
//   tokensFile  — path to the server-only token store (defaults to ./stream-tokens.json)
//   fetch       — fetch implementation (defaults to global fetch)
function createTwitchProvider(deps) {
  const d = deps || {};
  const _fetch = d.fetch || ((...a) => fetch(...a));
  const clientId = d.clientId != null ? d.clientId : TWITCH_CLIENT_ID;
  const tokensFile = d.tokensFile || path.join(__dirname, 'stream-tokens.json');
  // Server-only token store (shared plumbing with the other providers).
  const { creds, patchCreds, clearCreds, persistToken, makeGetAccessToken } =
    createTokenStore({ tokensFile, storeKey: 'twitch', normalize: normalizeStreamTwitch });

  function configured() { return !!clientId; }

  // Step 1 of the device flow: ask Twitch for a device + user code to show.
  async function startDeviceLogin() {
    if (!configured()) return { ok: false, error: 'no_client_id' };
    try {
      // NB: Twitch's device endpoint expects `scopes` (not the RFC-8628 `scope`).
      const res = await _fetch(DEVICE_URL, { method: 'POST', headers: FORM, body: new URLSearchParams({ client_id: clientId, scopes: SCOPES }) });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || !data.device_code) return { ok: false, error: 'device_failed' };
      return {
        ok: true,
        deviceCode: data.device_code,
        userCode: data.user_code,
        verificationUri: data.verification_uri,
        interval: data.interval || 5,
        expiresIn: data.expires_in,
      };
    } catch { return { ok: false, error: 'network' }; }
  }

  // Step 2: the dashboard polls this until the user authorises (or it expires).
  // Returns { ok:false, pending:true } while waiting — not an error.
  async function pollDeviceToken(deviceCode) {
    if (!configured()) return { ok: false, error: 'no_client_id' };
    if (!deviceCode || typeof deviceCode !== 'string') return { ok: false, error: 'bad_request' };
    try {
      const res = await _fetch(TOKEN_URL, {
        method: 'POST', headers: FORM,
        body: new URLSearchParams({ client_id: clientId, scopes: SCOPES, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data && data.access_token) {
        await persistToken(data);
        const me = await fetchUser(data.access_token);
        if (me) await patchCreds({ login: me.login, userId: me.id });
        return { ok: true, connected: true, login: me ? me.login : '' };
      }
      const msg = String((data && (data.message || data.error)) || '').toLowerCase();
      if (msg.includes('authorization_pending') || msg.includes('pending')) return { ok: false, pending: true };
      if (msg.includes('slow_down')) return { ok: false, pending: true, slowDown: true };
      if (msg.includes('expired')) return { ok: false, error: 'expired' };
      return { ok: false, error: 'denied' };
    } catch { return { ok: false, error: 'network' }; }
  }

  // Exchange the refresh token for a fresh access token. On any failure the stored
  // creds are cleared (so the UI falls back to a clean "reconnect" state).
  async function refresh() {
    const c = await creds();
    if (!c.refreshToken) return false;
    try {
      const res = await _fetch(TOKEN_URL, {
        method: 'POST', headers: FORM,
        body: new URLSearchParams({ client_id: clientId, grant_type: 'refresh_token', refresh_token: c.refreshToken }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || !data.access_token) { await clearCreds(); return false; }
      await persistToken(data);
      return true;
    } catch { return false; }   // network blip: keep creds, just fail this attempt
  }

  // A valid access token, refreshing if it's within the skew window, or '' when
  // not connected / refresh failed.
  const getAccessToken = makeGetAccessToken(refresh);

  async function fetchUser(token) {
    try {
      const res = await _fetch(HELIX + '/users', { headers: { 'Client-Id': clientId, Authorization: 'Bearer ' + token } });
      const data = await res.json().catch(() => null);
      const u = data && Array.isArray(data.data) && data.data[0];
      return u ? { id: u.id, login: u.login } : null;
    } catch { return null; }
  }

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

  // Client-safe state — NEVER includes tokens.
  async function status() {
    const c = await creds();
    return { connected: !!c.accessToken, login: c.login, configured: configured() };
  }

  async function logout() {
    const c = await creds();
    if (c.accessToken) {
      try { await _fetch(REVOKE_URL, { method: 'POST', headers: FORM, body: new URLSearchParams({ client_id: clientId, token: c.accessToken }) }); }
      catch { /* best-effort revoke */ }
    }
    await clearCreds();
    return { ok: true };
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

  // Clip the last ~30s of the live stream (clips:edit).
  async function createClip() {
    const id = await broadcasterId();
    if (!id) return { ok: false, error: 'not_connected' };
    const r = await helix('POST', '/clips?broadcaster_id=' + encodeURIComponent(id));
    return r.ok ? { ok: true } : { ok: false, error: mapActionError(r) };
  }

  // Drop a stream marker at the current point (channel:manage:broadcast).
  async function createMarker(description) {
    const id = await broadcasterId();
    if (!id) return { ok: false, error: 'not_connected' };
    const body = { user_id: id };
    const desc = String(description == null ? '' : description).trim().slice(0, 140);
    if (desc) body.description = desc;
    const r = await helix('POST', '/streams/markers', body);
    return r.ok ? { ok: true } : { ok: false, error: mapActionError(r) };
  }

  // Run a mid-roll ad of `length` seconds (channel:edit:commercial).
  async function runAd(length) {
    const id = await broadcasterId();
    if (!id) return { ok: false, error: 'not_connected' };
    const len = [30, 60, 90, 120, 150, 180].includes(Number(length)) ? Number(length) : 30;
    const r = await helix('POST', '/channels/commercial', { broadcaster_id: id, length: len });
    return r.ok ? { ok: true } : { ok: false, error: mapActionError(r) };
  }

  // Live status for the dashboard tile: { ok, live, viewers, title, game }.
  async function streamStatus() {
    const id = await broadcasterId();
    if (!id) return { ok: false, error: 'not_connected' };
    const r = await helix('GET', '/streams?user_id=' + encodeURIComponent(id));
    if (!r.ok) return { ok: false, error: mapActionError(r) };
    const s = r.data && Array.isArray(r.data.data) && r.data.data[0];
    if (!s) return { ok: true, live: false };
    return { ok: true, live: true, viewers: s.viewer_count || 0, title: s.title || '', game: s.game_name || '' };
  }

  return { startDeviceLogin, pollDeviceToken, getAccessToken, status, logout, helix, configured, broadcasterId, createClip, createMarker, runAd, streamStatus };
}

module.exports = { createTwitchProvider, normalizeStreamTwitch };
