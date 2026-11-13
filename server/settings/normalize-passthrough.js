// Settings the dashboard owns and the engine only stores: kept when they are plain objects of a
// sane size.

// Bounded passthrough for the client-owned saved presets array. Templates are
// small (base widget ids + geometry, no image data), so a generous size cap is
// plenty; anything bigger or malformed is dropped to an empty list.
function sanitizeDashboardPresets(value) {
  if (!Array.isArray(value)) return [];
  try {
    const json = JSON.stringify(value);
    if (json.length > 200000) return [];
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.slice(0, 60) : [];
  } catch { return []; }
}

// Defensive passthrough for a client-owned settings object: keep it only if it's
// a plain object that serializes within a sane size, returning a clean copy.
const SDK_WIDGETS_SETTINGS_MAX = 128 * 1024;
function sanitizeServerPassthrough(value, maxLen = 8000) {
  if (!value || typeof value !== 'object') return undefined;
  try {
    const json = JSON.stringify(value);
    if (json.length > maxLen) return undefined;
    return JSON.parse(json);
  } catch { return undefined; }
}

module.exports = { sanitizeDashboardPresets, SDK_WIDGETS_SETTINGS_MAX, sanitizeServerPassthrough };
