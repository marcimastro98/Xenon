// What the engine does to open Discord.

const { readBody } = require('../http/read-body.js');
const discordLaunch = require('../discord-launch.js');

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
};

module.exports = { branches };
