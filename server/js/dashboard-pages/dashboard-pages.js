'use strict';
// User-defined dashboard pages: owns the page list lifecycle, generates the
// pager-page sections dynamically, and drives the pager + layout. Pure helpers
// (top) are unit-tested; the runtime/DOM parts (below) need the browser.

const DASHBOARD_PAGES_MAX = 8;

function clampPageName(name, fallback) {
  const s = String(name == null ? '' : name).trim().slice(0, 40);
  return s || fallback || '';
}

// What a rename should STORE, given the typed input. A non-empty name is kept
// (clamped); an empty one means "reset to the default", which is the seed key
// when the page still carries one — `name` wins over `nameKey` in
// pageDisplayName, so storing '' is what lets the localised seed name come
// back — and otherwise the positional fallback. It must never resolve to the
// empty string on a page with no key, or the display name drops through to the
// raw page id (`page-lx3k9`).
function resolveRenamedPageName(input, hasNameKey, fallback) {
  const next = clampPageName(input, '');
  if (next) return next;
  return hasNameKey ? '' : clampPageName(fallback, '');
}

// Normalise a saved page list: unique non-empty ids, clamped names, 1..MAX;
// empty/invalid falls back to the seed.
function normalizePagesList(pages, seed) {
  const seedList = Array.isArray(seed) ? seed : [];
  if (!Array.isArray(pages)) return seedList.slice();
  const out = [];
  const seen = new Set();
  pages.forEach(p => {
    if (!p || typeof p !== 'object') return;
    const id = String(p.id || '').trim().slice(0, 64);
    if (!id || seen.has(id)) return;
    seen.add(id);
    const page = { id, name: clampPageName(p.name, '') };
    if (p.nameKey) page.nameKey = String(p.nameKey).slice(0, 64);
    if (p.imported === true) page.imported = true;   // arrived via a shared preset → not re-exportable
    if (page.imported && /^xi_[a-z0-9]{8,32}$/.test(String(p.installId || ''))) page.installId = String(p.installId);
    out.push(page);
  });
  if (!out.length) return seedList.slice();
  return out.slice(0, DASHBOARD_PAGES_MAX);
}

// Any widget whose page id is not in pageIds is reassigned to firstPageId.
function reassignOrphanWidgetPages(widgets, pageIds, firstPageId) {
  const valid = new Set(pageIds);
  Object.keys(widgets || {}).forEach(id => {
    const w = widgets[id];
    if (w && !valid.has(w.page)) w.page = firstPageId;
  });
  return widgets;
}

// Before a page is removed, keep a LIVE singleton-host primary alive when a copy
// of it survives on another page. The primary tile is the one that physically
// owns the interactive content (the System tile hosts the Volume/Microphone
// panes); merely hiding it — as the page-removal does for every other widget —
// would leave the surviving page showing only a dead clone, which is the reported
// "Volume/Microphone disappears when I delete the other page" bug. We instead MOVE
// the primary onto the surviving copy's slot and drop the now-redundant copy, so
// the live instance follows the page the user keeps.
//
// Scope is deliberately narrow and low-risk: only "mirror" widgets (deck/browser/
// remote copies are independent and must NOT be swapped), only a STANDALONE
// primary with a STANDALONE surviving copy — grouped placements already relocate
// through group normalization. `isMirror` is injected for testing; at runtime it
// falls back to DashboardInstances. Mutates `layout` in place.
function promoteSurvivingPrimaries(layout, removedPageId, isMirror) {
  if (!layout || !Array.isArray(layout.copies) || !layout.widgets) return layout;
  const mirror = typeof isMirror === 'function'
    ? isMirror
    : (id) => !!(typeof window !== 'undefined' && window.DashboardInstances
      && typeof window.DashboardInstances.isMirrorWidget === 'function'
      && window.DashboardInstances.isMirrorWidget(id));
  const groups = layout.groups || {};
  const inAnyGroup = (instId) =>
    Object.keys(groups).some(gid => ((groups[gid] || {}).members || []).includes(instId));
  Object.keys(layout.widgets).forEach((widgetId) => {
    if (!mirror(widgetId)) return;
    const prim = layout.widgets[widgetId];
    if (!prim || !prim.visible || prim.page !== removedPageId || inAnyGroup(widgetId)) return;
    const idx = layout.copies.findIndex((c) =>
      c && c.widget === widgetId && c.page !== removedPageId && !inAnyGroup(c.id));
    if (idx < 0) return;
    const copy = layout.copies[idx];
    // The live primary takes the surviving copy's page + geometry; visible stays.
    prim.page = copy.page;
    prim.x = copy.x; prim.y = copy.y; prim.w = copy.w; prim.h = copy.h;
    layout.copies.splice(idx, 1);
  });
  return layout;
}

