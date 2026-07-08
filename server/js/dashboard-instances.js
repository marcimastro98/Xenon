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
function normalizeTileStyle(src) {
  if (!src || typeof src !== 'object') return null;
  const out = { mode: src.mode === 'custom' ? 'custom' : 'inherit' };
  const accent = _tileHex(src.accent);
  const panel = _tileHex(src.panel);
  const text = _tileHex(src.text);
  if (accent) out.accent = accent;
  if (panel) out.panel = panel;
  if (text) out.text = text;
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

if (typeof window !== 'undefined') {
  window.DashboardInstances = { baseWidgetOf, makeCopyId, normalizeCopies, normalizeTileStyle, TILE_FONTS, placementsForPage, isDuplicable, DUPLICABLE_WIDGETS, isMirrorWidget, MIRROR_WIDGETS };
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { baseWidgetOf, makeCopyId, normalizeCopies, normalizeTileStyle, TILE_FONTS, placementsForPage, isDuplicable, DUPLICABLE_WIDGETS, isMirrorWidget, MIRROR_WIDGETS };
}
