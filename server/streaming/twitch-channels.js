'use strict';
// The channels behind the Twitch viewer widget: the ones the user follows that are on air, the
// busiest ones, a search, a channel's id from its name, a message in the chat of the channel
// being watched, and the emotes usable there, each list kept for a short time.

const { streamMatches, mergeSearch } = require('./twitch-search-match.js');

function makeChannels({ helix, broadcasterId, mapActionError }) {
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

  // Search live channels the way Twitch's own search box does, as far as the
  // public API allows. Helix /search/channels matches channel NAMES only, while
  // twitch.tv also matches what a stream is ABOUT: its title and its tags.
  // Measured: "santa monica" returned nothing here and a whole page on
  // twitch.tv, because those words live in titles ("SANTA MONICA day 8") and
  // tags ("SantaMonica"), never in a channel name. Helix has no endpoint for
  // that, so the second half is ours: read the live streams in the viewer's
  // language (busiest first, up to SCAN_PAGES_LANG pages of 100) plus the
  // busiest ones in any language, and keep the ones whose title, tags, name or
  // game hold the words. Live ones only: this list exists to be watched.
  const SCAN_TTL_MS = 60 * 1000;
  const SCAN_PAGES_LANG = 20;
  const SCAN_PAGES_ALL = 3;
  const LANG_RE = /^[a-z]{2}$/;
  const scanInflight = new Map();

  // One read of the live directory, shared by every search for a minute: the
  // first search pays for it (23 requests at most, against a rate limit of 800
  // a minute), the ones after it are instant.
  function liveStreams(language, pages) {
    const key = 'scan:' + (language || '*');
    const hit = watchGet(key, SCAN_TTL_MS);
    if (hit) return Promise.resolve(hit);
    if (scanInflight.has(key)) return scanInflight.get(key);
    const run = (async () => {
      const out = [];
      let cursor = '';
      for (let i = 0; i < pages; i++) {
        const qs = 'first=100' + (language ? '&language=' + language : '') + (cursor ? '&after=' + encodeURIComponent(cursor) : '');
        const r = await helix('GET', '/streams?' + qs);
        const rows = r.ok && r.data && Array.isArray(r.data.data) ? r.data.data : null;
        if (!rows) break;
        out.push(...rows);
        cursor = (r.data.pagination && r.data.pagination.cursor) || '';
        // Only the cursor says whether there is more. Twitch's pages are often 97
        // to 99 rows long (measured), so a short page is not the last one.
        if (!cursor || !rows.length) break;
      }
      // A failed first page is not an empty directory: nothing is cached, so the
      // next search asks again instead of finding nothing for a minute.
      return out.length ? watchSet(key, out) : out;
    })().finally(() => scanInflight.delete(key));
    scanInflight.set(key, run);
    return run;
  }

  async function searchChannels(query, opts) {
    const q = String(query == null ? '' : query).trim().slice(0, 100);
    if (q.length < 2) return { ok: false, error: 'bad_request' };
    const lang = String((opts && opts.language) || '').toLowerCase().slice(0, 2);
    const language = LANG_RE.test(lang) ? lang : '';
    const key = 'q:' + language + ':' + q.toLowerCase();
    const hit = watchGet(key, SEARCH_TTL_MS);
    if (hit) return hit;
    const [byName, inLang, inAll] = await Promise.all([
      helix('GET', '/search/channels?live_only=true&first=' + LIST_SIZE + '&query=' + encodeURIComponent(q)),
      language ? liveStreams(language, SCAN_PAGES_LANG) : Promise.resolve([]),
      liveStreams('', SCAN_PAGES_ALL),
    ]);
    // Search Channels returns the profile picture rather than a preview and
    // carries no viewer count, so on those rows the two fields stay absent: the
    // row says less, it does not say something false.
    const named = byName.ok ? rowsOf(byName, c => channelRow(c.broadcaster_login, c.display_name, c.title, c.game_name, null, c.thumbnail_url, c.is_live !== false)) : [];
    const streams = inLang.concat(inAll);
    // Only a total failure is an error: either half alone is still a search.
    if (!byName.ok && !streams.length) return { ok: false, error: mapActionError(byName) };
    const about = streams.filter(st => streamMatches(st, q))
      .map(st => channelRow(st.user_login, st.user_name, st.title, st.game_name, st.viewer_count, st.thumbnail_url, true));
    return watchSet(key, { ok: true, channels: mergeSearch(q, named, about) });
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

  return {
    watchCache, followedChannels, topChannels, searchChannels, chanIdCache, sendChatTo, channelEmotes,
  };
}

module.exports = { makeChannels };
