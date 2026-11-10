'use strict';

// The pictures of the widget lists, shot on the site's demo by
// tools/tile-previews/shoot.mjs. A tile the demo leaves empty or waiting for an account
// is fed invented data by tools/tile-previews/fixtures.mjs. The list itself is in
// js/palette-model.js, which the browser reads too.
const { PREVIEW_TILES, previewPath } = require('./js/palette-model.js');

const PREVIEW_WIDTH = 360;

module.exports = { PREVIEW_TILES, PREVIEW_WIDTH, previewPath };
