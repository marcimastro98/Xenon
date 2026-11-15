// Writes the settings file: the pictures of scenes go to files of their own, every key is
// checked, the file keeps its identity, and uploaded pictures nothing uses any more are
// cleared.

const crypto = require('node:crypto');
const sceneImages = require('../ambient/scene-images.js');
const slideshowFolder = require('../windows-tiles/slideshow-folder.js');
const { DATA_DIR } = require('../engine/paths.js');
const { SETTINGS_FILE } = require('./settings-file.js');
const { normalizeHubSettings } = require('./normalize-hub-settings.js');
const { UPLOADS_DIR } = require('../engine/uploads-dir.js');
const storeSnapshots = require('../store-snapshots.js');
const { writeFileAtomic } = require('../atomic-write.js');
const { settingsStore } = require('./store-state.js');
const {
  cleanupUnreferencedTileAssets, cleanupUnreferencedSlideshowAssets,
} = require('../grid/asset-sweep.js');
const { slideshowCache } = require('../windows-tiles/slideshow-cache.js');

async function writeHubSettings(settings) {
  // Large scene pictures go to files of their own (scene-images.js), so a
  // settings save stops carrying megabytes of pictures. Before the normalizer,
  // so the scene size limits count what is really stored (a path), and a
  // backup that carries the pictures inside is not cut down on restore.
  let moved = null;
  if (settings && Array.isArray(settings.ambientScenes)) {
    moved = await sceneImages.externalize(settings.ambientScenes, UPLOADS_DIR).catch(() => null);
    if (moved && moved.changed) settings = { ...settings, ambientScenes: moved.scenes };
  }
  const safe = normalizeHubSettings(settings);
  // Mint the store id on the first write that lacks one, which covers a fresh
  // install and an existing one updating into this build. `settingsStore.id`
  // first, so only a store this process has never seen gets a new value.
  if (!safe.storeId) safe.storeId = settingsStore.id || crypto.randomBytes(16).toString('hex');
  settingsStore.id = safe.storeId;
  // The rev moves past the one the saving screen holds, so that screen also
  // picks up the lighter copy on the broadcast instead of sending the pictures
  // again with every save.
  if (moved && moved.changed) safe.rev = (Number(safe.rev) || 0) + 1;
  // Compact: indentation made the file a fifth bigger and every save slower,
  // and nobody reads this file by hand.
  await writeFileAtomic(SETTINGS_FILE, JSON.stringify(safe));
  sceneImages.sweepUnused(UPLOADS_DIR, safe.ambientScenes, { snapshotsDir: storeSnapshots.snapshotsDir(DATA_DIR) }).catch(() => {});
  // Reclaim any per-tile decoration images no surviving tile references (grace-
  // windowed so a just-uploaded asset isn't swept before its layout save lands).
  // Saved presets count as references too — inserting one must still find its images.
  cleanupUnreferencedTileAssets(safe.dashboardLayout, safe.dashboardPresets);
  // Slideshow images are disk-backed uploads too, referenced from safe.slideshow.
  cleanupUnreferencedSlideshowAssets(safe.slideshow);
  // A folder-source slideshow keeps its enumeration in memory; pointing the setting
  // at a different folder must show the new count now, not up to a TTL later.
  slideshowFolder.invalidate();
  slideshowCache.folder = (safe.slideshow && typeof safe.slideshow.folder === 'string') ? safe.slideshow.folder : '';
  return safe;
}

module.exports = { writeHubSettings };
