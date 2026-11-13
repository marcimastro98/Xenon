// What the Twitch routes do: sign-in, the live stream, followed and top channels, emotes,
// search and chat.

const { streams } = require('./providers.js');
const { readBody } = require('../http/read-body.js');

/** @type {Record<string, (req: any, res: any, context: any) => Promise<void>>} */
const branches = {
  'GET /stream/twitch/status': async (_req, _res, { json, err500 }) => {
    try { json(await streams.twitch.status()); }
    catch (e) { err500(e.message); }
  },

  'POST /stream/twitch/login': async (req, _res, { json, err500 }) => {
    try { await readBody(req); json(await streams.twitch.startDeviceLogin()); }
    catch (e) { err500(e.message); }
  },

  'POST /stream/twitch/login/poll': async (req, _res, { json, err500 }) => {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      json(await streams.twitch.pollDeviceToken(body.deviceCode));
    } catch (e) { err500(e.message); }
  },

  'POST /stream/twitch/logout': async (req, _res, { json, err500 }) => {
    try { await readBody(req); json(await streams.twitch.logout()); }
    catch (e) { err500(e.message); }
  },

  'GET /stream/twitch/stream': async (_req, _res, { json, err500 }) => {
    // Live status for the dashboard tile (viewer count / live-offline). Cheap
    // Helix call; the client polls only while the tile is visible.
    try { json(await streams.twitch.streamStatus()); }
    catch (e) { err500(e.message); }
  },

  'GET /stream/twitch/followed': async (_req, _res, { json, err500 }) => {
    // Watching-side channel lists. Reads, cached in the provider, and cheap on
    // Twitch's rate limit, so a GET is right and none of the three belongs in
    // CSRF_MUTATION_PATHS the way a YouTube search does — there is no daily
    // budget here for a drive-by to burn.
    try { json(await streams.twitch.followedChannels()); }
    catch (e) { err500(e.message); }
  },

  'GET /stream/twitch/top': async (_req, _res, { json, err500 }) => {
    try { json(await streams.twitch.topChannels()); }
    catch (e) { err500(e.message); }
  },

  'GET /stream/twitch/emotes': async (_req, _res, { json, err500, urlObj }) => {
    // The emotes usable in a channel's chat, for the picker. A read, cached in
    // the provider for ten minutes, needing no scope.
    try { json(await streams.twitch.channelEmotes(urlObj.searchParams.get('channel') || '')); }
    catch (e) { err500(e.message); }
  },

  'POST /stream/twitch/search': async (req, _res, { json, err500 }) => {
    // POST because it is the one of the three the user triggers by hand and the
    // one that sends arbitrary text outbound. Listed in CSRF_MUTATION_PATHS for
    // the same reason the YouTube search is.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      // The dashboard's language picks which live streams are read for title and
      // tag matches (see searchChannels); it is re-validated there.
      json(await streams.twitch.searchChannels(body.q, { language: body.lang }));
    } catch (e) { err500(e.message); }
  },

  'POST /stream/twitch/chat/send': async (req, _res, { json, err500 }) => {
    // Speaks publicly under the user's name in someone else's chat, so it is
    // POST-only and in CSRF_MUTATION_PATHS, exactly like the YouTube chat send.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      json(await streams.twitch.sendChatTo(body.channel, body.message));
    } catch (e) { err500(e.message); }

  // ── YouTube live integration (Google OAuth device flow) ──────────────────
  },
};

module.exports = { branches };
