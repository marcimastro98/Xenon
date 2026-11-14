// Saves the usage mode, or whether alerts show on the screen, as one change of the settings;
// the wake word is then started or stopped to match.

const { broadcastSSE } = require('../http/sse-clients.js');
const { nextSettingsRev } = require('../settings-rev.js');
const { readHubSettingsForUpdate } = require('./read.js');
const { hub } = require('./current.js');
const { writeHubSettings } = require('./write.js');
const { withHubSettingsLock } = require('./write-lock.js');
const { refreshWakeWordWatch } = require('../ai/wake-word-watch.js');

// The usage mode, set by voice or a Deck key (capabilities/usage-mode.js). The
// shell's main window picks it up on its next load (route `/`).
// "Avvisi sullo schermo" (js/screen-alerts.js): the rest of `notifications` stays.
async function updateScreenAlertsSetting(on) {
  return withHubSettingsLock(async () => {
    const cur = await readHubSettingsForUpdate();
    const notifications = { ...(cur.notifications || {}), onScreen: on === true };
    const saved = await writeHubSettings({ ...cur, notifications, rev: nextSettingsRev(cur.rev) });
    hub.settings = saved;
    broadcastSSE('settings', { rev: saved.rev });
    // In "widgets only" the alerts window is who answers the wake word.
    refreshWakeWordWatch();
    return saved.notifications.onScreen;
  });
}

async function updateUsageModeSetting(mode) {
  return withHubSettingsLock(async () => {
    const cur = await readHubSettingsForUpdate();
    const saved = await writeHubSettings({ ...cur, usageMode: mode, rev: nextSettingsRev(cur.rev) });
    hub.settings = saved;
    broadcastSSE('settings', { rev: saved.rev });
    refreshWakeWordWatch();
    return saved.usageMode;
  });
}

module.exports = { updateScreenAlertsSetting, updateUsageModeSetting };
