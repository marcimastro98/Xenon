// What the Spotify routes do: sign-in and its return address, what is playing, the queue,
// playlists, devices and starting the app.

const { streams } = require('./providers.js');
const spotifyLaunch = require('../spotify-launch.js');
const { readBody } = require('../http/read-body.js');
const { spotifyRedirectUri, spotifyCallbackPage } = require('../media/spotify-connect.js');
const { sdkFeatureEnabled, sdkGrantsFor } = require('../widget-sdk/grants.js');
const { sdkTileGate } = require('../widget-sdk/tile-cache.js');
const { hub } = require('../settings/current.js');
const os = require('node:os');

/** @type {Record<string, (req: any, res: any, context: any) => Promise<void>>} */
const branches = {
  'GET /stream/spotify/status': async (_req, _res, { json, err500 }) => {
    // canStartMinimized: whether Settings may offer "start minimized" here.
    try { json({ ...(await streams.spotify.status()), canStartMinimized: await spotifyLaunch.canStartMinimized() }); }
    catch (e) { err500(e.message); }
  },

  'POST /stream/spotify/login': async (req, _res, { json, err500 }) => {
    // Return the authorize URL; the client opens it in a new window and polls
    // /status until the callback completes. The redirect_uri is pinned to the
    // loopback IP (Spotify rejects `localhost`) and MUST match the one the user
    // registered in their Spotify app — see docs/streaming-setup.md.
    try { await readBody(req); json(streams.spotify.buildAuthUrl(spotifyRedirectUri(req))); }
    catch (e) { err500(e.message); }
  },

  'GET /stream/spotify/callback': async (_req, res, { err500, urlObj }) => {
    // Spotify's redirect lands here (a top-level GET navigation, so no Origin
    // header and no CSRF_MUTATION_PATHS entry — the unguessable OAuth `state`,
    // minted by our own /login, is the CSRF guard). Exchange the code, then show a
    // tiny self-closing page; the Settings poll picks up the connected state.
    try {
      const sp = urlObj.searchParams;
      let ok = false;
      if (sp.get('error')) ok = false;                     // user denied consent
      else { const r = await streams.spotify.exchangeCode(sp.get('code'), sp.get('state')); ok = !!(r && r.ok); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(spotifyCallbackPage(ok));
    } catch (e) { err500(e.message); }
  },

  'POST /stream/spotify/logout': async (req, _res, { json, err500 }) => {
    try { await readBody(req); json(await streams.spotify.logout()); }
    catch (e) { err500(e.message); }
  },

  'GET /stream/spotify/query': async (_req, _res, { json, urlObj }) => {
    // Authenticated Spotify READS for SDK widgets: an allowlisted `op` plus
    // bounded params, never a path and never the token. The allowlist lives in
    // stream-spotify.js so there is one table rather than a route that can be
    // talked into a general proxy.
    //
    // Gated per package: a miss is a call against the USER's Spotify quota, and
    // that quota is shared with Xenon's own Spotify tile — a widget searching on
    // every keystroke would stop the dashboard's music working, which the person
    // would experience as Xenon being broken. Same gate the image routes use.
    try {
      const pkgId = String(urlObj.searchParams.get('pkg') || '');
      if (!sdkFeatureEnabled() || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(pkgId)) { json({ ok: false, error: 'not_allowed' }); return; }
      if (!sdkGrantsFor(pkgId).streams.includes('spotify')) { json({ ok: false, error: 'not_allowed' }); return; }
      const release = sdkTileGate(pkgId, 'tile');
      if (!release) { json({ ok: false, error: 'rate_limited' }); return; }
      try {
        const params = {};
        // Every field an op can read has to be named here AND in the bridge that
        // builds the request. A field missing from either list is not an error:
        // it is silently absent, and the op answers page 1 as if it had never
        // been asked for anything else.
        for (const k of ['id', 'q', 'types', 'limit', 'offset', 'after', 'before']) {
          const v = urlObj.searchParams.get(k);
          if (v !== null) params[k] = v;
        }
        json(await streams.spotify.query(urlObj.searchParams.get('op') || '', params));
      } finally { release(); }
    } catch (e) { json({ ok: false, error: String((e && e.message) || e) }); }
  },

  'GET /stream/spotify/queue': async (_req, _res, { json }) => {
    // "Up Next": the currently-playing track + the upcoming queue, for the widget.
    // The client polls this only while the tile is visible.
    try { json(await streams.spotify.getQueue()); }
    catch (e) { json({ ok: false, error: String((e && e.message) || e) }); }
  },

  'GET /stream/spotify/playlists': async (_req, _res, { json }) => {
    try { json(await streams.spotify.getPlaylists()); }
    catch (e) { json({ ok: false, error: String((e && e.message) || e) }); }
  },

  'GET /stream/spotify/devices': async (_req, _res, { json }) => {
    try { json(await streams.spotify.getDevices()); }
    catch (e) { json({ ok: false, error: String((e && e.message) || e) }); }
  },

  'GET /stream/spotify/player': async (_req, _res, { json, urlObj }) => {
    // Full now-playing state (track, progress, shuffle/repeat, device volume, liked)
    // for the widget's hero. Polled only while the tile is visible; playback control
    // itself still runs through the allowlisted /actions/run spotify* actions.
    // ?fresh=1 skips the snapshot cache — the post-control resync (next/prev/seek)
    // needs the live state, not a pre-action snapshot cached for the TTL.
    try { json(await streams.spotify.getPlayer({ fresh: urlObj.searchParams.get('fresh') === '1' })); }
    catch (e) { json({ ok: false, error: String((e && e.message) || e) }); }
  },

  'POST /stream/spotify/launch': async (req, _res, { json }) => {
    // Start the Spotify desktop app on this computer when the tile finds it closed
    // (spotify-launch.js picks the command per platform, minimized when the setting
    // asks and the platform can). With {play:true} it then waits for the app to
    // sign in and starts the music on this computer. The body carries one boolean;
    // nothing from it reaches a command line.
    try {
      let body = {};
      try { body = JSON.parse(await readBody(req) || '{}') || {}; } catch { body = {}; }
      const play = body.play === true;
      // Taken before the launch, so the new computer can be told apart on a Mac.
      const known = play ? await streams.spotify.computerIds() : null;
      const launched = await spotifyLaunch.launchSpotify({ minimized: hub.settings.spotifyStartMinimized === true });
      if (!launched.ok || !play) { json(launched); return; }
      const played = await streams.spotify.playWhenReady(os.hostname(), known);
      json({ ...played, launched: true, minimized: launched.minimized });
    } catch (e) { json({ ok: false, error: 'launch_failed' }); }
  },
};

module.exports = { branches };
