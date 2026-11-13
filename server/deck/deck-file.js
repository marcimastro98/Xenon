// Where the Deck is kept in the user's data folder.

const path = require('node:path');
const { DATA_DIR } = require('../engine/paths.js');

const DECK_FILE = path.join(DATA_DIR, 'deck.json');

module.exports = { DECK_FILE };
