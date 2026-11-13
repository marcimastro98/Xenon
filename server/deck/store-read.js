// Reads the Deck from its file. A file that is not there yet is an empty Deck.

const fs = require('node:fs');
const { DECK_FILE } = require('./deck-file.js');
const { normalizeDeckStore } = require('./store-normalize.js');

async function readDeckStore() {
  try {
    const raw = await fs.promises.readFile(DECK_FILE, 'utf8');
    return normalizeDeckStore(JSON.parse(raw));
  } catch (e) {
    if (e.code === 'ENOENT') return { configs: {}, rev: 0, savedAt: 0, instanceRevs: {}, presets: [], keyPresets: [] };
    throw e;
  }
}

module.exports = { readDeckStore };
