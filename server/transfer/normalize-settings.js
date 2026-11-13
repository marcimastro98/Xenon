// The file transfer settings as saved: the folder received files go to, the size limits and the
// switches.

const { clampNumber } = require('../settings/values.js');
const { DEFAULT_HUB_SETTINGS } = require('../settings/defaults.js');

// Phone ↔ PC file transfer. Server-owned: there is no twin in
// js/settings.js normalizeSettings, on purpose, because `inboxDir` names a
// folder on this machine and the settings blob reaches every paired phone. The
// keep-prev guard in POST /settings is what stops a generic save from wiping
// it, and settings-server-owned-keys.test.mjs fails until both exist.
function normalizeFileTransfer(value) {
  const v = value && typeof value === 'object' ? value : {};
  const d = DEFAULT_HUB_SETTINGS.fileTransfer;
  return {
    enabled: v.enabled !== false,
    // Kept verbatim; it is validated against the filesystem where it is SET
    // (POST /api/transfer/settings) and again at delivery time, because a
    // folder that was fine yesterday can be renamed or unmounted today.
    inboxDir: typeof v.inboxDir === 'string' ? v.inboxDir.slice(0, 512) : d.inboxDir,
    autoDeliver: v.autoDeliver !== false,
    maxFileMb: clampNumber(v.maxFileMb, 1, 65536, d.maxFileMb),
    quotaMb: clampNumber(v.quotaMb, 256, 262144, d.quotaMb),
    keepDays: clampNumber(v.keepDays, 1, 365, d.keepDays),
    notifyPhone: v.notifyPhone === true,
  };
}

module.exports = { normalizeFileTransfer };
