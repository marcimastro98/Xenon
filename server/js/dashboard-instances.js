'use strict';
// Pure, requireable helpers for multi-instance widgets ("copies"). Shared by the
// client (window.DashboardInstances) and the server (require). No DOM/browser use.

// '~' separates a base widget id from a copy suffix; it never appears in a widget id.
function baseWidgetOf(instanceId) {
  return String(instanceId == null ? '' : instanceId).split('~')[0];
}

// Widgets converted to multi-instance and therefore safe to DUPLICATE (each phase
// adds more). Until a widget is here, the add/tab flows keep their single-instance
// (move) behaviour for it.
const DUPLICABLE_WIDGETS = new Set(['system', 'media', 'mic', 'audio', 'agenda', 'calendar', 'tasks', 'timer', 'notes', 'chat', 'deck', 'remote', 'browser', 'custom']);
function isDuplicable(instanceId) { return DUPLICABLE_WIDGETS.has(baseWidgetOf(instanceId)); }

// Of the duplicable widgets, those whose COPIES are live mirrors of ONE shared
// primary instance — the primary physically owns the real interactive content
// (the System tile hosts the Volume/Microphone panes, Chat the single AI session,
// the Agenda host its sub-tabs, Media the now-playing). For these the primary must
// never be left hidden while a copy survives on another page: the copy would be
// left as a dead, non-interactive clone. Independent-per-instance widgets
// (deck/browser/remote) are deliberately excluded — each of their copies stands on
// its own and must never be swapped for the primary (that would shuffle a Deck's
// keys or a Browser's address).
const MIRROR_WIDGETS = new Set(['system', 'media', 'chat', 'mic', 'audio', 'agenda', 'calendar', 'tasks', 'timer', 'notes']);
function isMirrorWidget(instanceId) { return MIRROR_WIDGETS.has(baseWidgetOf(instanceId)); }

function makeCopyId(widgetId, existingIds) {
  const has = existingIds instanceof Set
    ? (id) => existingIds.has(id)
    : (id) => Array.isArray(existingIds) && existingIds.includes(id);
  let id;
  do { id = widgetId + '~' + Math.random().toString(36).slice(2, 6); } while (has(id));
  return id;
}

// Per-tile visual style. Additive + optional: a tile with no override stores no
// `style` at all (returns null), so an un-styled layout stays clean. Whitelisted
// exactly like every other layout field — unknown keys are dropped, which also
// makes this the security boundary for style arriving inside an imported preset.
const TILE_FONTS = ['inherit', 'inter', 'pressstart', 'vt323'];
function _tileHex(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : '';
}

// ── Per-tile DECOR (images + effects) ───────────────────────────────────────
// The image layer of a tile's style: a background picture, an ornamental frame
// and decorative overlay images (a dragon in a corner…).
// Images arrive one of three ways, each allowlisted: an inline base64 data URI
// (imported presets / the skill), a locally-uploaded `/uploads/…` file (manual),
// or a curated `preset` id that resolves to a bundled `/assets/decor/…` asset.
// Curated frames/overlays carry NO bytes, so a curated look keeps a share code
// tiny. Everything is clamped and budgeted so the layout blob can't balloon.
const TILE_DECOR_FITS = ['cover', 'contain', 'tile'];
const TILE_OVERLAY_ANCHORS = ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'];
// Allowlisted id sets for curated assets, derived from the single manifest in
// tile-decor-presets.js (id → label/url) so adding a curated asset is ONE edit.
// Loaded before this file in index.html; require() covers node (server + tests).
const _TDP = (typeof window !== 'undefined' && window.TileDecorPresets)
  || (() => { try { return require('./tile-decor-presets.js'); } catch { return null; } })();
