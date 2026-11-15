// Playing a channel or a video in a tile when the assistant is asked to: what was meant is
// searched for first, then handed to the dashboard that shows the tile.

const TilePlay = require('./tile-play.js');
const { tilePlay } = require('./tile-play-offers.js');
const { tilePlaySearch } = require('../streaming/tile-play-search.js');

async function playInTile(args) {
  const want = TilePlay.parseTilePlay(args);
  if (want.error) return { ok: false, ...want };
  let title = '';
  if (want.search) {
    const hit = await tilePlaySearch(want.tile, want.search);
    if (hit.error) return { ok: false, error: hit.error, search: want.search };
    want.value = hit.value;
    title = hit.title || '';
  }
  const claimed = await tilePlay.offer(want.tile, want.value);
  if (!claimed) return { ok: false, error: 'no_tile', tile: want.tile, hint: 'No open dashboard or screen widget shows this tile. Offer to add it (place_widget).' };
  return { ok: true, tile: want.tile, playing: want.value, ...(title ? { title } : {}) };
}

module.exports = { playInTile };
