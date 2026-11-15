// What the PC is heard playing when no player reports a song, and the last song known: both
// made when the engine starts and filled by the media reading.

const { createHeardPlayer, createMusicFact } = require('./media-read.js');
const { F } = require('../audio/svv-csv.js');

const heardPlayer = createHeardPlayer(F);
const musicNow = createMusicFact();

module.exports = { heardPlayer, musicNow };
