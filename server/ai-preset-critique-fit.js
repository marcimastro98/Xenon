'use strict';

// Does a tile widget still fit when its tile changes shape? A widget sized
// from one axis of the tile (cqh, vw...) looks right at the shape it was drawn
// for and breaks at any other: scaled from the height, a 750x220 design put in
// a 1144x656 tile grows a moon wider than the tile and squeezes its text to a
// word per line. Tiles are resized, stretched and shown on phones, so type and
// scale units come from the SHORTER side (cqmin, or min() of both axes).

const { finding } = require('./ai-preset-critique-core.js');

const DECLARATION = /(--[\w-]+|font-size|(?:min-|max-)?(?:width|height|inline-size|block-size))\s*:\s*([^;{}]+)/g;
const BOTH_AXES = /\b(?:min|max|clamp)\(|cqmin|cqmax|vmin|vmax/;
const UNIT = (units) => new RegExp('\\d(?:' + units + ')\\b');
const ANY_ONE_AXIS = UNIT('cqh|cqw|cqi|cqb|vh|vw|dvh|dvw|svh|svw');
const VERTICAL = UNIT('cqh|cqb|vh|dvh|svh');
const HORIZONTAL = UNIT('cqw|cqi|vw|dvw|svw');
// A whole-axis size (height: 100vh, width: 100cqw) is the box itself, not a scale.
const WHOLE = /^\s*100(?:cqh|cqw|cqi|cqb|vh|vw|dvh|dvw|svh|svw)\s*(?:!important)?\s*$/;

function oneAxisSizes(text) {
  const hits = [];
  for (const [, prop, value] of String(text).matchAll(DECLARATION)) {
    if (BOTH_AXES.test(value) || WHOLE.test(value)) continue;
    const scale = prop.startsWith('--') || prop === 'font-size';
    const crossed = /width|inline/.test(prop) ? VERTICAL.test(value) : /height|block/.test(prop) && HORIZONTAL.test(value);
    if ((scale && ANY_ONE_AXIS.test(value)) || crossed) hits.push(prop + ': ' + value.trim().slice(0, 40));
  }
  return hits;
}

function critiqueTileFit(text) {
  const hits = oneAxisSizes(text);
  if (!hits.length) return [];
  return [finding('fix', 'style', 'sizes from one side of the tile (' + hits.slice(0, 3).join('; ') + (hits.length > 3 ? '; and ' + (hits.length - 3) + ' more' : '')
    + '), so it overflows when the tile is less wide or less tall than you drew it for (a 750x220 tile can be shown at 1144x656, or 390 wide on a phone)',
    'size type and scale from the shorter side: cqmin, or min(Ncqh, Mcqw), and let the layout switch with @container queries when the shape changes')];
}

module.exports = { critiqueTileFit, oneAxisSizes };
