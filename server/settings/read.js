// Reads the settings file with every key checked, trying again while another program holds the
// file, and gives a write the settings to start from: the factory ones only when there is no
// file yet.

const fs = require('node:fs');
const { _SETTINGS_READ_BUSY } = require('./store-file.js');
const { SETTINGS_FILE } = require('./settings-file.js');
const { DEFAULT_HUB_SETTINGS } = require('./defaults.js');
const { normalizeHubSettings } = require('./normalize-hub-settings.js');
const { settingsStore } = require('./store-state.js');

async function readHubSettings() {
  for (let attempt = 0; ; attempt++) {
    try {
      const raw = await fs.promises.readFile(SETTINGS_FILE, 'utf8');
      const parsed = normalizeHubSettings(JSON.parse(raw));
      if (parsed.storeId) settingsStore.id = parsed.storeId;
      return parsed;
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      if (!_SETTINGS_READ_BUSY.has(e.code) || attempt >= 5) throw e;
      await new Promise((r) => setTimeout(r, 40 * (attempt + 1)));
    }
  }
}

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
