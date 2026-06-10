'use strict';
// Saved dashboard presets: capture a widget, a tab-group, or a whole page as a
// reusable template (base widget ids + geometry, never live instance ids), and
// materialise a template back onto the dashboard as fresh instances. Pure model
// helpers (capture/normalize) are unit-tested; insertPreset mutates a layout in
// place (no DOM) and is shared with the runtime. Presets live in
// hubSettings.dashboardPresets (server-backed, round-tripped through settings).

const PRESET_KINDS = ['widget', 'group', 'page'];
const PRESET_MAX = 60;

function _knownSet(knownWidgetIds) {
  if (knownWidgetIds instanceof Set) return knownWidgetIds;
  if (Array.isArray(knownWidgetIds)) return new Set(knownWidgetIds);
  return new Set(typeof DASHBOARD_WIDGET_IDS !== 'undefined' ? DASHBOARD_WIDGET_IDS : []);
}

function _groupOf(layout, instanceId) {
  const groups = (layout && layout.groups) || {};
  for (const gid of Object.keys(groups)) {
    if (((groups[gid] || {}).members || []).includes(instanceId)) return gid;
  }
  return null;
}

// Base widget id behind an instance id (primary id, copy id `base~xxxx`, or a
// group's member). Falls back to splitting on '~'.
function _baseOf(layout, instanceId) {
  if (layout && layout.widgets && layout.widgets[instanceId]) return instanceId;
  const copy = (layout && Array.isArray(layout.copies) ? layout.copies : []).find(c => c.id === instanceId);
  if (copy) return copy.widget;
  return String(instanceId == null ? '' : instanceId).split('~')[0];
}

function _geomOf(layout, instanceId) {
  if (layout.groups && layout.groups[instanceId]) {
    const g = layout.groups[instanceId];
    return { x: g.x || 0, y: g.y || 0, w: g.w || 4, h: g.h || 4, page: g.page };
  }
  if (layout.widgets && layout.widgets[instanceId]) {
    const w = layout.widgets[instanceId];
    return { x: w.x || 0, y: w.y || 0, w: w.w || 4, h: w.h || 3, page: w.page };
  }
  const c = (Array.isArray(layout.copies) ? layout.copies : []).find(x => x.id === instanceId);
  if (c) return { x: c.x || 0, y: c.y || 0, w: c.w || 4, h: c.h || 3, page: c.page };
  return null;
}

// ── Capture (layout → template data) ──────────────────────────────
function captureWidget(layout, instanceId) {
  const g = _geomOf(layout, instanceId);
  const widget = _baseOf(layout, instanceId);
  if (!g || !widget) return null;
  return { widget, w: g.w, h: g.h };
}

function captureGroup(layout, gid) {
  const grp = layout.groups && layout.groups[gid];
  if (!grp) return null;
  const members = (grp.members || []).map(m => _baseOf(layout, m));
  if (members.length < 2) return null;
  let active = members.indexOf(_baseOf(layout, grp.active));
  if (active < 0) active = 0;
  const data = { members, active, w: grp.w || 4, h: grp.h || 4 };
  if (grp.autoTabByMedia) data.autoTabByMedia = true;
  return data;
}

function capturePage(layout, pageId, widgetIds) {
  const ids = Array.isArray(widgetIds) ? widgetIds
    : (typeof DASHBOARD_WIDGET_IDS !== 'undefined' ? DASHBOARD_WIDGET_IDS : Object.keys(layout.widgets || {}));
  const items = [];
  ids.forEach(id => {
    const w = layout.widgets[id];
    if (w && w.visible && w.page === pageId && !_groupOf(layout, id)) {
      items.push({ type: 'widget', widget: id, x: w.x || 0, y: w.y || 0, w: w.w || 4, h: w.h || 3 });
    }
  });
  Object.keys(layout.groups || {}).forEach(gid => {
    const grp = layout.groups[gid];
    if (!grp || grp.page !== pageId) return;
    const members = (grp.members || []).map(m => _baseOf(layout, m));
    if (members.length < 2) return;
    let active = members.indexOf(_baseOf(layout, grp.active));
    if (active < 0) active = 0;
    const item = { type: 'group', x: grp.x || 0, y: grp.y || 0, w: grp.w || 4, h: grp.h || 4, members, active };
    if (grp.autoTabByMedia) item.autoTabByMedia = true;
    items.push(item);
  });
  (Array.isArray(layout.copies) ? layout.copies : []).forEach(c => {
    if (c && c.page === pageId && !_groupOf(layout, c.id)) {
      items.push({ type: 'widget', widget: c.widget, x: c.x || 0, y: c.y || 0, w: c.w || 4, h: c.h || 3 });
    }
  });
  return { items };
}

