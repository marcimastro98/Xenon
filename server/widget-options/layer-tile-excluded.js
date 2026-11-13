// The tiles that cannot stand alone on the desktop.

// Tiles that make no sense alone on the desktop: the bare custom shell (a Store
// widget is placed by its package instead) and the second-screen mirror.
const LAYER_TILE_EXCLUDED = new Set(['custom', 'secondscreen', 'screen']);

module.exports = { LAYER_TILE_EXCLUDED };
