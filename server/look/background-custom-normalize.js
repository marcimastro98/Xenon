// The custom background as the settings keep it: its code within the size limit, its pictures
// and frame rate by the rules shared with the dashboard, and where it came from.

const { BG_CUSTOM_CODE_MAX } = require('./background-values.js');
const { sanitizeBgAssets, sanitizeBgFps } = require('../js/custom-bg.js');
const contentInstalls = require('../js/content-installs.js');

function normalizeBgCustom(value) {
  const source = value && typeof value === 'object' ? value : {};
  const code = typeof source.code === 'string' ? source.code.slice(0, BG_CUSTOM_CODE_MAX) : '';
  const out = {
    enabled: !!source.enabled && !!code,
    name: typeof source.name === 'string' ? source.name.trim().slice(0, 60) : '',
    code,
    assets: sanitizeBgAssets(source.assets),
    // Frame-rate cap (paints per second) — rule owner is custom-bg.js, exactly
    // like the assets above, so client/server/sandbox can never drift.
    fps: sanitizeBgFps(source.fps),
  };
  // Redistribution marker: set when the background arrived via a share code, so
  // exports can be limited to the user's own creations. Cleared client-side when
  // the user replaces the code with their own.
  if (source.imported === true && code) out.imported = true;
  if (out.imported && contentInstalls.INSTALL_ID_RE.test(String(source.installId || ''))) {
    out.installId = String(source.installId);
  }
  return out;
}

module.exports = { normalizeBgCustom };
