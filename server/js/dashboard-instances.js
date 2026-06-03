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
const DUPLICABLE_WIDGETS = new Set(['system', 'media', 'mic', 'audio', 'calendar', 'tasks', 'timer', 'notes', 'lighting', 'chat']);
function isDuplicable(instanceId) { return DUPLICABLE_WIDGETS.has(baseWidgetOf(instanceId)); }

function makeCopyId(widgetId, existingIds) {
  const has = existingIds instanceof Set
    ? (id) => existingIds.has(id)
    : (id) => Array.isArray(existingIds) && existingIds.includes(id);
  let id;
  do { id = widgetId + '~' + Math.random().toString(36).slice(2, 6); } while (has(id));
  return id;
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
    out.push({
      id,
      widget,
      x: Math.max(0, Math.round(Number(c.x)) || 0),
      y: Math.max(0, Math.round(Number(c.y)) || 0),
      w: Math.max(1, Math.round(Number(c.w)) || 1),
      h: Math.max(1, Math.round(Number(c.h)) || 1),
      page: validPages.has(c.page) ? c.page : firstPage,
    });
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
  window.DashboardInstances = { baseWidgetOf, makeCopyId, normalizeCopies, placementsForPage, isDuplicable, DUPLICABLE_WIDGETS };
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { baseWidgetOf, makeCopyId, normalizeCopies, placementsForPage, isDuplicable, DUPLICABLE_WIDGETS };
}