// Generic capture entry point used by the UI. Returns the kind-specific `data`
// payload (no envelope), or null when there's nothing valid to save.
function capture(layout, kind, sourceId, pageId, widgetIds) {
  if (kind === 'widget') return captureWidget(layout, sourceId);
  if (kind === 'group') return captureGroup(layout, sourceId);
  if (kind === 'page') {
    const data = capturePage(layout, pageId, widgetIds);
    return data.items.length ? data : null;
  }
  return null;
}

// ── Normalize (validate persisted presets) ────────────────────────
function _coordGeom(o) {
  return {
    x: Math.max(0, Math.round(Number(o && o.x)) || 0),
    y: Math.max(0, Math.round(Number(o && o.y)) || 0),
    w: Math.max(1, Math.round(Number(o && o.w)) || 4),
    h: Math.max(1, Math.round(Number(o && o.h)) || 3),
  };
}

function _normGroupData(d, known) {
  const members = (Array.isArray(d && d.members) ? d.members : []).filter(m => known.has(m));
  if (members.length < 2) return null;
  let active = Math.round(Number(d && d.active));
  if (!Number.isFinite(active) || active < 0 || active >= members.length) active = 0;
  const out = { members, active, w: Math.max(1, Math.round(Number(d && d.w)) || 4), h: Math.max(1, Math.round(Number(d && d.h)) || 4) };
  if (d && d.autoTabByMedia) out.autoTabByMedia = true;
  return out;
}

function _normPayload(kind, d, known) {
  if (kind === 'widget') {
    if (!d || !known.has(d.widget)) return null;
    return { widget: d.widget, w: Math.max(1, Math.round(Number(d.w)) || 4), h: Math.max(1, Math.round(Number(d.h)) || 3) };
  }
  if (kind === 'group') return _normGroupData(d, known);
  if (kind === 'page') {
    const items = [];
    (Array.isArray(d && d.items) ? d.items : []).forEach(it => {
      if (!it || typeof it !== 'object') return;
      if (it.type === 'group') {
        const g = _normGroupData(it, known);
        if (g) items.push(Object.assign({ type: 'group' }, _coordGeom(it), g));
      } else if (known.has(it.widget)) {
        items.push(Object.assign({ type: 'widget', widget: it.widget }, _coordGeom(it)));
      }
    });
    return items.length ? { items } : null;
  }
  return null;
}

function normalizePresets(raw, knownWidgetIds) {
  if (!Array.isArray(raw)) return [];
  const known = _knownSet(knownWidgetIds);
  const out = [];
  const seen = new Set();
  for (const p of raw) {
    if (out.length >= PRESET_MAX) break;
    if (!p || typeof p !== 'object') continue;
    const kind = PRESET_KINDS.includes(p.kind) ? p.kind : null;
    if (!kind) continue;
    const data = _normPayload(kind, p.data, known);
    if (!data) continue;
    let id = String(p.id == null ? '' : p.id).trim().slice(0, 64);
    if (!id || seen.has(id)) id = 'ps_' + Math.random().toString(36).slice(2, 8) + out.length.toString(36);
    seen.add(id);
    out.push({
      id,
      name: String(p.name == null ? '' : p.name).trim().slice(0, 40),
      kind,
      createdAt: Number.isFinite(p.createdAt) ? p.createdAt : 0,
      data,
    });
  }
  return out;
}

// ── Insert (template → fresh instances on a layout) ────────────────
function _firstFreeSlot(occupied, w, h, columns) {
  const cols = columns || 12;
  const fits = (x, y) => {
    if (x + w > cols) return false;
    return !occupied.some(o => x < o.x + o.w && x + w > o.x && y < o.y + o.h && y + h > o.y);
  };
  for (let y = 0; y < 500; y++) {
    for (let x = 0; x <= cols - w; x++) {
      if (fits(x, y)) return { x, y };
    }
  }
  return { x: 0, y: 0 };
}

function _occupiedRects(layout, pageId) {
  const rects = [];
  Object.keys(layout.widgets || {}).forEach(id => {
    const w = layout.widgets[id];
    if (w && w.visible && w.page === pageId && !_groupOf(layout, id)) rects.push({ x: w.x || 0, y: w.y || 0, w: w.w || 1, h: w.h || 1 });
  });
  Object.keys(layout.groups || {}).forEach(gid => {
    const g = layout.groups[gid];
    if (g && g.page === pageId) rects.push({ x: g.x || 0, y: g.y || 0, w: g.w || 1, h: g.h || 1 });
  });
  (Array.isArray(layout.copies) ? layout.copies : []).forEach(c => {
    if (c && c.page === pageId && !_groupOf(layout, c.id)) rects.push({ x: c.x || 0, y: c.y || 0, w: c.w || 1, h: c.h || 1 });
  });
  return rects;
}

