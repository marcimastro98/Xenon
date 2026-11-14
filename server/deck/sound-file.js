// Finding the file of a sound a Deck key plays, in the installed sound packs or among the
// sounds the person added.

const fs = require('node:fs');
const path = require('node:path');
const { DECK_SOUND_EXTS } = require('./limits.js');
const { soundPackStore } = require('./pack-stores.js');

// A soundboard clip the PC may play: the same two shapes /deck/sound accepts (a
// pack-relative ref, or the user's own absolute path), an audio extension, a file.
async function resolveDeckSoundFile(raw) {
  if (!raw) return null;
  const abs = soundPackStore.resolve(raw) || (path.isAbsolute(raw) ? path.resolve(raw) : null);
  if (!abs || !DECK_SOUND_EXTS.has(path.extname(abs).toLowerCase())) return null;
  try { return (await fs.promises.stat(abs)).isFile() ? abs : null; } catch { return null; }
}

module.exports = { resolveDeckSoundFile };
