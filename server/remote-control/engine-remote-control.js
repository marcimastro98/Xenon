// The engine's Remote Control: it reads the settings held in memory and saves through the one
// settings lock.

const { createRemoteControl } = require('./index.js');
const { hub } = require('../settings/current.js');
const { writeHubSettings } = require('../settings/write.js');
const { withHubSettingsLock } = require('../settings/write-lock.js');

// Remote Control orchestrator — getSettings reads the in-memory mirror so
// currentCreds() stays synchronous; saveSettings persists and normalises via
// writeHubSettings (which updates hub.settings on the next settings read).
const remoteControl = createRemoteControl({
  getSettings: () => hub.settings,
  saveSettings: (s) => withHubSettingsLock(() => writeHubSettings(s).then(safe => { hub.settings = safe; return safe; })),
});

module.exports = { remoteControl };
