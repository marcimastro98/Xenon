// The apps making sound right now, read again only after a short while, and whether the list of
// players is resting.

const { SOUND_ROWS_REUSE_MS } = require('./timings.js');
const { mediaNow } = require('./now-state.js');
const { readSoundingRows } = require('../audio/volume-rows.js');

const mediaListDown = () => mediaNow.readerRestUntil > 0;

async function soundingRows() {
  if (mediaNow.soundRows.rows && Date.now() - mediaNow.soundRows.at < SOUND_ROWS_REUSE_MS) return mediaNow.soundRows.rows;
  const rows = await readSoundingRows();
  mediaNow.soundRows = { rows, at: Date.now() };
  return rows;
}

module.exports = { mediaListDown, soundingRows };
