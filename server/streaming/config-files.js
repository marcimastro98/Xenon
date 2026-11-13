// Where the streaming apps' ids and sign-in tokens are kept, and the readers of both: an id
// comes from the environment or the file, the tokens only say who is connected.

const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('../engine/paths.js');

const STREAM_CONFIG_FILE = path.join(DATA_DIR, 'stream-config.json');
const STREAM_TOKENS_FILE = path.join(DATA_DIR, 'stream-tokens.json');

// Raw parse of the server-only OAuth token store; used ONLY to derive boolean
// "is this provider connected" flags. Token values never enter the backup.
async function _readStreamTokensSnapshot() {
  try { return JSON.parse(await fs.promises.readFile(STREAM_TOKENS_FILE, 'utf8')) || {}; }
  catch { return {}; }
}

// A streaming app client_id is CONFIGURATION, not committed source: resolve it
// from an env var first, then a gitignored `server/stream-config.json`, so the
// id (tied to the owner's personal Twitch/Google app) never lives in the public
// repo. Empty when unconfigured → the provider reports `configured:false`.
function readStreamClientId(configKey, envName) {
  if (process.env[envName]) return String(process.env[envName]).trim();
  try {
    const cfg = JSON.parse(fs.readFileSync(STREAM_CONFIG_FILE, 'utf8'));
    return String((cfg && cfg[configKey]) || '').trim();
  } catch { return ''; }
}

const STREAM_CONFIG_KEYS = ['twitchClientId', 'youtubeClientId', 'youtubeClientSecret', 'discordClientId', 'discordClientSecret', 'spotifyClientId'];

module.exports = {
  STREAM_CONFIG_FILE, STREAM_TOKENS_FILE, _readStreamTokensSnapshot, readStreamClientId,
  STREAM_CONFIG_KEYS,
};
