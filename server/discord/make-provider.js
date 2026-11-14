// Makes the connection to the Discord app on this PC from the app keys kept here. Called once
// where the engine loads, and again each time the person saves new keys in Settings →
// Streaming. Whoever calls it again closes the old connection first: this only makes the new one.

const { createDiscordProvider } = require('../discord-rpc.js');
const { discordNotifScopeWanted } = require('../settings/notification-switches.js');
const { STREAM_TOKENS_FILE, readStreamClientId } = require('../streaming/config-files.js');
const { discordLink } = require('./link.js');

function makeDiscordProvider() {
  discordLink.rpc = createDiscordProvider({
    clientId: readStreamClientId('discordClientId', 'DISCORD_CLIENT_ID'),
    clientSecret: readStreamClientId('discordClientSecret', 'DISCORD_CLIENT_SECRET'),
    tokensFile: STREAM_TOKENS_FILE,
    wantNotifications: discordNotifScopeWanted,
  });
}

module.exports = { makeDiscordProvider };
