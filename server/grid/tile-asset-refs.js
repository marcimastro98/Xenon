// Finds which uploaded tile pictures a layout still uses, and says how long an unused one is
// kept before it is deleted.

// Per-tile decoration assets have no one-live-file policy (many tiles, many
// pictures), so they are reference-counted instead: every dashboard layout that
// is persisted names the `tileasset-*` files still in use, and the rest are swept.
function _collectTileAssetRefsFromStyle(style, set) {
  const d = style && style.decor;
  if (!d) return;
  const add = (src) => {
    if (typeof src !== 'string') return;
    const m = src.match(/^\/uploads\/(tileasset-[A-Za-z0-9._-]+)$/);
    if (m) set.add(m[1]);
  };
  if (d.bg) add(d.bg.src);
  if (d.frame) add(d.frame.src);
  if (Array.isArray(d.overlays)) d.overlays.forEach(o => add(o && o.src));
}
function collectTileAssetRefs(layout, presets) {
  const set = new Set();
  if (layout && typeof layout === 'object') {
    const scan = (coll) => { if (coll && typeof coll === 'object') Object.keys(coll).forEach(k => _collectTileAssetRefsFromStyle(coll[k] && coll[k].style, set)); };
    scan(layout.widgets);
    scan(layout.groups);
    if (Array.isArray(layout.copies)) layout.copies.forEach(c => _collectTileAssetRefsFromStyle(c && c.style, set));
  }
  // Saved "My presets" keep tile styles too (widget/group/page items, already
  // bounded to 200 KB by sanitizeDashboardPresets) — a deep string scan keeps
  // their assets alive without chasing every nesting shape.
  if (Array.isArray(presets) && presets.length) {
    try {
      const json = JSON.stringify(presets);
      for (const m of json.matchAll(/\/uploads\/(tileasset-[A-Za-z0-9._-]+)/g)) set.add(m[1]);
    } catch { /* unserializable presets — nothing to protect */ }
  }
  return set;
}
// A fresh upload lands before the layout that references it is saved, so a grace
// window protects any `tileasset-*` touched in the last 10 minutes from the sweep.
const TILE_ASSET_GC_GRACE_MS = 10 * 60 * 1000;
// Sweep throttle: settings persist on every tweak (250 ms client debounce), and
// each sweep costs a readdir — with an unchanged reference set a re-sweep only
// matters once more files age past the grace window, so 5 minutes is plenty.
const TILE_ASSET_GC_MIN_INTERVAL_MS = 5 * 60 * 1000;

module.exports = {
  _collectTileAssetRefsFromStyle, collectTileAssetRefs, TILE_ASSET_GC_GRACE_MS,
  TILE_ASSET_GC_MIN_INTERVAL_MS,
};
