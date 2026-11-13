// The limits of a settings backup file (format numbers, sizes, safe names) and the date its
// file name carries.

// ── Configuration backup ──────────────────────────────────────────────────────
// Export/import of the user's configuration as ONE portable JSON file (layout,
// Deck, calendar, tasks, timers, notes, settings, AI memory, Guardian history,
// custom background). Credentials (API keys, Sunshine credentials, OBS /
// Streamer.bot / UniFi passwords, the Home Assistant token, streaming tokens)
// are deliberately excluded. What travels instead is `secretsConfigured` —
// boolean flags only — so the import can tell the user exactly which services
// need re-configuring on the new machine.
//
// A backup is NOT safe to hand to someone, though: it exists to restore the
// user's own setup, so it keeps the personal configuration that setup is made
// of — private calendar (.ics) links, Deck webhook addresses and bodies, the
// Home Assistant alarm code on a Deck key, notes, tasks, AI memory. Stripping
// those (as shared presets do with deck-actions.js PERSONAL_PARAMS) would make
// a restore on a new PC silently lose calendars and break keys, with nothing to
// tell the user what to re-enter. The export note in Settings says to keep the
// file private; share a preset or a code instead of a backup. On import,
// every section goes through the same normalizers as its normal save path, so
// a tampered file can't smuggle bad shapes in. Installed third-party widget /
// Ambient-scene PACKAGES are likewise excluded (they live in DATA_DIR/widgets,
// not settings) — a lightweight `widgetsInstalled` list travels instead, driving
// a "re-import these from their codes" report (`needsWidgets`) after a restore.
const BACKUP_FORMAT = 2;             // v2: + aiMemory, guardian, background, secretsConfigured
const BACKUP_MIN_FORMAT = 1;         // v1 bundles (pre-4.0 exports) still import
const BACKUP_MAX_BYTES = 64 * 1024 * 1024;              // deck icons + an embedded background
const BACKUP_BACKGROUND_MAX_BYTES = 12 * 1024 * 1024;   // embed background images; skip large videos
const BACKUP_SAFE_NAME_RE = /^[A-Za-z0-9._-]+$/;        // upload filenames (no slash → no traversal)

// Write the backup bundle to a file on disk and return its absolute path.
// Targets the user's Downloads folder (the natural place for an export); falls
// back to the home dir, then DATA_DIR, if Downloads doesn't exist. The filename
// carries date + time so repeated exports never overwrite one another.
// `chosen`: a folder the dialog returned and the checks passed; '' = Downloads.
// Backup file names carry the user's own date and time, not UTC: a backup made
// at 00:40 on the 27th must not be named after the 26th.
function localBackupStamp(d, withTime = false) {
  const p = (n) => String(n).padStart(2, '0');
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return withTime ? `${day}-${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}` : day;
}

module.exports = {
  BACKUP_FORMAT, BACKUP_MIN_FORMAT, BACKUP_MAX_BYTES, BACKUP_BACKGROUND_MAX_BYTES,
  BACKUP_SAFE_NAME_RE, localBackupStamp,
};
