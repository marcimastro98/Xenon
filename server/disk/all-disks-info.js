// Every disk of this machine with its size, free space, label and model: drive letters on
// Windows, the mounts the collector finds elsewhere.

const fs = require('node:fs');
const { DISK_LETTERS_TTL } = require('./details-timings.js');
const { joinDiskDetails } = require('./details-shape.js');
const { volumeDetailsProbe, diskModelsProbe, getDiskDetails } = require('./drive-details.js');
const { diskLetters } = require('./letters-state.js');
const { mountedDisks } = require('./engine-mounted-disks.js');

async function getAllDisksInfo({ waitForDetails = true } = {}) {
  if (mountedDisks) return mountedDisks();
  const drives = [];
  const details = waitForDetails
    ? await getDiskDetails()
    : joinDiskDetails(volumeDetailsProbe.data || {}, diskModelsProbe.data || {});
  // Probing all 24 letters with statfs every cycle (~7s) is wasteful — valid
  // letters change rarely. Cache the set that resolved for 60s and probe only
  // those; a stale (or empty) cache triggers a full A–Z re-scan so a newly
  // mounted/removed drive still appears within a minute. Free-space is still
  // read live on each call — only the dead letters are skipped.
  const now = Date.now();
  const fresh = diskLetters.cache.letters && diskLetters.cache.letters.length &&
                (now - diskLetters.cache.at) < DISK_LETTERS_TTL;
  const letters = fresh ? diskLetters.cache.letters : 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const valid = [];
  for (const letter of letters) {
    try {
      if (typeof fs.promises.statfs === 'function') {
        const s = await fs.promises.statfs(letter + ':\\');
        const total = Number(s.blocks) * Number(s.bsize);
        const free = Number(s.bfree) * Number(s.bsize);
        if (total > 0) {
          valid.push(letter);
          const drive = letter + ':';
          const detail = details[drive.toUpperCase()] || {};
          drives.push({
            drive,
            total,
            used: total - free,
            free,
            percent: Math.round(((total - free) / total) * 100),
            label: detail.label || '',
            // The name of the physical disk. The detail line falls back to it
            // when the volume has no label of its own, which is the default on
            // a Windows install: without it that line reads "NTFS - Fixed".
            model: detail.model || '',
            fileSystem: detail.fileSystem || '',
            driveType: detail.driveType || '',
          });
        }
      }
    } catch { }
  }
  // Only refresh the cache after a full scan, and never store an empty result
  // (a transient failure must not pin us to "no drives" for 60s).
  if (!fresh && valid.length) diskLetters.cache = { letters: valid, at: now };
  return drives.length ? drives : null;
}

module.exports = { getAllDisksInfo };