const TILE_FRAME_PRESETS = _TDP ? _TDP.TILE_DECOR_FRAMES.map(f => f.id) : [];
const TILE_OVERLAY_PRESETS = _TDP ? _TDP.TILE_DECOR_OVERLAYS.map(o => o.id) : [];
// Per-image char caps (a data URI is ~1.37× the byte size). Generous but bounded.
const TILE_BG_MAX_CHARS = 1500000;      // ~1.1 MB background picture
const TILE_OVERLAY_MAX_CHARS = 900000;  // ~660 KB per overlay/frame
const TILE_DECOR_TOTAL_MAX = 3500000;   // whole-decor inline-bytes budget
const TILE_MAX_OVERLAYS = 4;
// svg+xml is accepted only as a base64 data: URI used as a CSS/border image — the
// browser renders it in secure static mode (no scripts, no external fetches), so
// pasted SVG decor is safe. Never route these into innerHTML.
const TILE_IMG_DATA_RE = /^data:image\/(?:png|jpe?g|webp|gif|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/;
const TILE_IMG_LOCAL_RE = /^\/(?:uploads|assets\/decor)\/[A-Za-z0-9._-]+$/;
// Returns a cleaned, allowlisted image src or '' — the boundary for any image
// reference reaching a tile (manual, imported or curated).
function _tileImageSrc(v, maxChars) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  if (!s || s.length > (maxChars || TILE_BG_MAX_CHARS)) return '';
  return (TILE_IMG_LOCAL_RE.test(s) || TILE_IMG_DATA_RE.test(s)) ? s : '';
}
function _tileNum(v, lo, hi) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null;
}
// A two-stop colour gradient (both stops required) with an optional angle. Used
// as a tile/well background — either on its own or as a tint layered over an
// image. Carries no bytes, so it is always share-code friendly.
function _tileGrad(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const c1 = _tileHex(raw.c1), c2 = _tileHex(raw.c2);
  if (!c1 || !c2) return null;
  const g = { c1, c2 };
  const ang = _tileNum(raw.angle, 0, 360);
  if (ang != null) g.angle = Math.round(ang);
  return g;
}
function normalizeTileDecor(src) {
  if (!src || typeof src !== 'object') return null;
  const out = {};
  let bytes = 0;
  const spend = (s) => { if (s) bytes += s.length; };

  // Background (renders BEHIND the tile content): an image, a colour gradient,
  // or both (gradient layered over the image as a tint).
  if (src.bg && typeof src.bg === 'object') {
    const bg = {};
    const bsrc = _tileImageSrc(src.bg.src, TILE_BG_MAX_CHARS);
    if (bsrc) { bg.src = bsrc; spend(bsrc); }
    const grad = _tileGrad(src.bg.grad);
    if (grad) bg.grad = grad;
    if (bg.src || bg.grad) {
      if (TILE_DECOR_FITS.includes(src.bg.fit)) bg.fit = src.bg.fit;
      const dim = _tileNum(src.bg.dim, 0, 100); if (dim != null) bg.dim = Math.round(dim);
      const blur = _tileNum(src.bg.blur, 0, 20); if (blur != null) bg.blur = Math.round(blur);
      const op = _tileNum(src.bg.opacity, 0, 100); if (op != null) bg.opacity = Math.round(op);
      out.bg = bg;
    }
  }

  // Ornamental frame — a curated preset id OR an uploaded/data image (border-image).
  if (src.frame && typeof src.frame === 'object') {
    const frame = {};
    if (typeof src.frame.preset === 'string' && TILE_FRAME_PRESETS.includes(src.frame.preset)) {
      frame.preset = src.frame.preset;
    } else {
      const fsrc = _tileImageSrc(src.frame.src, TILE_OVERLAY_MAX_CHARS);
      if (fsrc) { frame.src = fsrc; spend(fsrc); }
    }
    if (frame.preset || frame.src) {
      const w = _tileNum(src.frame.width, 0, 40); if (w != null) frame.width = Math.round(w);
      out.frame = frame;
    }
  }

  // Decorative overlays (render ABOVE the content, non-interactive).
  if (Array.isArray(src.overlays)) {
    const overlays = [];
    for (const raw of src.overlays) {
      if (overlays.length >= TILE_MAX_OVERLAYS) break;
      if (!raw || typeof raw !== 'object') continue;
      const ov = {};
      let osrc = '';
      if (typeof raw.preset === 'string' && TILE_OVERLAY_PRESETS.includes(raw.preset)) {
        ov.preset = raw.preset;
      } else {
        osrc = _tileImageSrc(raw.src, TILE_OVERLAY_MAX_CHARS);
        if (!osrc) continue;
        ov.src = osrc;
      }
      ov.anchor = TILE_OVERLAY_ANCHORS.includes(raw.anchor) ? raw.anchor : 'bottom-right';
      // Free placement: an explicit x/y (percent of the tile, overlay centre)
      // overrides the coarse anchor when BOTH are present, so a decoration can sit
      // exactly where the user dragged it rather than snapping to one of nine
      // corners. Guard against null (Number(null) === 0 would force a corner).
      if (raw.x != null && raw.y != null) {
        const ox = _tileNum(raw.x, 0, 100), oy = _tileNum(raw.y, 0, 100);
        if (ox != null && oy != null) { ov.x = Math.round(ox); ov.y = Math.round(oy); }
      }
      const size = _tileNum(raw.size, 1, 100); ov.size = size != null ? Math.round(size) : 40;
      const op = _tileNum(raw.opacity, 0, 100); if (op != null) ov.opacity = Math.round(op);
      const rot = _tileNum(raw.rotate, -180, 180); if (rot != null && Math.round(rot) !== 0) ov.rotate = Math.round(rot);
      if (raw.flip === true) ov.flip = true;
      overlays.push(ov); spend(osrc);
    }
    if (overlays.length) out.overlays = overlays;
  }

  // Over the inline-bytes budget → refuse wholesale (a hard, safe boundary).
  if (bytes > TILE_DECOR_TOTAL_MAX) return null;
  return Object.keys(out).length ? out : null;
}

