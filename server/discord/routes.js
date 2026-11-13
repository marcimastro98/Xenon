// What the engine does to open Discord.

const { readBody } = require('../http/read-body.js');
const discordLaunch = require('../discord-launch.js');

/** @type {Record<string, (req: any, res: any, context: any) => Promise<void>>} */
const branches = {
  'POST /stream/discord/launch': async (req, _res, { json }) => {
    // Start the Discord desktop app so the widget's "Open Discord" overlay can
    // bring it up when it isn't running. One fixed launch per platform
    // (discord-launch.js): this used to be PowerShell only, so the button did
    // nothing on macOS and Linux. No user/settings input reaches the spawn.
    await readBody(req);
    json(await discordLaunch.launchDiscord());
  },
};

module.exports = { branches };
