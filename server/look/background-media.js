// Checks the picture or video saved as the dashboard background: an uploaded file of this
// server, or a small inline SVG.

const { BG_SVG_DATA_RE, BG_SVG_MAX_CHARS } = require('./background-values.js');
const contentInstalls = require('../js/content-installs.js');

function sanitizeSettingsBackgroundMedia(value) {
  if (!value || typeof value !== 'object') return null;
  const url = String(value.url || '').trim();
  const name = String(value.name || '').trim().slice(0, 120);
  const type = String(value.type || '').trim().slice(0, 60);
  const version = String(value.version || '').trim().replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40);
  let out;
  if (url.startsWith('data:')) {
    if (url.length > BG_SVG_MAX_CHARS || !BG_SVG_DATA_RE.test(url)) return null;
    out = { url, name: name || 'svg', type: 'image/svg+xml', version };
  } else {
    if (!/^\/uploads\/[A-Za-z0-9._-]+$/.test(url)) return null;
    if (!/^(image|video)\//.test(type)) return null;
    out = { url, name: name || url.split('/').pop(), type, version };
  }
  // Redistribution marker (mirrors bgCustom): a wallpaper installed from a
  // package is never offered back in an export, and its receipt can remove it.
  if (value.imported === true) out.imported = true;
  if (out.imported && contentInstalls.INSTALL_ID_RE.test(String(value.installId || ''))) {
    out.installId = String(value.installId);
  }
  return out;
}

module.exports = { sanitizeSettingsBackgroundMedia };
