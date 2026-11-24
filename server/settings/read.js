// Reads the settings file with every key checked, trying again while another program holds the
// file, and gives a write the settings to start from: the factory ones only when there is no
// file yet.

const { DEFAULT_HUB_SETTINGS } = require('./defaults.js');
// A file that has not changed is answered from memory (read-cache.js).
const { settingsReader } = require('./read-cache.js');

async function readHubSettings() { return settingsReader.read(); }

// For a read that a write is built on. Only a missing file (a new install)
// starts from the factory settings. Any other failure, a file that does not
// parse or a read that keeps failing, fails the write instead: these writers
// used to start from the factory settings whenever the read failed, and then
// saved that, which replaced everything the user had built with the default
// layout, theme and pages. POST /settings has always failed closed this way.
async function readHubSettingsForUpdate() {
  return (await readHubSettings()) || { ...DEFAULT_HUB_SETTINGS };
}

module.exports = { readHubSettings, readHubSettingsForUpdate };
