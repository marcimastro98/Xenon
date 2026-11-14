'use strict';
// The drives and volumes the disk space module can offer as places to index, asked for without
// holding a request and remembered for a while.

const fs = require('node:fs');

function makeVolumes({ getVolumes, IS_WIN, DRIVES_TTL_MS, drivesCache, volumesCache }) {
  function refreshDrives() {
    if (drivesCache.pending) return drivesCache.pending;
    const letters = [];
    for (let c = 65; c <= 90; c++) letters.push(String.fromCharCode(c));
    drivesCache.pending = Promise.all(letters.map(async (letter) => {
      try { await fs.promises.access(letter + ':\\'); return letter; } catch { return null; }
    })).then((found) => {
      drivesCache.list = found.filter(Boolean);
      drivesCache.at = Date.now();
      return drivesCache.list;
    }).catch(() => drivesCache.list).finally(() => { drivesCache.pending = null; });
    return drivesCache.pending;
  }
  function listDrives() {
    if (IS_WIN) {
      if (!drivesCache.at) return refreshDrives();          // first call waits
      if (Date.now() - drivesCache.at >= DRIVES_TTL_MS) refreshDrives();  // in background
      return Promise.resolve(drivesCache.list);
    }
    return Promise.resolve([]);   // no letters here; see addableRoots()
  }

  function refreshVolumes() {
    if (volumesCache.pending) return volumesCache.pending;
    volumesCache.pending = Promise.resolve()
      .then(() => getVolumes())
      .then((rows) => {
        volumesCache.list = (Array.isArray(rows) ? rows : [])
          .map((d) => ({
            letter: '',
            path: String((d && d.drive) || ''),
            drive: String((d && d.drive) || ''),
            label: String((d && d.label) || '').trim().slice(0, 80),
            model: '',
            fileSystem: String((d && d.fileSystem) || '').trim().slice(0, 24),
            driveType: String((d && d.driveType) || '').trim().slice(0, 40),
          }))
          .filter((d) => d.path.startsWith('/'));
        volumesCache.at = Date.now();
        return volumesCache.list;
      })
      .catch(() => volumesCache.list)
      .finally(() => { volumesCache.pending = null; });
    return volumesCache.pending;
  }

  // The volumes the widget may offer as "add this to the index". One shape on
  // both platforms: `path` is what the client sends back, and it is the only
  // field it needs. `letter` stays populated on Windows because that is what
  // the existing client falls back to.
  async function addableRoots(metadata) {
    if (IS_WIN) {
      const letters = await listDrives();
      return letters.map((letter) => ({
        letter,
        path: letter + ':\\',
        ...metadata(letter + ':'),
      }));
    }
    if (!getVolumes) return [];
    if (!volumesCache.at) return refreshVolumes();
    if (Date.now() - volumesCache.at >= DRIVES_TTL_MS) refreshVolumes();
    return volumesCache.list;
  }

  return { listDrives, addableRoots };
}

module.exports = { makeVolumes };
