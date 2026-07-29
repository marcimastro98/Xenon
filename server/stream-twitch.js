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
        dropCaches();   // a different account may have signed in
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
    dropCaches();
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

  // Set the stream title (channel:manage:broadcast). Works on or off air.
  async function setTitle(title) {
    const id = await broadcasterId();
    if (!id) return { ok: false, error: 'not_connected' };
    const text = String(title == null ? '' : title).trim().slice(0, 140);
    if (!text) return { ok: false, error: 'bad_request' };
    const r = await helix('PATCH', '/channels?broadcaster_id=' + encodeURIComponent(id), { title: text });
    return r.ok ? { ok: true } : { ok: false, error: mapActionError(r) };
  }

  // Set the stream category by name (channel:manage:broadcast). Resolves the name
  // to a game_id via Search Categories first (best match), so the user types the
  // game like they would in the dashboard rather than hunting for an id.
  async function setGame(name) {
    const id = await broadcasterId();
    if (!id) return { ok: false, error: 'not_connected' };
    const q = String(name == null ? '' : name).trim().slice(0, 100);
    if (!q) return { ok: false, error: 'bad_request' };
    const s = await helix('GET', '/search/categories?first=1&query=' + encodeURIComponent(q));
    if (!s.ok) return { ok: false, error: mapActionError(s) };
    const game = s.data && Array.isArray(s.data.data) && s.data.data[0];
    if (!game || !game.id) return { ok: false, error: 'no_category' };
    const r = await helix('PATCH', '/channels?broadcaster_id=' + encodeURIComponent(id), { game_id: String(game.id) });
    return r.ok ? { ok: true } : { ok: false, error: mapActionError(r) };
  }

  // Send a chat message to your own channel (user:write:chat). The endpoint can
  // answer HTTP 200 yet drop the message (is_sent:false, e.g. AutoMod) — surface
  // that as 'not_sent' instead of a false success.
  async function sendChat(message) {
    const id = await broadcasterId();
    if (!id) return { ok: false, error: 'not_connected' };
    const msg = String(message == null ? '' : message).trim().slice(0, 500);
    if (!msg) return { ok: false, error: 'bad_request' };
    const r = await helix('POST', '/chat/messages', { broadcaster_id: id, sender_id: id, message: msg });
    if (!r.ok) return { ok: false, error: mapActionError(r) };
    const sent = r.data && Array.isArray(r.data.data) && r.data.data[0];
    return sent && sent.is_sent === false ? { ok: false, error: 'not_sent' } : { ok: true };
  }

  // Shout out another channel by login (moderator:manage:shoutouts). Resolves the
  // login to a user id first. Requires the channel to be live and is rate-limited
  // by Twitch (a too-soon repeat answers 429 → surfaced as 'http_429').
  async function shoutout(login) {
    const id = await broadcasterId();
    if (!id) return { ok: false, error: 'not_connected' };
    const name = String(login == null ? '' : login).trim().replace(/^@/, '').toLowerCase().slice(0, 50);
    if (!name) return { ok: false, error: 'bad_request' };
    const u = await helix('GET', '/users?login=' + encodeURIComponent(name));
    if (!u.ok) return { ok: false, error: mapActionError(u) };
    const target = u.data && Array.isArray(u.data.data) && u.data.data[0];
    if (!target || !target.id) return { ok: false, error: 'no_user' };
    const qs = '?from_broadcaster_id=' + encodeURIComponent(id) +
      '&to_broadcaster_id=' + encodeURIComponent(target.id) +
      '&moderator_id=' + encodeURIComponent(id);
    const r = await helix('POST', '/chat/shoutouts' + qs);
    return r.ok ? { ok: true } : { ok: false, error: mapActionError(r) };
  }

  // Change a chat mode (moderator:manage:chat_settings). `off` clears emote-only,
  // follower-only, subscriber-only and slow mode in one call.
  const CHAT_MODE_BODIES = {
    emoteonly:   { emote_mode: true },
    followers:   { follower_mode: true },
    subscribers: { subscriber_mode: true },
    slow:        { slow_mode: true, slow_mode_wait_time: 30 },
    off:         { emote_mode: false, follower_mode: false, subscriber_mode: false, slow_mode: false },
  };
  async function setChatMode(mode) {
    const id = await broadcasterId();
    if (!id) return { ok: false, error: 'not_connected' };
    const body = CHAT_MODE_BODIES[mode] || CHAT_MODE_BODIES.off;
    const qs = '?broadcaster_id=' + encodeURIComponent(id) + '&moderator_id=' + encodeURIComponent(id);
    const r = await helix('PATCH', '/chat/settings' + qs, body);
    return r.ok ? { ok: true } : { ok: false, error: mapActionError(r) };
  }

  // ── Watching: the channel lists behind the viewer widget ──────────────────
  // These are the only methods here that are not about the user's own channel.
  // Twitch has no daily quota like YouTube's (it is a shared points-per-minute
  // rate limit), so the caching below is about not re-asking the same question
  // every time a tile repaints, not about rationing a budget the user can run
  // out of. A live list goes stale quickly, hence the short TTL.
  const LIST_TTL_MS = 60 * 1000;
  const SEARCH_TTL_MS = 5 * 60 * 1000;
  const LIST_SIZE = 20;
  const watchCache = new Map();
  function watchGet(key, ttl) {
    const e = watchCache.get(key);
    return (e && Date.now() - e.at < ttl) ? e.data : null;
  }
  function watchSet(key, data) {
    if (watchCache.size >= 30) watchCache.clear();
    watchCache.set(key, { at: Date.now(), data });
    return data;
  }
  // Dropped on login and logout: a second account must never be shown the first
  // one's followed channels.
  function dropCaches() { watchCache.clear(); chanIdCache.clear(); }

  // Thumbnails are painted as CSS background-images by the client, so the scheme
  // is allowlisted here rather than trusted from the API. Stream previews arrive
  // with {width}/{height} placeholders that have to be filled in or the URL 404s.
  function art(raw) {
    const url = String(raw || '').replace('{width}', '320').replace('{height}', '180');
    return /^https:\/\//.test(url) ? url : '';
  }
  // A Twitch login is what the client puts in the player URL, so its shape is
  // fixed here at the boundary. Anything else is dropped from the list rather
  // than handed on: a row with no login is a row with nothing to play.
  const LOGIN_RE = /^[A-Za-z0-9_]{1,25}$/;
  function channelRow(login, name, title, game, viewers, image, live) {
    const id = String(login || '').toLowerCase();
    if (!LOGIN_RE.test(id)) return null;
    // `viewers` is absent from search results, and Number(null) is 0 — which
    // would put a confident "0 watching" on a row Twitch never gave a count for.
    // Absent has to stay absent so the client can leave the badge off.
    const count = Number(viewers);
    return {
      login: id,
      name: String(name || id).slice(0, 60),
      title: String(title || '').slice(0, 200),
      game: String(game || '').slice(0, 80),
      viewers: (viewers == null || !Number.isFinite(count)) ? null : count,
      image: art(image),
      live: !!live,
    };
  }
  const rowsOf = (r, map) => (r.data && Array.isArray(r.data.data) ? r.data.data : []).map(map).filter(Boolean);

  // The channels you follow that are on air right now (user:read:follows).
  // A token minted before that scope existed answers 401 with a message naming
  // it, which is a completely different situation from a dead token: one needs a
  // reconnect and the other needs a login. They are told apart here so the widget
  // can say which.
  async function followedChannels() {
    const id = await broadcasterId();
    if (!id) return { ok: false, error: 'not_connected' };
    const hit = watchGet('followed', LIST_TTL_MS);
    if (hit) return hit;
    const r = await helix('GET', '/streams/followed?first=' + LIST_SIZE + '&user_id=' + encodeURIComponent(id));
    if (!r.ok) {
      const msg = String((r.data && r.data.message) || '').toLowerCase();
      if (r.status === 401 && msg.includes('scope')) return { ok: false, error: 'scope' };
      return { ok: false, error: mapActionError(r) };
    }
    const channels = rowsOf(r, s => channelRow(s.user_login, s.user_name, s.title, s.game_name, s.viewer_count, s.thumbnail_url, true));
    return watchSet('followed', { ok: true, channels });
  }

  // The busiest live channels right now. No scope: any valid user token does.
  async function topChannels() {
    const hit = watchGet('top', LIST_TTL_MS);
    if (hit) return hit;
    const r = await helix('GET', '/streams?first=' + LIST_SIZE);
    if (!r.ok) return { ok: false, error: mapActionError(r) };
    const channels = rowsOf(r, s => channelRow(s.user_login, s.user_name, s.title, s.game_name, s.viewer_count, s.thumbnail_url, true));
    return watchSet('top', { ok: true, channels });
  }

  // Search channels by name. Live ones only: this list exists to be watched, and
  // a channel that is off air has nothing to put in the player. Search Channels
  // returns the profile picture rather than a preview and carries no viewer
  // count, so those two fields are simply absent — the row says less, it does not
  // say something false.
  async function searchChannels(query) {
    const q = String(query == null ? '' : query).trim().slice(0, 100);
    if (q.length < 2) return { ok: false, error: 'bad_request' };
    const key = 'q:' + q.toLowerCase();
    const hit = watchGet(key, SEARCH_TTL_MS);
    if (hit) return hit;
    const r = await helix('GET', '/search/channels?live_only=true&first=' + LIST_SIZE + '&query=' + encodeURIComponent(q));
    if (!r.ok) return { ok: false, error: mapActionError(r) };
    const channels = rowsOf(r, c => channelRow(c.broadcaster_login, c.display_name, c.title, c.game_name, null, c.thumbnail_url, c.is_live !== false));
    return watchSet(key, { ok: true, channels });
  }

  // Speak in ANOTHER channel's chat (user:write:chat). sendChat() above always
  // speaks in the user's own channel, which is the streamer's case; the watching
  // widget needs to answer in the chat of whatever it is showing. Same scope,
  // same endpoint, different broadcaster_id — the sender is still the user.
  //
  // This exists because dropping Twitch's chat iframe took writing away with it.
  // The iframe carried the user's Twitch session, so on a browser where they were
  // signed in they could type in it; our own reader is a socket joined
  // anonymously and can only listen. Reading and writing are simply two different
  // things here, and this is the writing half.
  const chanIdCache = new Map();
  async function userIdFor(login) {
    if (chanIdCache.has(login)) return chanIdCache.get(login);
    const u = await helix('GET', '/users?login=' + encodeURIComponent(login));
    const found = u.ok && u.data && Array.isArray(u.data.data) && u.data.data[0];
    const id = found && found.id ? String(found.id) : '';
    if (id) {
      if (chanIdCache.size >= 50) chanIdCache.clear();
      chanIdCache.set(login, id);
    }
    return id;
  }
  async function sendChatTo(channel, message) {
    const me = await broadcasterId();
    if (!me) return { ok: false, error: 'not_connected' };
    const name = String(channel == null ? '' : channel).trim().toLowerCase();
    if (!LOGIN_RE.test(name)) return { ok: false, error: 'bad_request' };
    const msg = String(message == null ? '' : message).trim().slice(0, 500);
    if (!msg) return { ok: false, error: 'bad_request' };
    const target = await userIdFor(name);
    if (!target) return { ok: false, error: 'no_user' };
    const r = await helix('POST', '/chat/messages', { broadcaster_id: target, sender_id: me, message: msg });
    // 403 here is not a broken connection: it is the channel refusing this
    // message (followers-only, subscribers-only, a slow mode, a ban). Mapping it
    // to 'not_connected' would send the user to reconnect an account that is
    // perfectly fine, which is the mistake the followed-list scope check exists
    // to avoid.
    if (!r.ok) return { ok: false, error: r.status === 403 ? 'refused' : mapActionError(r) };
    // The endpoint can answer 200 and still drop the message (AutoMod, a mode the
    // sender does not meet). A false success is worse than an error: the user
    // would watch for a message that never arrives.
    const sent = r.data && Array.isArray(r.data.data) && r.data.data[0];
    return sent && sent.is_sent === false ? { ok: false, error: 'not_sent' } : { ok: true };
  }

  // The emotes usable in a channel's chat: the channel's own first, then the
  // global set. Neither needs a scope, so this asks for nothing the user has not
  // already granted — which is why it stops there. The emotes a user personally
  // owns from OTHER channels they subscribe to would need `user:read:emotes`, and
  // another "reconnect once" for a picker is not a trade worth making.
  const EMOTE_NAME_RE = /^[A-Za-z0-9_():;\-<>\\/|]{1,60}$/;
  const EMOTE_LIST_TTL_MS = 10 * 60 * 1000;
  const EMOTE_CAP = 200;
  function emoteRows(r) {
    return (r.ok && r.data && Array.isArray(r.data.data) ? r.data.data : []).map(e => {
      const name = String((e && e.name) || '');
      const url = String((e && e.images && (e.images.url_1x || e.images.url_2x)) || '');
      if (!EMOTE_NAME_RE.test(name) || !/^https:\/\//.test(url)) return null;
      return { name, url };
    }).filter(Boolean);
  }
  async function channelEmotes(channel) {
    const name = String(channel == null ? '' : channel).trim().toLowerCase();
    if (!LOGIN_RE.test(name)) return { ok: false, error: 'bad_request' };
    const key = 'em:' + name;
    const hit = watchGet(key, EMOTE_LIST_TTL_MS);
    if (hit) return hit;
    const id = await userIdFor(name);
    if (!id) return { ok: false, error: 'no_user' };
    const [ch, gl] = await Promise.all([
      helix('GET', '/chat/emotes?broadcaster_id=' + encodeURIComponent(id)),
      helix('GET', '/chat/emotes/global'),
    ]);
    // A channel with no emotes of its own is normal, and the global set alone is
    // still a useful picker — so this fails only when BOTH calls fail.
    if (!ch.ok && !gl.ok) return { ok: false, error: mapActionError(gl) };
    const seen = new Set();
    const emotes = [];
    emoteRows(ch).concat(emoteRows(gl)).forEach(e => {
      if (seen.has(e.name) || emotes.length >= EMOTE_CAP) return;
      seen.add(e.name);
      emotes.push(e);
    });
    return watchSet(key, { ok: true, emotes });
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

  return { startDeviceLogin, pollDeviceToken, getAccessToken, status, logout, helix, configured, broadcasterId, createClip, createMarker, runAd, setTitle, setGame, sendChat, shoutout, setChatMode, streamStatus, followedChannels, topChannels, searchChannels, sendChatTo, channelEmotes };
}

module.exports = { createTwitchProvider, normalizeStreamTwitch };
