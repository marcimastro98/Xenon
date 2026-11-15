// Changes the animated wallpaper or the PC screensaver from a spoken request or a Deck key,
// inside the settings queue.

const { broadcastSSE } = require('../http/sse-clients.js');
const { nextSettingsRev } = require('../settings/settings-rev.js');
const { normalizeLockWidgets } = require('../settings/normalize-lock-widgets.js');
const { normalizeAmbientMode } = require('./normalize-mode.js');
const { readHubSettingsForUpdate } = require('../settings/read.js');
const { hub } = require('../settings/current.js');
const { writeHubSettings } = require('../settings/write.js');
const { withHubSettingsLock } = require('../settings/write-lock.js');

// The animated wallpaper and the PC screensaver, by voice or a Deck key
// (capabilities/desktop-scene.js). A toggle is decided inside the lock, so two
// quick presses never read the same value.
async function updateDesktopSceneSetting(patch) {
  return withHubSettingsLock(async () => {
    const cur = await readHubSettingsForUpdate();
    const ambient = require('../capabilities/desktop-scene.js').applyPatch(normalizeAmbientMode(cur.ambientMode), patch);
    const lockWidgets = normalizeLockWidgets(patch.lockWidgets || cur.lockWidgets);
    const saved = await writeHubSettings({ ...cur, lockWidgets, ambientMode: normalizeAmbientMode(ambient), rev: nextSettingsRev(cur.rev) });
    hub.settings = saved;
    broadcastSSE('settings', { rev: saved.rev });
    return saved.ambientMode;
  });
}

module.exports = { updateDesktopSceneSetting };