// Return a new list with page `id` moved by dir (-1 up / +1 down), clamped.
function movePageInList(pages, id, dir) {
  const list = (pages || []).slice();
  const i = list.findIndex(p => p.id === id);
  if (i < 0) return list;
  const j = i + (dir < 0 ? -1 : 1);
  if (j < 0 || j >= list.length) return list;
  const tmp = list[i]; list[i] = list[j]; list[j] = tmp;
  return list;
}

// Pure: remove every instance tile bound to `pageId` — each tab-group on the page
// plus every copy on the page (or that was a member of one of those groups). A
// group's copy member can carry its own page field, so removing by membership as
// well as by page is more reliable than the page filter alone. Mutates `layout`
// and returns the removed copy records so the caller can release per-instance side
// state (e.g. a deck copy's stored config). Standalone primary widgets are left
// untouched — the caller hides those (they stay restorable from the layout dock).
// A dropped group's PRIMARY members however are hidden HERE (geometry reset to
// `widgetDefaults` when provided): a grouped primary's own page field goes stale
// the moment it joins a group, so the caller's "hide what lives on this page"
// loop can't see it — left alone it would pop up visible on its stale page and
// crash into that page's layout (the "deleted a page and a widget appeared on
// another one, shuffling everything" bug).
function removePageInstances(layout, pageId, widgetDefaults) {
  if (!layout || typeof layout !== 'object') return [];
  const widgets = layout.widgets || {};
  const orphanCopyIds = new Set();
  if (layout.groups) {
    Object.keys(layout.groups).forEach(gid => {
      const g = layout.groups[gid];
      if (!g || g.page !== pageId) return;
      (g.members || []).forEach(m => {
        if (!widgets[m]) { orphanCopyIds.add(m); return; }
        widgets[m].visible = false;
        widgets[m].page = pageId;   // truthful again → orphan reassignment re-homes it
        const def = widgetDefaults && widgetDefaults[m];
        if (def) { widgets[m].x = def.x; widgets[m].y = def.y; widgets[m].w = def.w; widgets[m].h = def.h; }
      });
      delete layout.groups[gid];
    });
  }
  if (!Array.isArray(layout.copies)) return [];
  const drop = (c) => c && (c.page === pageId || orphanCopyIds.has(c.id));
  const removed = layout.copies.filter(drop);
  layout.copies = layout.copies.filter(c => !drop(c));
  return removed;
}

if (typeof window !== 'undefined') {
  window.DashboardPages = {
    init: initDashboardPages,
    rebuild: rebuildDashboardPages,
    pageDisplayName,
    list: () => dashboardPagesList().map(page => ({ id: page.id, label: pageDisplayName(page) })),
    add: addDashboardPage,
    rename: renameDashboardPage,
    storedName: storedPageName,
    relabel: relabelDashboardPages,
    remove: removeDashboardPage,
    move: moveDashboardPage,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DASHBOARD_PAGES_MAX, clampPageName, resolveRenamedPageName, normalizePagesList, reassignOrphanWidgetPages, movePageInList, promoteSurvivingPrimaries, removePageInstances };
}
