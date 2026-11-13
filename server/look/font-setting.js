// Checks the saved custom font: only a font file the engine itself stored is kept.

const { FONT_MIME_BY_EXT } = require('../http/upload-limits.js');

// The custom UI font reference mirrors backgroundMedia: only a server-generated
// /uploads/ path with a known font extension is kept; anything else resets to
// "use the default typeface". The binary itself lives in UPLOADS_DIR.
function sanitizeSettingsUiFont(value) {
  if (!value || typeof value !== 'object') return null;
  const url = String(value.url || '').trim();
  const name = String(value.name || '').trim().slice(0, 120);
  const version = String(value.version || '').trim().replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40);
  if (!/^\/uploads\/[A-Za-z0-9._-]+$/.test(url)) return null;
  const ext = url.slice(url.lastIndexOf('.')).toLowerCase();
  if (!FONT_MIME_BY_EXT.has(ext)) return null;
  return { url, name: name || url.split('/').pop(), version };
}

module.exports = { sanitizeSettingsUiFont };
