'use strict';

// Pure helpers (exported for unit tests; no DOM access).
function nextAppendOrder(widgets, page) {
  let max = -1;
  Object.keys(widgets || {}).forEach(id => {
    const w = widgets[id];
    if (w && w.page === page && Number.isFinite(w.order)) max = Math.max(max, w.order);
  });
  return max + 1;
}
function otherPage(current, pageIds) {
  const list = Array.isArray(pageIds) ? pageIds : [];
  const i = list.indexOf(current);
  if (i < 0 || list.length < 2) return current;
  return list[(i + 1) % list.length];
}

if (typeof window !== 'undefined') {
  window.saveTilePreset = saveTilePreset;
}

if (typeof window !== 'undefined') {
  // After the browser has laid the newly-shown page out, not during the event.
  // On WINDOW: dashboard-pager.js dispatches xenon:page-change there, and an
  // event dispatched on window never reaches document, so the same line written
  // against document would have listened forever and heard nothing.
  const onPageShown = () => requestAnimationFrame(remeasureTileShapes);
  window.addEventListener('xenon:page-change', onPageShown);
  window.addEventListener('resize', onPageShown);
}

if (typeof window !== 'undefined') {
  // custom-widget.js repaints tile styles when a package's declared silhouette
  // changes (assignment, install, uninstall) — applyTileStyle stays the single
  // owner of the shape DOM.
  window.applyAllTileStyles = applyAllTileStyles;
  window.tileShapeInfoOf = tileShapeInfoOf;
}

// A screen turned to vertical (or back) keeps its tiles and swaps their
// geometry: js/phone-view.js says when, js/dashboard-portrait.js says where.
if (typeof window !== 'undefined') {
  window.addEventListener('xenon:portrait-change', () => {
    if (hubSettings) applyDashboardLayout();
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { nextAppendOrder, otherPage };
}
