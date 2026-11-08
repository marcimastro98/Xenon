'use strict';

// Can the finger still change page over this tile? The dashboard's pages turn
// on a sideways drag, and that drag reaches the pager from inside a widget's
// frame only if nothing stops it. `overscroll-behavior: contain` on a list stops
// it on BOTH axes, so a list that only scrolls up and down still kills the swipe.
// The -y form keeps the list's own scroll from leaking and leaves sideways free.

const { finding } = require('./ai-preset-critique-core.js');

// The first value of the shorthand is the horizontal one.
const BLOCKS_SIDEWAYS = /overscroll-behavior(?:-x|-inline)?\s*:\s*(?:contain|none)\b[^;}]*/g;

function critiqueTileSwipe(text) {
  const hits = String(text).match(BLOCKS_SIDEWAYS);
  if (!hits) return [];
  return [finding('fix', 'style', 'stops the sideways drag (' + hits[0].trim() + '), so a finger on this tile can no longer change dashboard page',
    'use overscroll-behavior-y: contain on a list that scrolls up and down')];
}

module.exports = { critiqueTileSwipe };