function _newCopyId(layout, widget) {
  const existing = new Set([...Object.keys(layout.widgets || {}), ...((layout.copies || []).map(c => c.id))]);
  let id;
  do { id = widget + '~' + Math.random().toString(36).slice(2, 6); } while (existing.has(id));
  return id;
}

function _newGroupId(layout) {
  let id;
  do { id = 'g-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); } while (layout.groups && layout.groups[id]);
  return id;
}

function _isDuplicable(widget) {
  return !!(typeof window !== 'undefined' && window.DashboardInstances && window.DashboardInstances.isDuplicable(widget));
}

// Materialise one widget instance on a page at the given geometry. Reuses the
// primary tile only if it is entirely unplaced; otherwise adds a copy (when the
// base is duplicable). Returns the instance id placed, or null.
function _materializeWidget(layout, widget, pageId, geom) {
  const w = layout.widgets && layout.widgets[widget];
  if (!w) return null;
  const primaryPlaced = w.visible || _groupOf(layout, widget);
  if (!primaryPlaced) {
    w.visible = true; w.page = pageId; w.x = geom.x; w.y = geom.y; w.w = geom.w; w.h = geom.h;
    return widget;
  }
  if (!_isDuplicable(widget)) return null; // already placed and can't be cloned
  const id = _newCopyId(layout, widget);
  if (!Array.isArray(layout.copies)) layout.copies = [];
  layout.copies.push({ id, widget, x: geom.x, y: geom.y, w: geom.w, h: geom.h, page: pageId });
  return id;
}

// Materialise a tab-group at `geom` on `pageId` from base member ids.
function _materializeGroup(layout, data, pageId, geom) {
  const memberIds = [];
  (data.members || []).forEach(base => {
    const id = _materializeWidget(layout, base, pageId, geom);
    if (id) memberIds.push(id);
  });
  if (!memberIds.length) return;
  if (memberIds.length === 1) return; // a lone member just stays standalone
  const gid = _newGroupId(layout);
  if (!layout.groups) layout.groups = {};
  let active = Number.isFinite(data.active) && data.active >= 0 && data.active < memberIds.length ? data.active : 0;
  layout.groups[gid] = { id: gid, members: memberIds, active: memberIds[active], x: geom.x, y: geom.y, w: geom.w, h: geom.h, page: pageId };
  if (data.autoTabByMedia) layout.groups[gid].autoTabByMedia = true;
}

function _addPage(layout, name) {
  const MAX = (typeof DASHBOARD_PAGES_MAX !== 'undefined') ? DASHBOARD_PAGES_MAX : 8;
  if (!Array.isArray(layout.pages)) layout.pages = [];
  if (layout.pages.length >= MAX) return null;
  const id = 'page-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
  const clean = String(name == null ? '' : name).trim().slice(0, 40);
  layout.pages.push({ id, name: clean || 'Page' });
  return id;
}

// Insert `preset` into `layout` (mutated in place). Widget/group land on
// `pageId` at the next free slot (saved size); a page preset creates a NEW page
// and reproduces every tile at its saved geometry. Returns { ok, pageId? }.
function insertPreset(layout, preset, pageId) {
  if (!preset || !PRESET_KINDS.includes(preset.kind)) return { ok: false };
  const data = preset.data || {};
  if (preset.kind === 'widget') {
    const occ = _occupiedRects(layout, pageId);
    const slot = _firstFreeSlot(occ, data.w || 4, data.h || 3, 12);
    _materializeWidget(layout, data.widget, pageId, { x: slot.x, y: slot.y, w: data.w || 4, h: data.h || 3 });
    return { ok: true };
  }
  if (preset.kind === 'group') {
    const occ = _occupiedRects(layout, pageId);
    const slot = _firstFreeSlot(occ, data.w || 4, data.h || 4, 12);
    _materializeGroup(layout, data, pageId, { x: slot.x, y: slot.y, w: data.w || 4, h: data.h || 4 });
    return { ok: true };
  }
  // page: create a new page and reproduce its tiles at their saved geometry.
  const newPageId = _addPage(layout, preset.name);
  if (!newPageId) return { ok: false, full: true };
  (data.items || []).forEach(item => {
    const geom = { x: item.x || 0, y: item.y || 0, w: item.w || 4, h: item.h || 3 };
    if (item.type === 'group') _materializeGroup(layout, item, newPageId, geom);
    else _materializeWidget(layout, item.widget, newPageId, geom);
  });
  return { ok: true, pageId: newPageId };
}

if (typeof window !== 'undefined') {
  window.DashboardPresets = { capture, captureWidget, captureGroup, capturePage, normalizePresets, insertPreset, PRESET_KINDS, PRESET_MAX };
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { capture, captureWidget, captureGroup, capturePage, normalizePresets, insertPreset, PRESET_KINDS, PRESET_MAX };
}
