// Converts a layout saved on the old 12-column grid to the units of the 24-column grid.

const { DASHBOARD_GRID_COLUMNS } = require('./layout-defaults.js');

// One-time unit migration: layouts saved before the 24-column grid carry no
// gridCols flag and are in 12-column units — double every geometry (widgets,
// groups, copies) so each tile keeps its exact position and size on the finer
// grid. Idempotent: the flag is stamped on the normalized output, and until the
// layout is re-saved the scaling always re-derives from the raw 12-unit source.
// Mirrors the client normalizer (js/settings.js) — keep both in sync. If the
// grid resolution ever changes again, branch on the STORED gridCols value
// (absent = 12-column) and derive the factor per source unit — never reuse
// this blanket ×2.
function scaleDashboardLayoutUnits(source) {
  if (Number(source.gridCols) === DASHBOARD_GRID_COLUMNS) return source;
  const scaleBox = (o) => {
    if (!o || typeof o !== 'object') return o;
    const out = Object.assign({}, o);
    ['x', 'y', 'w', 'h'].forEach(k => {
      const n = Number(out[k]);
      if (Number.isFinite(n)) out[k] = Math.round(n * 2);
    });
    return out;
  };
  const out = Object.assign({}, source);
  if (source.widgets && typeof source.widgets === 'object') {
    out.widgets = {};
    Object.keys(source.widgets).forEach(id => { out.widgets[id] = scaleBox(source.widgets[id]); });
  }
  if (source.groups && typeof source.groups === 'object') {
    out.groups = {};
    Object.keys(source.groups).forEach(id => { out.groups[id] = scaleBox(source.groups[id]); });
  }
  if (Array.isArray(source.copies)) out.copies = source.copies.map(scaleBox);
  return out;
}

module.exports = { scaleDashboardLayoutUnits };
