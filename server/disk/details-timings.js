// How long drive details are reused and how long a read may take, and the test that says a
// stored answer is still fresh.

// Labels/filesystem/type only — free space is read live via statfs on every
// cycle. Volumes change only on plug/unplug, so 10 minutes is plenty: at 60s
// this was the last recurring powershell.exe spawn left on an idle server.
const DISK_DETAILS_TTL_MS = 10 * 60 * 1000;
// A read that answered nothing is not an answer, so it gets its own short TTL:
// caching a failure for the full ten minutes is what turned one slow query into
// "Detail unavailable" for ten minutes at a time (reported on Discord, where a
// restart never helped — the first read after boot is the slowest one there is,
// so every restart landed on the same timeout and pinned the same empty result).
const DISK_DETAILS_RETRY_MS = 60 * 1000;
// The FIRST read blocks the /system response, so it keeps the short budget the
// panel's first paint has always had. Every later one refreshes in the
// background off the last known-good details, where the query can have the time
// it actually needs: these all go through the Windows storage WMI provider,
// which is routinely slower than five seconds cold.
const DISK_DETAILS_TIMEOUT_MS = 5000;
const DISK_DETAILS_BG_TIMEOUT_MS = 15000;
// Get-Disk/Get-Partition are a SEPARATE probe from Get-Volume, and the split is
// the point rather than a tidy-up: the detail line under a drive is built from
// label/fileSystem/driveType, all of which come from Get-Volume alone, while
// Get-Disk/Get-Partition exist only to name the physical disk (`model`) for the
// Disk widget. Under one budget the two nobody is waiting for could eat the five
// seconds and blank a line that was already answerable — measured on a user's
// PC, where Get-Volume alone came back in 0.58s while the card read "Detail
// unavailable". Models are never waited for and get a budget of their own, so a
// slow storage provider costs a disk name on the first read and nothing else.
const DISK_MODELS_TIMEOUT_MS = 20000;

function diskProbeFresh(probe) {
  if (!probe.data) return false;
  const ttl = probe.ok ? DISK_DETAILS_TTL_MS : DISK_DETAILS_RETRY_MS;
  return Date.now() - probe.updatedAt < ttl;
}

const DISK_LETTERS_TTL = 60 * 1000;

module.exports = {
  DISK_DETAILS_TTL_MS, DISK_DETAILS_RETRY_MS, DISK_DETAILS_TIMEOUT_MS, DISK_DETAILS_BG_TIMEOUT_MS,
  DISK_MODELS_TIMEOUT_MS, diskProbeFresh, DISK_LETTERS_TTL,
};
