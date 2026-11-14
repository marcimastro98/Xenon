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
const { makeCredsNormalizer, createTokenStore } = require('./stream-common');

const { API } = require('./streaming/youtube-endpoints.js');

const normalizeStreamYouTube = makeCredsNormalizer({ channel: 120, channelId: 60 });

const { makeChat } = require('./streaming/youtube-chat.js');

const { makeLibrary } = require('./streaming/youtube-library.js');

const { makeLive } = require('./streaming/youtube-live.js');

const { makeVideoRows } = require('./streaming/youtube-video-rows.js');

const { makeSignIn } = require('./streaming/youtube-sign-in.js');

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

  const {
    configured, startDeviceLogin, pollDeviceToken, refresh, status, logout,
  } = makeSignIn({ _fetch, clientId, clientSecret, creds, patchCreds, clearCreds, persistToken, dropCaches });

  const getAccessToken = makeGetAccessToken(refresh);

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

  function apiReason(r) {
    const e = r && r.data && r.data.error && r.data.error.errors && r.data.error.errors[0];
    return (e && e.reason) || (r && r.error) || ('http_' + (r && r.status || '?'));
  }

  const onAir = {
    // The broadcast currently on screen, remembered between calls. The chat reads
    // below need its liveChatId, and re-finding the broadcast on every poll would
    // double what the chat costs in quota for an answer that changes once a stream.
    liveCtx: { id: '', chatId: '' },
  };

  // ── Viewer mode: playlists, liked videos, subscriptions, search ───────────
  // YouTube playlist ids are URL-safe base64 tokens; validated before any
  // interpolation so a wire-supplied id can never reshape the API path.
  const PLAYLIST_ID_RE = /^[A-Za-z0-9_-]{2,64}$/;
  const PLAYLIST_TTL_MS = 5 * 60 * 1000;
  const LIST_TTL_MS = 5 * 60 * 1000;         // liked videos, playlist contents
  const FEED_TTL_MS = 15 * 60 * 1000;        // subscriptions feed (costs ~18 units)
  const SEARCH_TTL_MS = 30 * 60 * 1000;      // a search costs 100 units — cache hard
  const UPLOADS_TTL_MS = 12 * 60 * 60 * 1000; // a channel's uploads-playlist id, which never changes
  const FEED_CHANNELS = 15;                  // channels polled per feed build
  const FEED_PER_CHANNEL = 3;
  let plCache = { at: 0, data: null };   // quota-kind: every surface shares one read
  // Bounded TTL cache for the video lists. The whole map is dropped on login and
  // logout so a second account never sees the first one's library.
  const listCache = new Map();
  // Also forgets which broadcast is on air: a different account's chat is not
  // this account's chat.
  function dropCaches() {
    plCache = { at: 0, data: null }; listCache.clear();
    onAir.liveCtx = { id: '', chatId: '' };
    chatMemory.chatCache = { at: 0, token: null, data: null, wait: 5000 };
    chatMemory.chatIdMissAt = 0;   // a different account may well be live
  }

  const VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,24}$/;
  const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{20,30}$/;

  // ── Paging ──────────────────────────────────────────────────────────────────
  // Google's page tokens are opaque, so we do not parse them — but one arrives
  // from a widget and ends up inside a query string, so the alphabet is checked
  // at the boundary. `null` means "unusable": callers must refuse rather than
  // fall back to page one, since answering page one under the name of page two is
  // how a widget ends up paging forever over the same rows.
  // Shared with the live-chat reader below, which was the first caller: same
  // opaque tokens, same alphabet, and one shape check is easier to trust than two.
  const PAGE_TOKEN_RE = /^[A-Za-z0-9_.\-=]{1,400}$/;
  const {
    cacheGet, cacheSet, thumb, pageArg, pageQs, nextToken, detailsFor, videoDetail, mapVideo,
  } = makeVideoRows({ apiRequest, listCache, VIDEO_ID_RE, CHANNEL_ID_RE, PAGE_TOKEN_RE });

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

  // ── Channel reads ───────────────────────────────────────────────────────────
  // Added for widgets (see query() below): the built-in tile browses your own
  // library, a widget may want to browse a CHANNEL. All three are 1 quota unit a
  // page — deliberately not search, which is 100.

  // The channels the user subscribes to. Alphabetical by default, because a list
  // to look down is easier to find a name in than a ranked one.
  //
  // `order` is the caller's, though: YouTube's own three are meaningfully
  // different views of the same list, and a widget offering "YouTube order" has
  // to be able to ask for it. An order we do not have is REFUSED rather than
  // quietly replaced with the default — this whole parameter exists because a
  // widget was showing "Pertinence" over a list that was silently alphabetical,
  // and answering the wrong question confidently is what caused that.
  const SUB_ORDERS = Object.freeze(['alphabetical', 'relevance', 'unread']);
  const {
    likedVideos, playlistVideos, subscriptionsFeed, searchVideos, subscriptionChannels, channelVideos,
    channelPlaylists, resolvePlaylistUrl,
  } = makeLibrary({ getAccessToken, apiRequest, apiReason, PLAYLIST_ID_RE, LIST_TTL_MS, FEED_TTL_MS, SEARCH_TTL_MS, UPLOADS_TTL_MS, FEED_CHANNELS, FEED_PER_CHANNEL, cacheGet, cacheSet, thumb, VIDEO_ID_RE, CHANNEL_ID_RE, pageArg, pageQs, nextToken, detailsFor, videoDetail, mapVideo, SUB_ORDERS });

  // ── The SDK read surface ────────────────────────────────────────────────────
  // Six named reads for community widgets, and nothing else. Same shape as the
  // Spotify one: a widget names an `op`, never a path, and never holds the
  // account — the token stays here.
  //
  // Two differences from Spotify's, both because of quota. YouTube gives an app
  // 10,000 units a day and a single search costs 100 of them, so the answers
  // here are the ones this file already caches, and the rows are Xenon's own
  // compact shape rather than Google's raw objects: the widget gets the fields a
  // list actually draws, and we keep one place where the API's shape is read.
  const QUERY_OPS = Object.freeze({
    subscriptionFeed:    () => subscriptionsFeed(),
    subscriptionChannels: (p) => subscriptionChannels(p.pageToken, p.order),
    searchVideos:        (p) => searchVideos(p.q, p.pageToken),
    channelVideos:       (p) => channelVideos(p.id, p.pageToken),
    channelPlaylists:    (p) => channelPlaylists(p.id, p.pageToken),
    playlistVideos:      (p) => playlistVideos(p.id, p.pageToken),
  });

  async function query(op, params) {
    // hasOwn, not a plain lookup: `constructor` and friends resolve up the
    // prototype chain to real functions, so a bare index would have called one.
    // Object.freeze does not close that — asking about OWN keys does.
    const name = String(op || '');
    const run = Object.hasOwn(QUERY_OPS, name) ? QUERY_OPS[name] : null;
    if (typeof run !== 'function') return { ok: false, error: 'bad_op' };
    const r = await run(params && typeof params === 'object' ? params : {});
    if (!r || r.ok !== true) return { ok: false, error: (r && r.error) || 'failed' };
    // The op decides what the answer holds, so the reply is the row list plus the
    // token — never the provider object, which would leak whatever a future read
    // happens to put in it.
    const data = {};
    if (Array.isArray(r.videos)) data.videos = r.videos;
    if (Array.isArray(r.channels)) data.channels = r.channels;
    if (Array.isArray(r.playlists)) data.playlists = r.playlists;
    data.nextPageToken = typeof r.nextPageToken === 'string' ? r.nextPageToken : '';
    return { ok: true, data };
  }

  // ── Creator mode: start a stream from nothing, chat, privacy, ingest ───────
  const PRIVACY = ['public', 'unlisted', 'private'];

  const {
    findBroadcast, broadcastStatus, updateBroadcastTitle, transitionBroadcast, createBroadcast,
    cancelBroadcast, setPrivacy, streamKey,
  } = makeLive({ getAccessToken, apiRequest, apiReason, onAir, PRIVACY });

  // A MISS is remembered too, and that is the half that was missing. liveCtx
  // only ever caches a chat that exists, so with no broadcast on air every chat
  // poll re-ran findBroadcast() — two uncached liveBroadcasts.list calls, on the
  // one read that repeats for as long as the widget is open. Being idle was the
  // expensive case, which is backwards. Short enough that going live is picked
  // up promptly, and the status poll sets liveCtx directly anyway.
  const CHAT_ID_MISS_MS = 30000;
  const chatMemory = {
    chatIdMissAt: 0,
    // Live chat, page by page. YouTube states its own polling interval and we never
    // go below 5s: this is the one repeating creator read, so it is what decides
    // whether a long stream eats the day's quota. The same answer is handed back
    // until that interval is up, which is what lets the route stay a plain GET —
    // asking twenty times a second costs exactly as much as asking once.
    chatCache: { at: 0, token: null, data: null, wait: 5000 },
  };
  const {
    chatMessages, sendChat,
  } = makeChat({ getAccessToken, apiRequest, findBroadcast, apiReason, onAir, thumb, PAGE_TOKEN_RE, CHAT_ID_MISS_MS, chatMemory });

  return {
    startDeviceLogin, pollDeviceToken, getAccessToken, status, logout, apiRequest, configured,
    broadcastStatus, transitionBroadcast, updateBroadcastTitle,
    createBroadcast, cancelBroadcast, setPrivacy, streamKey, chatMessages, sendChat,
    listPlaylists, resolvePlaylistUrl, likedVideos, playlistVideos, subscriptionsFeed, searchVideos,
    subscriptionChannels, channelVideos, channelPlaylists, query,
  };
}

module.exports = { createYouTubeProvider, normalizeStreamYouTube };
