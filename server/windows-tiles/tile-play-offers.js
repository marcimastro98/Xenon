// Handing a channel or a video the assistant found to the one dashboard that shows the tile,
// made when the engine starts.

const TilePlay = require('../tile-play.js');
const { broadcastSSE } = require('../http/sse-clients.js');

// play_in_tile (tile-play.js): find what the user meant, then hand it to the
// one surface that has the tile. Searches need the account connected in the
// tile; an exact channel or video plays without one.
const tilePlay = TilePlay.createTilePlay({ broadcast: (event, data) => broadcastSSE(event, data) });

module.exports = { tilePlay };