function normalizeTileStyle(src) {
  if (!src || typeof src !== 'object') return null;
  const out = { mode: src.mode === 'custom' ? 'custom' : 'inherit' };
  const accent = _tileHex(src.accent);
  const panel = _tileHex(src.panel);
  const text = _tileHex(src.text);
  if (accent) out.accent = accent;
  if (panel) out.panel = panel;
  if (text) out.text = text;
  // The panel background may be a two-colour gradient instead of a flat colour
  // (applied only in custom mode, like the other colour tokens).
  const panelGrad = _tileGrad(src.panelGrad);
  if (panelGrad) out.panelGrad = panelGrad;
  const mutedText = _tileHex(src.mutedText);
  if (mutedText) out.mutedText = mutedText;
  const pa = Number(src.panelAlpha);
  if (Number.isFinite(pa) && pa >= 0.05 && pa <= 1) out.panelAlpha = Math.round(pa * 100) / 100;
  const rr = Number(src.radius);
  if (Number.isFinite(rr) && rr >= 0 && rr <= 2) out.radius = Math.round(rr * 100) / 100;
  const gb = Number(src.glassBlur);
  if (Number.isFinite(gb) && gb >= 0 && gb <= 40) out.glassBlur = Math.round(gb);
  const gs = Number(src.glassSaturate);
  if (Number.isFinite(gs) && gs >= 100 && gs <= 220) out.glassSaturate = Math.round(gs);
  const bs = Number(src.borderStrength);
  if (Number.isFinite(bs) && bs >= 0 && bs <= 2) out.borderStrength = Math.round(bs * 100) / 100;
  const ss = Number(src.shadowStrength);
  if (Number.isFinite(ss) && ss >= 0 && ss <= 2) out.shadowStrength = Math.round(ss * 100) / 100;
  if (TILE_FONTS.includes(src.font) && src.font !== 'inherit') out.font = src.font;
  // Decor (images + effects) is orthogonal to the colour-token override: it can
  // ride an otherwise-'inherit' tile, so a user can drop a dragon on a tile
  // without recolouring it. Added before the "empty" check so it counts.
  const decor = normalizeTileDecor(src.decor);
  if (decor) out.decor = decor;
  // A style that only says "inherit" with nothing set carries no information.
  if (out.mode === 'inherit' && Object.keys(out).length === 1) return null;
  return out;
}

