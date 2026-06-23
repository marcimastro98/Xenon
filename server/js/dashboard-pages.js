'use strict';
// User-defined dashboard pages: owns the page list lifecycle, generates the
// pager-page sections dynamically, and drives the pager + layout. Pure helpers
// (top) are unit-tested; the runtime/DOM parts (below) need the browser.

const DASHBOARD_PAGES_MAX = 8;

function clampPageName(name, fallback) {
  const s = String(name == null ? '' : name).trim().slice(0, 40);
  return s || fallback || '';
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

// ── Runtime (browser) ─────────────────────────────────────────────
function pageDisplayName(page) {
  return (page.name && page.name.trim())
    || (page.nameKey && typeof t === 'function' ? t(page.nameKey) : '')
    || page.id;
}

function dashboardPagesList() {
  return getDashboardLayout().pages; // getDashboardLayout() normalises + clones
}

// Park every widget tile in a hidden pool so the pager can be rebuilt safely.
function ensureWidgetPool() {
  let pool = document.getElementById('widget-pool');
  if (!pool) {
    pool = document.createElement('div');
    pool.id = 'widget-pool';
    pool.hidden = true;
    document.body.appendChild(pool);
  }
  document.querySelectorAll('[data-dashboard-widget]').forEach(tile => {
    // Ensure GridStack wrapper: .grid-stack-item > .grid-stack-item-content > tile
    let item = tile.closest('.grid-stack-item');
    if (!item) {
      item = document.createElement('div');
      item.className = 'grid-stack-item';
      item.setAttribute('gs-id', tile.getAttribute('data-dashboard-widget'));
      const content = document.createElement('div');
      content.className = 'grid-stack-item-content';
      tile.parentElement.insertBefore(item, tile);
      content.appendChild(tile);
      item.appendChild(content);
    }
    if (item.parentElement !== pool) pool.appendChild(item);
  });
  return pool;
}

// (Re)build one pager section + grid per page. Returns pager descriptors.
function renderPagerSections(pages) {
  const viewport = document.getElementById('dashboard-pager');
  if (!viewport) return [];
  ensureWidgetPool();          // detach tiles before clearing old sections
  viewport.replaceChildren();
  const descriptors = [];
  pages.forEach(page => {
    const section = document.createElement('section');
    section.className = 'pager-page';
    section.id = 'page-' + page.id;
    section.dataset.page = page.id;
    section.setAttribute('aria-label', pageDisplayName(page));
    const grid = document.createElement('main');
    grid.className = 'dashboard grid-stack';
    grid.dataset.pageGrid = page.id;
    section.appendChild(grid);
    // "+" quick-add affordance (shown only in Layout mode via CSS).
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'page-add-widget';
    add.setAttribute('aria-label', '+');
    add.textContent = '+';
    add.addEventListener('click', () => { if (window.DashboardPalette) window.DashboardPalette.open(page.id, add); });
    section.appendChild(add);
    viewport.appendChild(section);
    descriptors.push({ id: page.id, label: pageDisplayName(page), element: section });
  });
  return descriptors;
}

function rebuildDashboardPages() {
  const descriptors = renderPagerSections(dashboardPagesList());
  if (window.DashboardPager && typeof window.DashboardPager.setPages === 'function') {
    window.DashboardPager.setPages(descriptors);
  }
  // Mount a GridStack on each freshly-built page grid.
  if (window.DashboardGrid) {
    document.querySelectorAll('[data-page-grid]').forEach(el => {
      window.DashboardGrid.mountPageGrid(el.dataset.pageGrid, el);
    });
  }
  if (typeof applyDashboardLayout === 'function') applyDashboardLayout();
}

function initDashboardPages() {
  rebuildDashboardPages();
}

function addDashboardPage() {
  const layout = getDashboardLayout();
  if (layout.pages.length >= DASHBOARD_PAGES_MAX) return;
  const id = 'page-' + Date.now().toString(36);
  const label = (typeof t === 'function' ? t('page_default') : 'Page') + ' ' + (layout.pages.length + 1);
  layout.pages.push({ id, name: label });
  saveDashboardLayout(layout);
  rebuildDashboardPages();
  if (typeof refreshDashboardLayoutEditor === 'function') refreshDashboardLayoutEditor();
}

function renameDashboardPage(id, name) {
  const layout = getDashboardLayout();
  const page = layout.pages.find(p => p.id === id);
  if (!page) return;
  page.name = clampPageName(name, '');
  delete page.nameKey;          // a user-set name overrides the seed key
  saveDashboardLayout(layout);
  rebuildDashboardPages();
}

// Pure: remove every instance tile bound to `pageId` — each tab-group on the page
// plus every copy on the page (or that was a member of one of those groups). A
// group's copy member can carry its own page field, so removing by membership as
// well as by page is more reliable than the page filter alone. Mutates `layout`
// and returns the removed copy records so the caller can release per-instance side
// state (e.g. a deck copy's stored config). Primary widgets are left untouched —
// the caller hides those (they stay restorable from the layout dock).
function removePageInstances(layout, pageId) {
  if (!layout || typeof layout !== 'object') return [];
  const widgets = layout.widgets || {};
  const orphanCopyIds = new Set();
  if (layout.groups) {
    Object.keys(layout.groups).forEach(gid => {
      const g = layout.groups[gid];
      if (!g || g.page !== pageId) return;
      (g.members || []).forEach(m => { if (!widgets[m]) orphanCopyIds.add(m); });
      delete layout.groups[gid];
    });
  }
  if (!Array.isArray(layout.copies)) return [];
  const drop = (c) => c && (c.page === pageId || orphanCopyIds.has(c.id));
  const removed = layout.copies.filter(drop);
  layout.copies = layout.copies.filter(c => !drop(c));
  return removed;
}

function removeDashboardPage(id) {
  const layout = getDashboardLayout();
  if (layout.pages.length <= 1) return; // never below 1 page
  if (!layout.pages.some(p => p.id === id)) return;
  const hasModules = DASHBOARD_WIDGET_IDS.some(w => layout.widgets[w].visible && layout.widgets[w].page === id);
  const msg = (typeof t === 'function') ? t('layout_remove_page_confirm')
    : 'Removing this page will remove its modules (you can restore them from the layout dock). Continue?';
  if (hasModules && typeof confirm === 'function' && !confirm(msg)) return;
  // Rescue any live singleton-host primary (e.g. System, which owns the live
  // Volume/Microphone panes) onto a surviving page if a copy of it lives there —
  // before the hide loop below would otherwise park the primary and leave that
  // page with a dead clone.
  promoteSurvivingPrimaries(layout, id);
  DASHBOARD_WIDGET_IDS.forEach(w => { if (layout.widgets[w].page === id) layout.widgets[w].visible = false; });
  // Strip the page's instance tiles — tab-groups and copies (neither is restorable
  // from the dock). Without this an orphaned group/copy is silently relocated to
  // the first surviving page on save, leaving the duplicated tile behind (the
  // "I deleted the page but its widgets are still there" leftover).
  const removedCopies = removePageInstances(layout, id);
  if (window.Deck && typeof window.Deck.forgetInstance === 'function') {
    removedCopies.forEach(c => { if (c.widget === 'deck') window.Deck.forgetInstance(c.id); });
  }
  layout.pages = layout.pages.filter(p => p.id !== id);
  reassignOrphanWidgetPages(layout.widgets, layout.pages.map(p => p.id), layout.pages[0].id);
  saveDashboardLayout(layout);
  rebuildDashboardPages();
  if (typeof refreshDashboardLayoutEditor === 'function') refreshDashboardLayoutEditor();
}

function moveDashboardPage(id, dir) {
  const layout = getDashboardLayout();
  layout.pages = movePageInList(layout.pages, id, dir);
  saveDashboardLayout(layout);
  rebuildDashboardPages();
  if (typeof refreshDashboardLayoutEditor === 'function') refreshDashboardLayoutEditor();
}

if (typeof window !== 'undefined') {
  window.DashboardPages = {
    init: initDashboardPages,
    rebuild: rebuildDashboardPages,
    pageDisplayName,
    add: addDashboardPage,
    rename: renameDashboardPage,
    remove: removeDashboardPage,
    move: moveDashboardPage,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DASHBOARD_PAGES_MAX, clampPageName, normalizePagesList, reassignOrphanWidgetPages, movePageInList, promoteSurvivingPrimaries, removePageInstances };
}
