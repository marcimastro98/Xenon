'use strict';
// What can be done to the user's own Twitch broadcast from the Deck: a clip, a marker, an ad,
// the title, the game, a chat message, a shoutout, the chat modes, and whether the channel is
// live.

function makeBroadcast({ helix, broadcasterId, mapActionError }) {
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

  return {
    createClip, createMarker, runAd, setTitle, setGame, sendChat, shoutout, setChatMode, streamStatus,
  };
}

module.exports = { makeBroadcast };