// Validate saved copies: known widget, page clamped to pageIds, geometry coerced,
// unique well-formed ids. Invalid entries are dropped.
function normalizeCopies(rawCopies, widgets, pageIds) {
  if (!Array.isArray(rawCopies)) return [];
  const validPages = new Set(Array.isArray(pageIds) ? pageIds : []);
  const firstPage = (pageIds && pageIds[0]) || 'dashboard';
  const seen = new Set();
  const out = [];
  rawCopies.forEach((c) => {
    if (!c || typeof c !== 'object') return;
    const id = String(c.id || '').trim();
    const widget = String(c.widget || '').trim();
    if (!id || id.indexOf('~') < 0 || seen.has(id)) return;
    if (!widgets || !widgets[widget]) return;
    seen.add(id);
    const item = {
      id,
      widget,
      x: Math.max(0, Math.round(Number(c.x)) || 0),
      y: Math.max(0, Math.round(Number(c.y)) || 0),
      w: Math.max(1, Math.round(Number(c.w)) || 1),
      h: Math.max(1, Math.round(Number(c.h)) || 1),
      page: validPages.has(c.page) ? c.page : firstPage,
    };
    const style = normalizeTileStyle(c.style);
    if (style) item.style = style;
    out.push(item);
  });
  return out;
}

// All tile placements on a page: visible primary widgets + copies, as
// { instanceId, widget, x, y, w, h }. Used for occupancy and the "+" drop-zone.
function placementsForPage(layout, pageId) {
  const out = [];
  const widgets = (layout && layout.widgets) || {};
  Object.keys(widgets).forEach((id) => {
    const w = widgets[id];
    if (w && w.visible && w.page === pageId) {
      out.push({ instanceId: id, widget: id, x: w.x || 0, y: w.y || 0, w: w.w || 1, h: w.h || 1 });
    }
  });
  (Array.isArray(layout && layout.copies) ? layout.copies : []).forEach((c) => {
    if (c && c.page === pageId) {
      out.push({ instanceId: c.id, widget: c.widget, x: c.x || 0, y: c.y || 0, w: c.w || 1, h: c.h || 1 });
    }
  });
  return out;
}

const _tileDecorExports = {
  normalizeTileDecor,
  TILE_DECOR_FITS, TILE_OVERLAY_ANCHORS,
  TILE_FRAME_PRESETS, TILE_OVERLAY_PRESETS, TILE_MAX_OVERLAYS,
  // The image-src allowlist, exported so the render path (dashboard-layout.js
  // safeTileImageSrc) re-invokes the SAME validator at the DOM edge instead of
  // keeping a hand-copied regex pair that could drift.
  tileImageSrc: (v) => _tileImageSrc(v),
};
if (typeof window !== 'undefined') {
  window.DashboardInstances = { baseWidgetOf, makeCopyId, normalizeCopies, normalizeTileStyle, TILE_FONTS, placementsForPage, isDuplicable, DUPLICABLE_WIDGETS, isMirrorWidget, MIRROR_WIDGETS, ..._tileDecorExports };
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { baseWidgetOf, makeCopyId, normalizeCopies, normalizeTileStyle, TILE_FONTS, placementsForPage, isDuplicable, DUPLICABLE_WIDGETS, isMirrorWidget, MIRROR_WIDGETS, ..._tileDecorExports };
}
