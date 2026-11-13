// Opening a Discord conversation from a mirrored message.

const discordLaunch = require('../discord-launch.js');
const { discordLink } = require('./link.js');

// "Reply" on a mirrored DM or mention, from the built-in widget and from SDK ones.
const openDiscordChat = (channelId) => discordLaunch.openConversation(channelId, {
  launch: () => discordLaunch.launchDiscord(),
  select: (id) => discordLink.rpc.openTextChannel(id),
});

module.exports = { openDiscordChat };
