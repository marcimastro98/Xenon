// What the engine does to open Discord.

const { readBody } = require('../http/read-body.js');
const discordLaunch = require('./discord-launch.js');
const { discordLink } = require('./link.js');
const { normalizeDiscordNotifications } = require('../settings/normalize-notifications.js');
const { hub } = require('../settings/current.js');
const { discordMirror } = require('./mirrored.js');
const { stopDiscordWatch } = require('./watch-stop.js');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'POST /stream/discord/launch': async (req, _res, { json }) => {
    // Start the Discord desktop app so the widget's "Open Discord" overlay can
    // bring it up when it isn't running. One fixed launch per platform
    // (discord-launch.js): this used to be PowerShell only, so the button did
    // nothing on macOS and Linux. No user/settings input reaches the spawn.
    await readBody(req);
    json(await discordLaunch.launchDiscord());
  },

  'POST /stream/discord/open-chat': async (req, _res, { json }, { openDiscordChat }) => {
    // The widget's "Reply" on a mirrored DM or mention: bring Discord forward on
    // this PC and show that conversation. Discord's local connection cannot send
    // a message, so this is the reply button it allows. The channel id only ever
    // reaches Discord's own connection, checked as a snowflake there and here.
    let body = {};
    try { body = JSON.parse((await readBody(req, 4096)) || '{}'); } catch { body = {}; }
    json(await openDiscordChat(body && body.channelId));

  // ── Spotify integration (Authorization Code + PKCE — redirect flow) ──────────
  // Responses never include tokens — only { connected, login, configured } or the
  // authorize URL the user opens. Playback CONTROL runs through /actions/run (the
  // allowlisted spotify* Deck actions); these routes are reads + the OAuth dance.
  },

  'GET /stream/discord/status': async (_req, _res, { json, err500 }) => {
    try { json(await discordLink.rpc.status()); }
    catch (e) { err500(e.message); }
  },

  'GET /stream/discord/channels': async (_req, _res, { json }) => {
    // Voice channels across the user's guilds, for the Deck editor's join picker
    // and the dashboard widget's channel list. Returns {ok:false} (not an error)
    // when Discord is offline so callers fall back to a typed channel-id field.
    try { json({ ok: true, channels: await discordLink.rpc.listVoiceChannels() }); }
    catch (e) { json({ ok: false, channels: [], error: String((e && e.message) || e) }); }
  },

  'GET /stream/discord/sounds': async (_req, _res, { json }) => {
    // The user's soundboard sounds (guild + built-in), for the Deck editor's
    // soundboard picker. Client-safe (id + guild + name); {ok:false} with an empty
    // list when Discord is offline so the picker degrades instead of erroring.
    try { json({ ok: true, sounds: await discordLink.rpc.listSoundboardSounds() }); }
    catch (e) { json({ ok: false, sounds: [], error: String((e && e.message) || e) }); }
  },

  'GET /stream/discord/voice': async (_req, _res, { json }, { refreshDiscordWatch }) => {
    // Live voice state for the dashboard widget (self mute/deaf, mode, volumes,
    // audio processing, current channel + members). Client-safe; {ok:false} when
    // offline. The widget reads this once on mount for an instant paint, then gets
    // real-time updates over SSE — so this read also arms the event watch.
    refreshDiscordWatch();
    try { json(await discordLink.rpc.voiceState()); }
    catch (e) { json({ ok: false, error: String((e && e.message) || e) }); }
  },

  'GET /stream/discord/roster': async (_req, _res, { json }) => {
    // Who's currently connected in each voice channel, for the widget's Channels
    // tab. The client polls this only while that tab is open and the tile is
    // visible, so the per-channel reads stay off the idle path. Client-safe
    // (names + mute/deaf only); {ok:false} when Discord is offline.
    try { json(await discordLink.rpc.voiceRoster()); }
    catch (e) { json({ ok: false, error: String((e && e.message) || e) }); }
  },

  'GET /stream/discord/notifications': async (_req, _res, { json }) => {
    // Seed for the widget's Notifications tab: the feature flags + the bounded
    // recent-notification buffer. New items then stream live over the
    // `discord_notification` SSE event. Notification text is private user data —
    // loopback-only like every route, and NEVER a JSONP candidate.
    const dn = normalizeDiscordNotifications(hub.settings && hub.settings.discordNotifications);
    json({ ok: true, enabled: dn.enabled, hide: dn.hide, state: discordLink.rpc.notifStatus(), items: discordMirror.notifications });
  },

  'POST /stream/discord/login': async (req, _res, { json }, { refreshDiscordWatch }) => {
    // Blocks until the user approves the consent dialog in the Discord client (or
    // it times out) — a single round-trip, unlike the device-code providers. The
    // watch is torn down BEFORE login, not after: Discord may serve only one
    // concurrent RPC client, so a live watch holding the pipe made the login
    // socket fail with a misleading "Discord isn't running". refreshDiscordWatch
    // re-arms cleanly on the fresh token afterwards.
    try {
      await readBody(req);
      stopDiscordWatch();
      const r = await discordLink.rpc.login();
      refreshDiscordWatch();
      json(r);
    } catch (e) {
      // JSON, never a bare 500: the page reads the reason from the body, and a
      // plain-text error left it with nothing but "Could not start login".
      console.error('[discord] login route failed:', e && e.message);
      json({ ok: false, error: 'login_failed', detail: String((e && e.message) || e).slice(0, 200) });
    }
  },

  'POST /stream/discord/logout': async (req, _res, { json, err500 }, { refreshDiscordWatch }) => {
    // Watch down FIRST: logout's close() would otherwise schedule a reconnect
    // racing the revoke, and the dying watch held the (possibly single) pipe.
    try {
      await readBody(req);
      stopDiscordWatch();
      const r = await discordLink.rpc.logout();
      discordMirror.notifications = [];
      refreshDiscordWatch();
      json(r);
    } catch (e) { err500(e.message); }
  },
};

module.exports = { branches };
