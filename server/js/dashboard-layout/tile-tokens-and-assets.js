// Applies a tile's colors and fonts, saves a tile's style, and uploads a picture for it.
'use strict';

// The material tokens themselves. Returns true when the tile carries any.
function applyTileTokens(el, style) {
  let any = false;
  if (typeof style.panelAlpha === 'number') {
    el.style.setProperty('--panel-alpha', style.panelAlpha.toFixed(2));
    el.style.setProperty('--panel', 'rgba(var(--panel-rgb), var(--panel-alpha))');
    // At this point there is no panel left, so the top-lit wash and the hairline
    // highlight have to go with it: they are part of the fill, and a card asked
    // to be transparent that kept them read as a faint white sheet.
    if (style.panelAlpha <= 0.02) el.setAttribute('data-tile-plain', '');
    else if (style.panelAlpha < TILE_THIN_BELOW) el.setAttribute('data-tile-thin', '');
    any = true;
  }
  if (typeof style.radius === 'number') {
    [['--radius', 8], ['--radius-control', 10], ['--radius-tile', 16], ['--radius-modal', 20]]
      .forEach(([prop, base]) => el.style.setProperty(prop, `${+(base * style.radius).toFixed(2)}px`));
    any = true;
  }
  if (typeof style.glassBlur === 'number') {
    el.style.setProperty('--glass-blur', `${Math.round(style.glassBlur)}px`);
    // Opt-in, and only when there is a blur to apply: backdrop-filter is a
    // per-frame GPU cost and the Edge composites on the integrated adapter.
    if (style.glassBlur > 0) el.setAttribute('data-tile-glass', '');
    any = true;
  }
  if (typeof style.glassSaturate === 'number') {
    el.style.setProperty('--glass-saturate', `${Math.round(style.glassSaturate)}%`);
    any = true;
  }
  // Border/shadow use the same derivation the theme does, seeded from this tile's
  // own panel opacity (or the stock 0.94) so the strength reads consistently.
  const tp = (typeof style.panelAlpha === 'number') ? style.panelAlpha : 0.94;
  if (typeof style.borderStrength === 'number') {
    el.style.setProperty('--panel-border-alpha', Math.min(0.4, (0.045 + tp * 0.08) * style.borderStrength).toFixed(3));
    el.style.setProperty('--panel-border', 'rgba(255, 255, 255, var(--panel-border-alpha))');
    any = true;
  }
  if (typeof style.shadowStrength === 'number') {
    el.style.setProperty('--panel-shadow-alpha', Math.min(0.6, (0.05 + tp * 0.18) * style.shadowStrength).toFixed(3));
    const palette = (typeof window.getEffectiveThemePalette === 'function') ? window.getEffectiveThemePalette() : null;
    const drop = (window.PANEL_DROP_CSS || {})[palette && palette.tone === 'light' ? 'light' : 'dark'];
    // The theme's drop is a tight contact shadow: at any strength it stays a thin
    // band under the bottom edge, so the slider read as doing nothing. A tile's
    // own shadow adds a lift layer whose reach grows with the strength.
    const s = style.shadowStrength;
    const lift = s > 0 ? `, 0 ${Math.round(6 * s)}px ${Math.round(22 * s)}px -4px rgba(0,0,0, calc(var(--panel-shadow-alpha) * 0.9))` : '';
    if (drop) el.style.setProperty('--panel-drop', drop + lift);
    // The user asked for a shadow on THIS tile. That is the one case where a tile
    // with no panel left still casts one (see DashboardGrid.css, data-tile-plain).
    el.setAttribute('data-tile-shadow', '');
    any = true;
  }
  return any;
}
function applyAllTileStyles(layout, opts) {
  const lay = layout || getDashboardLayout();
  document.querySelectorAll('.grid-stack-item[gs-id]').forEach(el => {
    applyTileStyle(el, tileStyleForId(lay, el.getAttribute('gs-id')), opts);
  });
  if (window.CustomWidget && typeof window.CustomWidget.refreshTheme === 'function') {
    window.CustomWidget.refreshTheme();
  }
}

// Write a tile's style into whichever store owns it (primary / group / copy),
// paint it live, and persist. `style` null removes the override.
function setTileStyle(id, style) {
  const layout = getDashboardLayout();
  const target = (layout.widgets && layout.widgets[id]) ? layout.widgets[id]
    : (layout.groups && layout.groups[id]) ? layout.groups[id]
      : (Array.isArray(layout.copies) ? layout.copies.find(c => c.id === id) : null);
  if (!target) return;
  // Tab colours belong to a tab group; a style pasted onto any other tile drops them.
  if (style && style.tabs && !(layout.groups && layout.groups[id])) {
    style = Object.assign({}, style);
    delete style.tabs;
  }
  if (style) target.style = style; else delete target.style;
  // Repaint from the live layout (iterates by gs-id attribute — no fragile
  // selector escaping for copy ids that contain '~').
  applyAllTileStyles(layout);
  saveDashboardLayout(layout, { status: false });
}

// Downscale a raster image (shared rasterToCanvas core, utils.js) to keep
// uploaded tile assets small; GIFs are kept as-is so their animation survives
// (a canvas re-encode would flatten them). Any failure falls back to the
// original file — the /tile-asset endpoint enforces the hard size cap.
async function _tileDownscaleImage(file, maxEdge) {
  if (!file || file.type === 'image/gif') return file;
  // An animated WebP or APNG is sent as it is too: the canvas keeps one frame.
  if (typeof GifRead !== 'undefined') {
    const head = new Uint8Array(await file.slice(0, 65536).arrayBuffer().catch(() => new ArrayBuffer(0)));
    if (GifRead.animatedKind(head)) return file;
  }
  const cv = await rasterToCanvas(file, maxEdge);
  if (!cv) return file;
  const type = file.type === 'image/png' || file.type === 'image/webp' ? file.type : 'image/jpeg';
  return new Promise((resolve) => cv.toBlob(b => resolve(b || file), type, 0.9));
}
// Upload a tile decoration image and resolve its served /uploads/ URL.
async function uploadTileAsset(file, maxEdge) {
  const blob = await _tileDownscaleImage(file, maxEdge || 1280);
  const type = blob.type || file.type || 'image/jpeg';
  const ext = type === 'image/png' ? 'png' : type === 'image/gif' ? 'gif' : type === 'image/webp' ? 'webp' : 'jpg';
  const form = new FormData();
  form.append('asset', blob, `tile.${ext}`);
  const res = await fetch('/tile-asset', { method: 'POST', body: form });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j || !j.url) throw new Error((j && j.error) || 'upload failed');
  return j.url;
}
