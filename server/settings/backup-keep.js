'use strict';

// What a backup import never takes from the file, because it belongs to this PC.
// The secrets have their own module (secrets.js); this is the rest.

const { normalizeServerAppFavorites } = require('./normalize-favorites.js');

/** @param {any} value @returns {Record<string, any> | null} the value when it is an object with keys, not a list */
const plain = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);
const pathKey = (/** @type {any} */ value) => String(value || '').trim().toLowerCase();

/**
 * The favourite apps of a backup, as a settings save would store them, each with its path only when
 * this PC already starts that program from a favourite. The path is what the dashboard starts with
 * one tap, and what a paired device may start (remote-actions.js remoteMayLaunch): a file must not
 * be able to name a program for either. A favourite that loses its path is still listed, and gets
 * the path of this PC the next time its app is seen open (js/app-switcher/favorites.js).
 * @param {any} fromFile @param {any} saved the favourites of this PC
 * @returns {Record<string, any>[]}
 */
function favoritesOnImport(fromFile, saved) {
  const known = new Set((Array.isArray(saved) ? saved : []).map((fav) => pathKey(fav?.path)).filter(Boolean));
  return normalizeServerAppFavorites(fromFile).map((fav) => (known.has(pathKey(fav.path)) ? fav : { ...fav, path: '' }));
}

/**
 * The settings saved on this PC, read before an import is merged into them.
 * A file that cannot be parsed counts as "nothing saved": restoring a backup is how a broken
 * settings file gets repaired. Any other failure (a locked or unreadable file) is thrown, so the
 * import fails instead of merging against nothing and dropping every secret saved here.
 * @template T
 * @param {() => Promise<T>} read the engine's settings reader
 * @returns {Promise<T | null>}
 */
async function settingsBeforeImport(read) {
  try {
    return await read();
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

/**
 * @param {Record<string, any>} incoming the settings of the backup, secrets already merged
 * @param {Record<string, any> | null} prev the settings saved on this PC
 * @returns {Record<string, any>} `incoming`, with what belongs to this PC put back
 */
function keepThisPcOnImport(incoming, prev) {
  if (!incoming.geminiApiKey && prev?.geminiApiKey) incoming.geminiApiKey = prev.geminiApiKey;
  // Access for paired devices is switched at this PC and nowhere else: the switch also moves the
  // listener and drops the devices that are connected. A backup made on another PC, or before
  // the switch was flipped, must not turn it on or off here.
  if (prev?.remoteAccess && typeof prev.remoteAccess === 'object') incoming.remoteAccess = prev.remoteAccess;
  else delete incoming.remoteAccess;
  // PC Control lets the assistant run commands on this PC. It is switched on at this PC, by its
  // own switch: a backup neither turns it on nor off, like a save from a paired device.
  const features = plain(incoming.aiFeatures);
  const pcControl = plain(prev?.aiFeatures)?.pcControl === true;
  if (features || pcControl) incoming.aiFeatures = { ...features, pcControl };
  // What each widget may see and do was allowed on this PC's screen, for the code installed here
  // (the packages do not travel in a backup). A file gives no permission and takes none away.
  const widgets = plain(incoming.sdkWidgets);
  const grants = plain(plain(prev?.sdkWidgets)?.grants);
  if (widgets || grants) incoming.sdkWidgets = { ...widgets, grants: grants ?? {} };
  if ('appFavorites' in incoming) incoming.appFavorites = favoritesOnImport(incoming.appFavorites, prev?.appFavorites);
  return incoming;
}

module.exports = { settingsBeforeImport, keepThisPcOnImport };
