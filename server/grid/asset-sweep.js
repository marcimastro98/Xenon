// Deletes the uploaded pictures that no tile, slideshow or layout backup uses any more.

const fs = require('node:fs');
const path = require('node:path');
const {
  collectTileAssetRefs, TILE_ASSET_GC_GRACE_MS, TILE_ASSET_GC_MIN_INTERVAL_MS,
} = require('./tile-asset-refs.js');
const { collectSlideshowAssetRefs } = require('../windows-tiles/slideshow-asset-refs.js');
const { UPLOADS_DIR } = require('../engine/uploads-dir.js');
const { assetSweep } = require('./asset-sweep-state.js');
const { LAYOUT_BACKUP_FILE } = require('./layout-backup.js');

function layoutBackupAssetRefs() {
  if (assetSweep.backupRefs) return assetSweep.backupRefs;
  try {
    const raw = JSON.parse(fs.readFileSync(LAYOUT_BACKUP_FILE, 'utf8'));
    const set = new Set();
    for (const m of JSON.stringify(raw.dashboardLayout || {}).matchAll(/\/uploads\/(tileasset-[A-Za-z0-9._-]+)/g)) set.add(m[1]);
    assetSweep.backupRefs = set;
    return set;
  } catch { return new Set(); }   // no backup, or unreadable — nothing to protect
}

function cleanupUnreferencedTileAssets(layout, presets) {
  const referenced = collectTileAssetRefs(layout, presets);
  for (const f of layoutBackupAssetRefs()) referenced.add(f);
  const sig = [...referenced].sort().join('|');
  const now = Date.now();
  if (sig === assetSweep.tileSig && (now - assetSweep.tileAt) < TILE_ASSET_GC_MIN_INTERVAL_MS) return;
  assetSweep.tileSig = sig;
  assetSweep.tileAt = now;
  const cutoff = now - TILE_ASSET_GC_GRACE_MS;
  fs.promises.readdir(UPLOADS_DIR).then(files => Promise.all(files
    .filter(f => f.startsWith('tileasset-') && !referenced.has(f))
    .map(async (f) => {
      try {
        const p = path.join(UPLOADS_DIR, f);
        const st = await fs.promises.stat(p);
        if (st.mtimeMs < cutoff) await fs.promises.unlink(p).catch(() => {});
      } catch { /* file vanished mid-sweep — fine */ }
    })
  )).catch(() => {});
}

function cleanupUnreferencedSlideshowAssets(slideshow) {
  const referenced = collectSlideshowAssetRefs(slideshow);
  const sig = [...referenced].sort().join('|');
  const now = Date.now();
  if (sig === assetSweep.slideshowSig && (now - assetSweep.slideshowAt) < TILE_ASSET_GC_MIN_INTERVAL_MS) return;
  assetSweep.slideshowSig = sig;
  assetSweep.slideshowAt = now;
  const cutoff = now - TILE_ASSET_GC_GRACE_MS;
  fs.promises.readdir(UPLOADS_DIR).then(files => Promise.all(files
    .filter(f => f.startsWith('slideshow-') && !referenced.has(f))
    .map(async (f) => {
      try {
        const p = path.join(UPLOADS_DIR, f);
        const st = await fs.promises.stat(p);
        if (st.mtimeMs < cutoff) await fs.promises.unlink(p).catch(() => {});
      } catch { /* file vanished mid-sweep — fine */ }
    })
  )).catch(() => {});
}

module.exports = {
  layoutBackupAssetRefs, cleanupUnreferencedTileAssets, cleanupUnreferencedSlideshowAssets,
};
