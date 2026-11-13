// What the YouTube routes do: sign-in, the broadcast and its title, privacy and stream key,
// playlists, search and chat.

const { streams } = require('./providers.js');
const { readBody } = require('../http/read-body.js');
const { sdkFeatureEnabled, sdkGrantsFor } = require('../widget-sdk/grants.js');
const { sdkTileGate } = require('../widget-sdk/tile-cache.js');

/** @type {Record<string, (req: any, res: any, context: any) => Promise<void>>} */
const branches = {
  'GET /stream/youtube/status': async (_req, _res, { json, err500 }) => {
    try { json(await streams.youtube.status()); }
    catch (e) { err500(e.message); }
  },

  'POST /stream/youtube/login': async (req, _res, { json, err500 }) => {
    try { await readBody(req); json(await streams.youtube.startDeviceLogin()); }
    catch (e) { err500(e.message); }
  },

  'POST /stream/youtube/login/poll': async (req, _res, { json, err500 }) => {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      json(await streams.youtube.pollDeviceToken(body.deviceCode));
    } catch (e) { err500(e.message); }
  },

  'POST /stream/youtube/logout': async (req, _res, { json, err500 }) => {
    try { await readBody(req); json(await streams.youtube.logout()); }
    catch (e) { err500(e.message); }
  },

  'GET /stream/youtube/broadcast': async (_req, _res, { json, err500 }) => {
    // Live broadcast status + viewer count for the YouTube widget. Quota-aware:
    // the client polls only while the tile is visible.
    try { json(await streams.youtube.broadcastStatus()); }
    catch (e) { err500(e.message); }
  },

  'POST /stream/youtube/title': async (req, _res, { json, err500 }) => {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      json(await streams.youtube.updateBroadcastTitle(body.title));
    } catch (e) { err500(e.message); }
  },

  'GET /stream/youtube/playlists': async (_req, _res, { json, err500 }) => {
    // Viewer mode: the signed-in user's own playlists for the widget. Quota-kind:
    // the provider caches the list for 5 minutes and the client loads it once.
    try { json(await streams.youtube.listPlaylists()); }
    catch (e) { err500(e.message); }
  },

  'POST /stream/youtube/playlist/resolve': async (req, _res, { json, err500 }) => {
    // Playlist id → watch URL of its first video. The id is strictly validated in
    // the provider; the client opens the returned URL (Browser tile or openUrl
    // action) — a wire-supplied URL is never opened directly.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      json(await streams.youtube.resolvePlaylistUrl(body.id));
    } catch (e) { err500(e.message); }
  },

  'GET /stream/youtube/liked': async (_req, _res, { json, err500 }) => {
    // Viewer mode video lists. All three are cheap (1-2 quota units) and cached
    // in the provider, so a GET is right: they read, they never mutate.
    try { json(await streams.youtube.likedVideos()); }
    catch (e) { err500(e.message); }
  },

  'GET /stream/youtube/playlist/items': async (_req, _res, { json, err500, urlObj }) => {
    try { json(await streams.youtube.playlistVideos(urlObj.searchParams.get('id') || '')); }
    catch (e) { err500(e.message); }
  },

  'GET /stream/youtube/subscriptions': async (_req, _res, { json, err500 }) => {
    try { json(await streams.youtube.subscriptionsFeed()); }
    catch (e) { err500(e.message); }
  },

  'POST /stream/youtube/query': async (req, _res, { json }) => {
    // Authenticated YouTube READS for SDK widgets: an allowlisted `op` plus
    // bounded params, never a path and never the token. The allowlist lives in
    // stream-youtube.js so there is one table rather than a route that can be
    // talked into a general Google proxy.
    //
    // POST for the same reason /stream/youtube/search is (quota, not state), and
    // gated per package on top: a miss spends the USER's 10,000 units a day, and
    // those units are shared with Xenon's own YouTube tile. A widget that burns
    // them leaves the person with a dead YouTube integration until midnight
    // Pacific, which they would experience as Xenon being broken.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const pkgId = String(body.pkg || '');
      if (!sdkFeatureEnabled() || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(pkgId)) { json({ ok: false, error: 'not_allowed' }); return; }
      if (!sdkGrantsFor(pkgId).streams.includes('youtube')) { json({ ok: false, error: 'not_allowed' }); return; }
      const release = sdkTileGate(pkgId, 'tile');
      if (!release) { json({ ok: false, error: 'rate_limited' }); return; }
      try {
        const p = (body.params && typeof body.params === 'object') ? body.params : {};
        const params = {};
        for (const k of ['id', 'q', 'pageToken', 'order']) {
          if (p[k] !== undefined && p[k] !== null) params[k] = String(p[k]).slice(0, 400);
        }
        json(await streams.youtube.query(String(body.op || ''), params));
      } finally { release(); }
    } catch (e) { json({ ok: false, error: String((e && e.message) || e) }); }
  },

  'POST /stream/youtube/search': async (req, _res, { json, err500 }) => {
    // POST, and in CSRF_MUTATION_PATHS, because of what it costs rather than what
    // it changes: one search is 100 of the account's 10,000 daily quota units, so
    // a cross-site drive-by could burn a user's whole day of YouTube access in a
    // couple of hundred requests. The cheap reads above don't need this.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      json(await streams.youtube.searchVideos(body.q));
    } catch (e) { err500(e.message); }
  },

  'POST /stream/youtube/broadcast/create': async (req, _res, { json, err500 }) => {
    // Creates the broadcast AND the channel's ingestion endpoint if it has none,
    // so a stream can start without a trip to YouTube Studio. Writes, so it is in
    // CSRF_MUTATION_PATHS.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      json(await streams.youtube.createBroadcast(body.title, body.privacy));
    } catch (e) { err500(e.message); }
  },

  'POST /stream/youtube/broadcast/cancel': async (_req, _res, { json, err500 }) => {
    try { json(await streams.youtube.cancelBroadcast()); }
    catch (e) { err500(e.message); }
  },

  'POST /stream/youtube/privacy': async (req, _res, { json, err500 }) => {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      json(await streams.youtube.setPrivacy(body.privacy));
    } catch (e) { err500(e.message); }
  },

  'GET /stream/youtube/streamkey': async (_req, _res, { json, err500 }) => {
    // The RTMP address and stream key for OBS. A real credential — whoever holds
    // it can broadcast to the channel — so this one is in REMOTE_DENY: a paired
    // phone cannot ask for it, only the dashboard on this PC can.
    try { json(await streams.youtube.streamKey()); }
    catch (e) { err500(e.message); }
  },

  'GET /stream/youtube/chat': async (_req, _res, { json, err500, urlObj }) => {
    // Live chat page. A plain GET like the other viewer reads, but it IS in
    // CSRF_MUTATION_PATHS: the provider's throttle is keyed on the page token, so
    // "it cannot be hammered" was only true of a caller that asks the same
    // question twice. A drive-by varying ?page= misses the cache every time.
    try { json(await streams.youtube.chatMessages(urlObj.searchParams.get('page') || '')); }
    catch (e) { err500(e.message); }
  },

  'POST /stream/youtube/chat/send': async (req, _res, { json, err500 }) => {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      json(await streams.youtube.sendChat(body.text));
    } catch (e) { err500(e.message); }
  },
};

module.exports = { branches };
