// Builds the pager of the dashboard's pages, and adding, naming, removing and moving a page.
'use strict';

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
    if (item.parentElement !== pool) moveNode(pool, item);   // keeps a playing iframe alive
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
  // Mount a GridStack on each freshly-built page grid, and drop the instances
  // of pages that no longer exist (a removed page's grid otherwise lingers in
  // the registry forever and keeps being read by serialize/fit passes).
  if (window.DashboardGrid) {
    if (typeof window.DashboardGrid.pruneGrids === 'function') {
      window.DashboardGrid.pruneGrids(descriptors.map(d => d.id));
    }
    document.querySelectorAll('[data-page-grid]').forEach(el => {
      window.DashboardGrid.mountPageGrid(el.dataset.pageGrid, el);
    });
  }
  if (typeof applyDashboardLayout === 'function') applyDashboardLayout();
}

function initDashboardPages() {
  rebuildDashboardPages();
}

// Returns the new page's id, or null when the page limit is reached.
function addDashboardPage() {
  const layout = getDashboardLayout();
  if (layout.pages.length >= DASHBOARD_PAGES_MAX) return null;
  const id = 'page-' + Date.now().toString(36);
  layout.pages.push({ id, name: defaultPageName(layout.pages.length) });
  saveDashboardLayout(layout);
  rebuildDashboardPages();
  if (typeof refreshDashboardLayoutEditor === 'function') refreshDashboardLayoutEditor();
  // A page is added to be filled: land on it, instead of leaving the view
  // wherever the rebuild happened to put it.
  if (window.DashboardPager && typeof window.DashboardPager.goToPage === 'function') window.DashboardPager.goToPage(id);
  return id;
}

// The name a rename dialog should start from: what the user actually typed,
// never the resolved display name. Pre-filling with a name derived from
// `nameKey` and confirming it unchanged would freeze the translation into a
// literal string, and the page would stop following the interface language.
function storedPageName(id) {
  const page = dashboardPagesList().find(p => p.id === id);
  return page ? (page.name || '') : '';
}

// Name a page created — or cleared — at `index`, matching what the + button
// produces so an emptied field lands back on the same default.
function defaultPageName(index) {
  return (typeof t === 'function' ? t('page_default') : 'Page') + ' ' + (index + 1);
}

function renameDashboardPage(id, name) {
  const layout = getDashboardLayout();
  const index = layout.pages.findIndex(p => p.id === id);
  if (index < 0) return;
  const page = layout.pages[index];
  // The seed key is KEPT rather than deleted (see resolveRenamedPageName).
  page.name = resolveRenamedPageName(name, !!page.nameKey, defaultPageName(index));
  saveDashboardLayout(layout);
  rebuildDashboardPages();
}

function removeDashboardPage(id, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const layout = getDashboardLayout();
  const target = layout.pages.find(p => p.id === id);
  if (!target) return false;
  // The import manager supplies the receipt id so a stale receipt can never
  // remove a page that the user later replaced with an unrelated one.
  if (opts.installId && target.installId !== opts.installId) return false;
  if (opts.legacy === true && !(target.imported === true && !target.installId)) return false;
  // Xenon must always retain one page. During uninstall, seed a blank survivor
  // before removing the last imported page.
  if (layout.pages.length <= 1) {
    if (opts.replaceLast !== true) return false;
    layout.pages.push({
      id: 'page-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4),
      name: (typeof t === 'function' ? t('page_default') : 'Page') + ' 1',
    });
  }
  // Count EVERY kind of tile on the page — standalone widgets, tab-groups and
  // copies — so the "this removes its modules" confirm can't be skipped for a
  // page that only holds tabbed/duplicated tiles.
  const hasModules = DASHBOARD_WIDGET_IDS.some(w => layout.widgets[w].visible && layout.widgets[w].page === id)
    || Object.keys(layout.groups || {}).some(gid => layout.groups[gid] && layout.groups[gid].page === id)
    || (Array.isArray(layout.copies) && layout.copies.some(c => c && c.page === id));
  const msg = (typeof t === 'function') ? t('layout_remove_page_confirm')
    : 'Removing this page will remove its modules (you can restore them from the layout dock). Continue?';
  if (!opts.skipConfirm && hasModules && typeof confirm === 'function' && !confirm(msg)) return false;
  // Rescue any live singleton-host primary (e.g. System, which owns the live
  // Volume/Microphone panes) onto a surviving page if a copy of it lives there —
  // before the hide loop below would otherwise park the primary and leave that
  // page with a dead clone.
  promoteSurvivingPrimaries(layout, id);
  // Removing a page removes its widgets. For a singleton primary that means
  // hide it (one of each always exists; "hidden" is how "removed" is stored) AND
  // reset its geometry to the default — otherwise it keeps the size/position it
  // had on the now-deleted page, i.e. saved state for something that no longer
  // exists. The clean default also gives it a sane slot if re-added later.
  const widgetDefaults = (typeof DEFAULT_DASHBOARD_LAYOUT !== 'undefined') ? DEFAULT_DASHBOARD_LAYOUT.widgets : null;
  DASHBOARD_WIDGET_IDS.forEach(w => {
    if (layout.widgets[w].page !== id) return;
    layout.widgets[w].visible = false;
    const def = widgetDefaults && widgetDefaults[w];
    if (def) { layout.widgets[w].x = def.x; layout.widgets[w].y = def.y; layout.widgets[w].w = def.w; layout.widgets[w].h = def.h; }
  });
  // Strip the page's instance tiles — tab-groups and copies (neither is restorable
  // from the dock). Without this an orphaned group/copy is silently relocated to
  // the first surviving page on save, leaving the duplicated tile behind (the
  // "I deleted the page but its widgets are still there" leftover). Passing the
  // defaults also resets the geometry of the dropped groups' primary members.
  const removedCopies = removePageInstances(layout, id, widgetDefaults);
  if (window.Deck && typeof window.Deck.forgetInstance === 'function') {
    removedCopies.forEach(c => { if (c.widget === 'deck') window.Deck.forgetInstance(c.id); });
  }
  layout.pages = layout.pages.filter(p => p.id !== id);
  reassignOrphanWidgetPages(layout.widgets, layout.pages.map(p => p.id), layout.pages[0].id);
  saveDashboardLayout(layout);
  rebuildDashboardPages();
  if (typeof refreshDashboardLayoutEditor === 'function') refreshDashboardLayoutEditor();
  if (opts.skipReceipt !== true && window.forgetInstalledContentResource) window.forgetInstalledContentResource('pageIds', id);
  return true;
}

// Push the current display names into the pager after a language change. A page
// named by a seed key resolves through t(), and the pager captured that string
// when the page was registered — cheap to refresh, and far cheaper than
// rebuilding every page grid just to re-read a label.
function relabelDashboardPages() {
  if (!window.DashboardPager || typeof window.DashboardPager.setLabel !== 'function') return;
  let changed = false;
  dashboardPagesList().forEach(page => {
    if (window.DashboardPager.setLabel(page.id, pageDisplayName(page))) changed = true;
  });
  if (changed && typeof window.DashboardPager.renderDots === 'function') window.DashboardPager.renderDots();
}

function moveDashboardPage(id, dir) {
  const layout = getDashboardLayout();
  layout.pages = movePageInList(layout.pages, id, dir);
  saveDashboardLayout(layout);
  rebuildDashboardPages();
  if (typeof refreshDashboardLayoutEditor === 'function') refreshDashboardLayoutEditor();
}
