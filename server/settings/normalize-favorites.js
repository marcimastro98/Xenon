// Checks the saved browser tiles and the browser and app favourites.

function normalizeServerBrowserTiles(value) {
  const v = value && typeof value === 'object' ? value : {};
  const out = {};
  let n = 0;
  for (const key of Object.keys(v)) {
    if (n >= 32) break;
    if (!/^browser(~[a-z0-9]+)?$/.test(key)) continue;
    const entry = v[key];
    if (!entry || typeof entry !== 'object') continue;
    const norm = normalizeServerBrowserTileEntry(entry);
    if (!norm) continue;
    out[key] = norm;
    n++;
  }
  return out;
}

// A tile persists either the current multi-tab shape { tabs:[{url}], active } or
// the legacy single-URL shape { url }. Round-trip whichever it is — dropping the
// multi-tab shape here (keeping only { url }) wiped every tab on a settings save.
// URLs are re-validated by the relay before navigating.
function normalizeServerBrowserTileEntry(entry) {
  // chromeHidden (toolbar hidden) is a per-tile UI pref that MUST round-trip so a
  // "hide toolbar" set on one surface syncs to the others (this is the authoritative
  // copy other surfaces hydrate). It was dropped here, so the Edge kept its toolbar
  // out of step with the browser (GitHub #101).
  const chromeHidden = !!entry.chromeHidden;
  if (Array.isArray(entry.tabs)) {
    const tabs = entry.tabs.slice(0, 6).map((tb) => ({ url: String((tb && tb.url) || '').slice(0, 2048) }));
    if (!tabs.length) return null;
    if (tabs.length === 1 && !tabs[0].url && !chromeHidden) return null;
    const active = Math.max(0, Math.min(tabs.length - 1, parseInt(entry.active, 10) || 0));
    return { tabs, active, chromeHidden };
  }
  const url = String(entry.url || '').slice(0, 2048);
  return (url || chromeHidden) ? { url, chromeHidden } : null;
}

function normalizeServerBrowserFavorites(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    if (out.length >= 16) break;
    if (!entry || typeof entry !== 'object') continue;
    const url = String(entry.url || '').trim().slice(0, 2048);
    if (!url) continue;
    out.push({ label: String(entry.label || '').slice(0, 40), url });
  }
  return out;
}

// App-switcher favorites (client-owned). Round-tripped so a starred app survives a
// browser-storage reset (PC restart / new WebView profile) — the same reason the
// UI language is persisted here. Keyed by the stable app (process) NAME, one entry
// per app, keeping a cached icon + the exe path so a favorite for a CLOSED app can
// be launched (the /windows/launch endpoint re-validates the path through the
// allowlisted openApp runner before spawning). Array order IS the dock order.
// Same pattern as SAFE_IMAGE_DATA_URI_RE in js/utils.js (a test keeps the two
// identical): a raster image type and only base64 after the comma.
const SAFE_IMAGE_DATA_URI_RE = /^data:image\/(png|jpeg|gif|webp|x-icon|bmp);base64,[A-Za-z0-9+/]+={0,2}$/;
function normalizeServerAppFavorites(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of value) {
    if (out.length >= 12) break;
    if (!entry || typeof entry !== 'object') continue;
    const app = String(entry.app || '').trim().slice(0, 120);
    const key = String(entry.key || app).trim().toLowerCase().slice(0, 120);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      app,
      title: String(entry.title || '').slice(0, 200),
      // Cached window icon as a small data: URI (48px PNG ≈ a few KB); bounded so a
      // malformed payload can't bloat settings.json. Over the bound it is dropped,
      // not cut: a truncated image is broken anyway. The shape check is the
      // dashboard's (SAFE_IMAGE_DATA_URI_RE): settings also arrive from backups.
      icon: (typeof entry.icon === 'string' && entry.icon.length <= 60000 && SAFE_IMAGE_DATA_URI_RE.test(entry.icon)) ? entry.icon : '',
      path: String(entry.path || '').slice(0, 400),
    });
  }
  return out;
}

module.exports = {
  normalizeServerBrowserTiles, normalizeServerBrowserTileEntry, normalizeServerBrowserFavorites,
  SAFE_IMAGE_DATA_URI_RE, normalizeServerAppFavorites,
};
