'use strict';

// The on-screen alerts window of "widgets only" (screen-alerts.html). Bit
// answers there too (js/screen-bit.js), with the dashboard's own voice panel,
// and the Game Companion card opens there (js/screen-companion.js): both are
// cut from index.html here, so the two never drift apart.
const { sliceTile } = require('./layer-page');

const BIT_MARK = '<!-- bit markup -->';
const COMPANION_MARK = '<!-- companion markup -->';

// '' in place of a panel when index.html lacks it: that part then stays away
// instead of showing a broken card (each script checks its template).
function compose(html, dashboardHtml) {
  const dash = String(dashboardHtml || '');
  // A function, so a "$" in the markup is never read as a replacement pattern.
  return String(html)
    .replace(BIT_MARK, () => sliceTile(dash, '#ai-overlay'))
    .replace(COMPANION_MARK, () => sliceTile(dash, '#gc-overlay'));
}

module.exports = { compose, BIT_MARK, COMPANION_MARK };
