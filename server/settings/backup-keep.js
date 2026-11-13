'use strict';

// What a backup import never takes from the file, because it belongs to this PC.
// The secrets have their own module (secrets.js); this is the rest.

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
  return incoming;
}

module.exports = { settingsBeforeImport, keepThisPcOnImport };
