// Pointing the index at the folders chosen in the settings, and on macOS noticing when the
// permission to read the whole disk is given or taken away.

const { nativeCollectors } = require('../system/native-collectors.js');
const { livingIndex } = require('./living-index-engine.js');
const { macDiskAccess } = require('./mac-disk-access.js');
const { usableIndexRoots } = require('./index-roots.js');
const { hub } = require('../settings/current.js');

// Ask macOS whether the grant still holds, and re-point the index when the
// answer changes. It CHANGES on its own: the grant is bound to the app's code
// signature, Xenon's is ad-hoc, and its hash moves with every build — so an
// update silently revokes Full Disk Access and this is what notices. Polling
// beats asking once at startup for the same reason it beats asking the user:
// granting the permission then takes effect on its own, within a minute, with
// nothing to restart.
async function refreshMacFdaState() {
  if (process.platform !== 'darwin') return;
  if (!nativeCollectors || typeof nativeCollectors.fullDiskAccess !== 'function') return;
  let granted = true;
  try { granted = await nativeCollectors.fullDiskAccess(); } catch { return; }
  if (granted === macDiskAccess.granted) return;
  macDiskAccess.granted = granted;
  refreshLivingIndex();
}

// Point the Living Index at the configured roots (idempotent — setRoots
// restarts the host only when they actually changed).
function refreshLivingIndex() {
  const cfg = (hub.settings && hub.settings.searchSettings) || {};
  try { livingIndex.setRoots(usableIndexRoots(cfg.indexRoots)); } catch { /* helper absent */ }
}

module.exports = { refreshMacFdaState, refreshLivingIndex };
