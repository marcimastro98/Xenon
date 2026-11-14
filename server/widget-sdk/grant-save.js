// Saves what the user allowed a widget when Allow is pressed on the PC's screen, and forgets it
// when the widget's code is replaced by another package.

const { broadcastSSE } = require('../http/sse-clients.js');
const sdkWidgets = require('../sdk-widgets.js');
const SdkGrant = require('../sdk-grant.js');
const { nextSettingsRev } = require('../settings-rev.js');
const { readHubSettings, readHubSettingsForUpdate } = require('../settings/read.js');
const { SDK_WIDGETS_DIR } = require('./data-places.js');
const { hub } = require('../settings/current.js');
const { writeHubSettings } = require('../settings/write.js');
const { withHubSettingsLock } = require('../settings/write-lock.js');

// Forget what the user approved for a package whose code was just replaced by
// a different package under the same id: the new code asks for itself.
// Server-side so it holds even for a surface that never repaints; open
// dashboards re-read the settings from the broadcast.
async function dropSdkGrant(id) {
  const saved = await withHubSettingsLock(async () => {
    const cur = await readHubSettings().catch(() => null);
    const sw = cur && cur.sdkWidgets;
    if (!sw || !sw.grants || typeof sw.grants !== 'object' || !Object.prototype.hasOwnProperty.call(sw.grants, id)) return null;
    const grants = { ...sw.grants };
    delete grants[id];
    const next = await writeHubSettings({ ...cur, sdkWidgets: { ...sw, grants }, rev: nextSettingsRev(cur.rev) });
    hub.settings = next;
    return next;
  }).catch(() => null);
  if (saved) broadcastSSE('settings', { rev: saved.rev });
}

// POST /sdk/grant: Allow pressed on a widget on the PC's screen (sdk-grant.js).
async function saveSdkGrant(body) {
  const scan = await sdkWidgets.listPackages(SDK_WIDGETS_DIR);
  const plan = SdkGrant.plan(body, scan.packages);
  if (plan.error) return { ok: false, ...plan };
  let rev = null;
  await withHubSettingsLock(async () => {
    const cur = await readHubSettingsForUpdate();
    const written = await writeHubSettings({ ...cur, ...SdkGrant.apply(cur, plan), rev: nextSettingsRev(cur.rev) });
    hub.settings = written;
    rev = written.rev;
    broadcastSSE('settings', { rev });
  });
  return { ok: true, rev };
}

module.exports = { dropSdkGrant, saveSdkGrant };
