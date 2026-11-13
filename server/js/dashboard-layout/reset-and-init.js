// Resetting the layout, and starting it when the page loads.
'use strict';

// Reset is scoped to the page the user is looking at — the old full-layout
// wipe also deleted every user-created page, which is real data loss.
// • Stock page → restore its default modules/geometry (other pages untouched).
// • User-created page → keep the page and its modules, re-pack them tidily.
// • Single stock page (no custom pages) → classic full reset, tabs included.
function resetDashboardLayout() {
  const layout = getDashboardLayout();
  const pageIds = layout.pages.map(p => p.id);
  const pager = window.DashboardPager;
  const focused = (pager && typeof pager.getCurrentPage === 'function') ? pager.getCurrentPage() : null;
  const pageId = pageIds.includes(focused) ? focused : pageIds[0];
  const defaultPageId = DEFAULT_DASHBOARD_LAYOUT.pages[0].id;

  // On a vertical screen the reset is about the vertical arrangement of this
  // page: it goes back to the generated one, and the landscape layout (the one
  // the person is not looking at) is left exactly as it is.
  if (window.DashboardPortrait && window.DashboardPortrait.isActive()) {
    window.DashboardPortrait.resetPortrait(layout, pageId);
    saveDashboardLayout(layout);
    applyDashboardLayout();
    return;
  }

  if (pageId === defaultPageId && layout.pages.length <= 1) {
    saveDashboardLayout(normalizeDashboardLayout(null));
  } else if (pageId === defaultPageId) {
    // Drop copies and tab-groups living on this page, then restore the stock
    // geometry/visibility for the widgets currently here. Widgets the user
    // moved to other pages are deliberately left where they are.
    layout.copies = (Array.isArray(layout.copies) ? layout.copies : []).filter(c => c.page !== pageId);
    Object.keys(layout.groups || {}).forEach(gid => {
      if (layout.groups[gid] && layout.groups[gid].page === pageId) delete layout.groups[gid];
    });
    DASHBOARD_WIDGET_IDS.forEach(id => {
      if (layout.widgets[id] && layout.widgets[id].page === pageId) {
        layout.widgets[id] = Object.assign({}, DEFAULT_DASHBOARD_LAYOUT.widgets[id]);
      }
    });
    // Re-seed the default groups (e.g. the media/chat tab-group), but only
    // with members that actually live on this page right now.
    Object.keys(DEFAULT_DASHBOARD_LAYOUT.groups).forEach(gid => {
      const g = DEFAULT_DASHBOARD_LAYOUT.groups[gid];
      if (g.page !== pageId) return;
      const members = g.members.filter(m => layout.widgets[m] && layout.widgets[m].page === pageId);
      if (members.length >= 2) layout.groups[gid] = Object.assign({}, g, { members });
    });
    saveDashboardLayout(layout);
  } else {
    // Custom page: never delete it from a reset — just tidy its modules.
    if (window.DashboardGrid && typeof window.DashboardGrid.packPageItems === 'function') {
      window.DashboardGrid.packPageItems(layout, pageId);
    }
    saveDashboardLayout(layout);
  }
  // The page list may have changed — the pager sections must be regenerated,
  // or modules whose page no longer has a grid fall back to page 1.
  if (window.DashboardPages && typeof window.DashboardPages.rebuild === 'function') window.DashboardPages.rebuild();
  else applyDashboardLayout();
  if (pager && typeof pager.goToPage === 'function') pager.goToPage(pageId);
}

function initDashboardLayout() {
  applyDashboardLayout();
}
