// Copies the dashboard layout to a file of its own, once, before a new version of the layout
// replaces it.

const fs = require('node:fs');
const path = require('node:path');
const { DASHBOARD_LAYOUT_VERSION } = require('./layout-defaults.js');
const { DATA_DIR } = require('../engine/paths.js');
const { SETTINGS_FILE } = require('../settings/settings-file.js');

// The layout-version migration REPLACES the dashboard, and until now it did so
// with no way back: the stored layout was overwritten by the factory default on
// the next save, and the only copy of what the user had built was gone. Every
// other destructive step in this app is either confirmed or reversible; this one
// runs at boot, unasked, and the person finds out by looking at their screen.
//
// So the superseded layout is copied out first. Not a restore feature — a file
// on disk and a line in the log, which is the difference between "rebuild it from
// memory" and "it is right here". Read SYNCHRONOUSLY and before the store-id mint
// below can rewrite the file, because the raw old version only exists until the
// first write of this run.
//
// Never overwrites an existing backup: the migration fires once (the next write
// stamps the new version), but a second pass must not be able to save the
// factory default over the real one.
const LAYOUT_BACKUP_FILE = path.join(DATA_DIR, 'dashboard-layout.backup.json');
// Answers { file, from } when a layout was copied out, null otherwise. `from` is
// read off the RAW file on purpose: the normalized settings are already stamped
// with the current version, so asking them which version this install is
// upgrading FROM always answers "the one it is upgrading to".
function backupSupersededLayout() {
  try {
    if (fs.existsSync(LAYOUT_BACKUP_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    const from = Number(raw && raw.dashboardLayoutVersion) || 0;
    if (from >= DASHBOARD_LAYOUT_VERSION) return null;
    const layout = raw && raw.dashboardLayout;
    if (!layout || typeof layout !== 'object') return null;   // nothing built yet
    fs.writeFileSync(LAYOUT_BACKUP_FILE, JSON.stringify({
      savedAt: new Date().toISOString(),
      fromVersion: from,
      toVersion: DASHBOARD_LAYOUT_VERSION,
      dashboardLayout: layout,
    }, null, 2));
    return { file: LAYOUT_BACKUP_FILE, from };
  } catch { return null; }   // a backup that throws must never block the boot
}

module.exports = { LAYOUT_BACKUP_FILE, backupSupersededLayout };
