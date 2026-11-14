// Saves the app keys of the streaming accounts and makes the accounts again with them.

const fs = require('node:fs');
const { STREAM_CONFIG_FILE, STREAM_CONFIG_KEYS } = require('./config-files.js');
const { writeFileAtomic } = require('../atomic-write.js');
const { refreshDiscordWatch } = require('../discord/watch-refresh.js');
const { makeStreamProviders } = require('./make-providers.js');
const { discordLink } = require('../discord/link.js');
const { makeDiscordProvider } = require('../discord/make-provider.js');
const { stopDiscordWatch } = require('../discord/watch-stop.js');

async function saveStreamConfig(patch) {
  let cfg = {};
  try { cfg = JSON.parse(await fs.promises.readFile(STREAM_CONFIG_FILE, 'utf8')) || {}; } catch { cfg = {}; }
  for (const k of STREAM_CONFIG_KEYS) {
    if (patch && typeof patch[k] === 'string') cfg[k] = patch[k].trim().slice(0, 200);
  }
  await writeFileAtomic(STREAM_CONFIG_FILE, JSON.stringify(cfg, null, 2));
  makeStreamProviders();
  // Stop any live watch on the OLD provider first — closing it with a watcher
  // still attached would spin up a reconnect loop against the stale socket.
  stopDiscordWatch();
  try { discordLink.rpc.close(); } catch { /* ignore */ }
  makeDiscordProvider();
  refreshDiscordWatch();   // re-arm the watch if the new creds are linked and a dashboard is open
}

module.exports = { saveStreamConfig };
